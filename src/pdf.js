// Moteur PDF : assembler, découper, compresser, créer depuis des images.
// Le rendu des pages (miniatures, export en images) se fait dans l'interface avec pdf.js.
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const os = require('os');
const { execFile } = require('child_process');
const {
  PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict, PDFHexString, PDFString, degrees, rgb,
  StandardFonts, BlendMode, LineCapStyle,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList,
} = require('pdf-lib');

// Utilitaire PDFKit (chiffrement), construit par « npm run build:native »
let helperPath = path.join(__dirname, '..', 'build', 'native', 'mue-pdfkit');
const setHelperPath = (p) => { helperPath = p; };
function helper(...args) {
  return new Promise((resolve, reject) => {
    execFile(helperPath, args, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || '').trim() || 'Opération impossible sur ce PDF'));
      else resolve(stdout.trim());
    });
  });
}

// Ouvre un PDF protégé : renvoie le chemin d'une copie déverrouillée (fichier temporaire)
async function unlock(file, password) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mue-pdf-'));
  const out = path.join(dir, path.basename(file));
  await helper('decrypt', file, out, password);
  return out;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${name}-${i}${ext}`);
    if (!(await exists(c))) return c;
  }
}

async function load(file) {
  const bytes = await fsp.readFile(file);
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('Ce PDF est protégé par un mot de passe');
    throw new Error('Ce fichier PDF est illisible ou abîmé');
  }
  return { doc, bytes };
}

async function info(file) {
  const { doc, bytes } = await load(file);
  return { pages: doc.getPageCount(), size: bytes.length, title: doc.getTitle() || null };
}

function outputDir(file, output) {
  if (output && output.mode === 'custom' && output.dir) return output.dir;
  // Un PDF protégé est ouvert depuis une copie temporaire : on enregistre à côté de l'original
  const origin = (output && output.origins && output.origins[file]) || file;
  return path.join(path.dirname(origin), 'converti');
}

/**
 * Assemble des pages venant d'un ou plusieurs PDF, dans l'ordre donné.
 * pages: [{ file, index (0..n-1), rotate (multiple de 90) }]
 */
async function assemble(pages, outFile) {
  const out = await PDFDocument.create();
  const docs = new Map();
  for (const p of pages) {
    if (!docs.has(p.file)) docs.set(p.file, (await load(p.file)).doc);
    const [page] = await out.copyPages(docs.get(p.file), [p.index]);
    if (p.rotate) page.setRotation(degrees((page.getRotation().angle + p.rotate + 360) % 360));
    out.addPage(page);
  }
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const target = await uniquePath(outFile);
  const bytes = await out.save({ useObjectStreams: true });
  await fsp.writeFile(target, bytes);
  return { output: target, pages: pages.length, size: bytes.length };
}

// « 1-3, 5, 8-10 » → [[0,1,2],[4],[7,8,9]] (pages comptées à partir de 1 pour l'utilisateur)
function parseRanges(text, count) {
  const groups = [];
  for (const part of String(text).split(/[,;]+/)) {
    const m = part.trim().match(/^(\d+)\s*(?:[-–à]\s*(\d+|fin))?$/i);
    if (!m) { if (part.trim()) throw new Error(`Plage incomprise : « ${part.trim()} »`); continue; }
    const a = +m[1];
    const b = m[2] ? (/fin/i.test(m[2]) ? count : +m[2]) : a;
    if (a < 1 || b > count || a > b) throw new Error(`Plage hors du document : « ${part.trim()} » (${count} pages)`);
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  if (!groups.length) throw new Error('Indique au moins une plage de pages');
  return groups;
}

/**
 * Découpe un PDF en plusieurs fichiers.
 * mode: 'each' (une page par fichier), 'every' (toutes les n pages), 'ranges' (plages)
 */
async function split(file, { mode = 'each', every = 1, ranges = '', output } = {}) {
  const { doc } = await load(file);
  const count = doc.getPageCount();
  let groups;
  if (mode === 'ranges') groups = parseRanges(ranges, count);
  else {
    const n = mode === 'every' ? Math.max(1, Math.floor(every) || 1) : 1;
    groups = [];
    for (let i = 0; i < count; i += n) groups.push(Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k));
  }
  const dir = outputDir(file, output);
  await fsp.mkdir(dir, { recursive: true });
  const base = path.parse(file).name;
  const outputs = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, g);
    copied.forEach((p) => out.addPage(p));
    const label = g.length === 1 ? `p${g[0] + 1}` : `p${g[0] + 1}-${g[g.length - 1] + 1}`;
    const target = await uniquePath(path.join(dir, `${base}-${label}.pdf`));
    await fsp.writeFile(target, await out.save({ useObjectStreams: true }));
    outputs.push(target);
  }
  return { input: file, outputs, files: outputs.length };
}

/* ---------- Compression ---------- */

const LEVELS = {
  light: { quality: 85, maxSide: 3000 },
  medium: { quality: 72, maxSide: 2000 },
  strong: { quality: 55, maxSide: 1300 },
};

const nameOf = (v) => (v instanceof PDFName ? v.asString().replace(/^\//, '') : null);
const num = (v) => (v instanceof PDFNumber ? v.asNumber() : null);

// Nombre de composantes d'un espace colorimétrique que l'on sait réencoder, sinon null
function components(cs, context) {
  if (!cs) return null;
  const n = nameOf(cs);
  if (n === 'DeviceRGB') return 3;
  if (n === 'DeviceGray') return 1;
  if (cs instanceof PDFArray && nameOf(cs.get(0)) === 'ICCBased') {
    const stream = context.lookup(cs.get(1));
    const N = stream && stream.dict ? num(stream.dict.get(PDFName.of('N'))) : null;
    return N === 3 || N === 1 ? N : null;
  }
  return null;
}

// Réencode les images d'un PDF en JPEG plus léger. Le texte et les dessins vectoriels ne bougent pas.
async function compress(file, { level = 'medium', output } = {}) {
  const { doc, bytes } = await load(file);
  const { quality, maxSide } = LEVELS[level] || LEVELS.medium;
  const ctx = doc.context;
  let images = 0, changed = 0;

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (nameOf(d.get(PDFName.of('Subtype'))) !== 'Image') continue;
    images++;
    if (d.get(PDFName.of('ImageMask')) || d.get(PDFName.of('Decode')) || d.get(PDFName.of('Mask'))) continue;
    if (num(d.get(PDFName.of('BitsPerComponent'))) !== 8) continue;
    const w = num(d.get(PDFName.of('Width'))), h = num(d.get(PDFName.of('Height')));
    const ch = components(ctx.lookup(d.get(PDFName.of('ColorSpace'))) || d.get(PDFName.of('ColorSpace')), ctx);
    if (!w || !h || !ch) continue;

    let filter = d.get(PDFName.of('Filter'));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.get(0) : null;
    const f = nameOf(filter);
    const parms = d.get(PDFName.of('DecodeParms'));

    let input;
    try {
      if (f === 'DCTDecode') {
        input = sharp(Buffer.from(obj.contents));
      } else if (f === 'FlateDecode') {
        if (parms instanceof PDFDict && (num(parms.get(PDFName.of('Predictor'))) || 1) > 1) continue;
        const raw = zlib.inflateSync(Buffer.from(obj.contents));
        if (raw.length < w * h * ch) continue;
        input = sharp(raw.subarray(0, w * h * ch), { raw: { width: w, height: h, channels: ch } });
      } else continue;

      if (Math.max(w, h) > maxSide) input = input.resize(maxSide, maxSide, { fit: 'inside' });
      if (ch === 1) input = input.greyscale();
      const { data, info } = await input.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      if (data.length >= obj.contents.length * 0.95) continue; // pas assez de gain : on garde l'original

      const dict = {
        Type: 'XObject', Subtype: 'Image', Width: info.width, Height: info.height,
        ColorSpace: ch === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
      };
      const stream = ctx.stream(data, dict);
      const smask = d.get(PDFName.of('SMask'));
      if (smask) stream.dict.set(PDFName.of('SMask'), smask);
      ctx.assign(ref, stream);
      changed++;
    } catch {
      // Image dans un format inattendu : on la laisse telle quelle
    }
  }

  const out = Buffer.from(await doc.save({ useObjectStreams: true }));
  const dir = outputDir(file, output);
  await fsp.mkdir(dir, { recursive: true });
  const target = await uniquePath(path.join(dir, `${path.parse(file).name}-compresse.pdf`));
  // Si le résultat n'est pas plus léger, on enregistre une copie de l'original
  const best = out.length < bytes.length ? out : bytes;
  await fsp.writeFile(target, best);
  return { input: file, output: target, inSize: bytes.length, outSize: best.length, images, changed };
}

/* ---------- Images → PDF ---------- */

const A4 = [595.28, 841.89];

/**
 * Crée un PDF avec une image par page.
 * pageSize: 'image' (page à la taille de l'image, 72 ppp... ramenée à 150 ppp) ou 'a4' (image centrée avec marge)
 */
async function imagesToPdf(files, outFile, { pageSize = 'a4', margin = 24, quality = 88, readable } = {}) {
  const out = await PDFDocument.create();
  for (const file of files) {
    const { src, cleanup } = readable ? await readable(file) : { src: file, cleanup: async () => {} };
    try {
      const img = sharp(src, { limitInputPixels: false }).rotate();
      const meta = await img.metadata();
      const png = meta.hasAlpha || meta.format === 'png';
      const buf = png ? await img.png().toBuffer() : await img.jpeg({ quality }).toBuffer();
      const embedded = png ? await out.embedPng(buf) : await out.embedJpg(buf);
      const { width: iw, height: ih } = embedded;
      if (pageSize === 'image') {
        const s = 72 / 150; // 150 ppp
        const page = out.addPage([iw * s, ih * s]);
        page.drawImage(embedded, { x: 0, y: 0, width: iw * s, height: ih * s });
      } else {
        const [pw, ph] = iw > ih ? [A4[1], A4[0]] : A4;
        const k = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin) / ih, 1);
        const page = out.addPage([pw, ph]);
        page.drawImage(embedded, { x: (pw - iw * k) / 2, y: (ph - ih * k) / 2, width: iw * k, height: ih * k });
      }
    } finally {
      await cleanup();
    }
  }
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const target = await uniquePath(outFile);
  const bytes = await out.save({ useObjectStreams: true });
  await fsp.writeFile(target, bytes);
  return { output: target, pages: files.length, size: bytes.length };
}

/* ---------- Formulaires ---------- */

async function formFields(file) {
  const { doc } = await load(file);
  let form;
  try { form = doc.getForm(); } catch { return []; }
  const pages = doc.getPages();
  const pageOf = (ref) => pages.findIndex((p) => p.ref === ref);
  const out = [];
  for (const f of form.getFields()) {
    const widgets = f.acroField.getWidgets();
    const w = widgets[0];
    const field = { name: f.getName(), readOnly: f.isReadOnly() };
    if (w) {
      const r = w.getRectangle();
      field.rect = [r.x, r.y, r.x + r.width, r.y + r.height];
      const pRef = w.P();
      field.page = pRef ? pageOf(pRef) : pages.findIndex((p) => (p.node.Annots()?.asArray() || []).some((a) => a === w.dict || doc.context.lookup(a) === w.dict));
    }
    if (f instanceof PDFTextField) Object.assign(field, { type: 'text', value: f.getText() || '', multiline: f.isMultiline() });
    else if (f instanceof PDFCheckBox) Object.assign(field, { type: 'checkbox', value: f.isChecked() });
    else if (f instanceof PDFDropdown) Object.assign(field, { type: 'choice', value: f.getSelected()[0] || '', options: f.getOptions() });
    else if (f instanceof PDFOptionList) Object.assign(field, { type: 'choice', value: f.getSelected()[0] || '', options: f.getOptions() });
    else if (f instanceof PDFRadioGroup) Object.assign(field, { type: 'radio', value: f.getSelected() || '', options: f.getOptions() });
    else continue; // boutons et champs de signature : non pris en charge
    out.push(field);
  }
  return out;
}

/* ---------- Annoter, remplir, signer, protéger ---------- */

const hex = (h) => {
  const n = parseInt(String(h || '#000').replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
// Helvetica ne connaît que l'alphabet latin : on remplace le reste plutôt que d'échouer
const latin = (font, text) => [...String(text)].map((c) => {
  try { font.encodeText(c); return c; } catch { return c === '\n' ? c : '?'; }
}).join('');

/**
 * Enregistre une copie du PDF avec annotations, champs remplis et éventuel mot de passe.
 * annotations: { [indexPage]: [{ type: 'highlight'|'text'|'note'|'ink'|'image', ... }] } en points PDF
 * fields: { [nom]: valeur }
 */
async function saveEdited(file, { annotations = {}, fields = {}, flatten = false, password = '', suffix = '-annote', output } = {}) {
  const { doc } = await load(file);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const images = new Map();

  for (const [key, list] of Object.entries(annotations)) {
    const page = pages[+key];
    if (!page) continue;
    const rot = page.getRotation().angle || 0;
    for (const a of list) {
      if (a.type === 'highlight') {
        const [x1, y1, x2, y2] = a.rect;
        page.drawRectangle({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), color: hex(a.color), opacity: 0.38, blendMode: BlendMode.Multiply });
      } else if (a.type === 'ink') {
        for (const stroke of a.strokes) {
          for (let i = 1; i < stroke.length; i++) {
            page.drawLine({ start: { x: stroke[i - 1][0], y: stroke[i - 1][1] }, end: { x: stroke[i][0], y: stroke[i][1] }, thickness: a.width, color: hex(a.color), lineCap: LineCapStyle.Round });
          }
        }
      } else if (a.type === 'text') {
        const lines = latin(font, a.text).split('\n');
        const size = a.size || 14;
        // a.x, a.y : coin haut gauche du bloc, dans le sens de lecture de la page affichée
        const r = (rot * Math.PI) / 180;
        lines.forEach((line, i) => {
          const d = size * (0.85 + i * 1.2); // descente vers la ligne de base
          page.drawText(line, { x: a.x + d * Math.sin(r), y: a.y - d * Math.cos(r), size, font, color: hex(a.color), rotate: degrees(rot) });
        });
      } else if (a.type === 'note') {
        const ref = doc.context.register(doc.context.obj({
          Type: 'Annot', Subtype: 'Text', Rect: [a.x, a.y - 22, a.x + 22, a.y], Name: 'Comment', Open: false,
          Contents: PDFHexString.fromText(a.text || ''), T: PDFString.of('Mue'), C: [1, 0.82, 0.25], F: 4,
        }));
        page.node.addAnnot(ref);
      } else if (a.type === 'image') {
        if (!images.has(a.src)) images.set(a.src, await doc.embedPng(Buffer.from(a.src.split(',')[1], 'base64')));
        page.drawImage(images.get(a.src), { x: a.x, y: a.y, width: a.w, height: a.h, rotate: degrees(rot) });
      }
    }
  }

  const names = Object.keys(fields);
  if (names.length || flatten) {
    const form = doc.getForm();
    for (const name of names) {
      const v = fields[name];
      let f;
      try { f = form.getField(name); } catch { continue; }
      if (f instanceof PDFTextField) f.setText(latin(font, v || ''));
      else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
      else if ((f instanceof PDFDropdown || f instanceof PDFOptionList) && v) f.select(v);
      else if (f instanceof PDFRadioGroup && v) f.select(v);
    }
    form.updateFieldAppearances(font);
    if (flatten) form.flatten();
  }

  const dir = outputDir(file, output);
  await fsp.mkdir(dir, { recursive: true });
  const target = await uniquePath(path.join(dir, `${path.parse(file).name}${suffix}.pdf`));
  const bytes = await doc.save({ useObjectStreams: true });
  if (password) {
    const tmp = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'mue-pdf-')), 'clair.pdf');
    await fsp.writeFile(tmp, bytes);
    await helper('encrypt', tmp, target, password);
    await fsp.rm(path.dirname(tmp), { recursive: true, force: true });
  } else {
    await fsp.writeFile(target, bytes);
  }
  const size = (await fsp.stat(target)).size;
  return { input: file, output: target, size };
}

module.exports = { setHelperPath, unlock, formFields, saveEdited, info, assemble, split, parseRanges, compress, imagesToPdf, outputDir, uniquePath };
