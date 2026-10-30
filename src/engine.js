// Moteur de conversion : aucune dépendance à Electron, testable avec Node seul.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { denoiseRaw } = require('./denoise');
const { innerScale, detectTilt } = require('./transform');

const INPUT_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif', '.gif', '.tif', '.tiff', '.bmp', '.svg'];
const HEIC_EXTS = ['.heic', '.heif'];
// Formats que sharp ne lit pas directement : on passe par sips (macOS).
const VIA_SIPS = [...HEIC_EXTS, '.bmp'];

const OUTPUT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', avif: '.avif', tiff: '.tiff', gif: '.gif' };

function isSupported(file) {
  return INPUT_EXTS.includes(path.extname(file).toLowerCase());
}

// Développe une liste de fichiers et de dossiers en liste d'images (récursif).
const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp', '.vob', '.ogv'];

async function expandPaths(paths, { pdf = false, video = false } = {}) {
  const out = [];
  const seen = new Set();
  async function walk(p) {
    let st;
    try { st = await fsp.stat(p); } catch { return; }
    if (st.isDirectory()) {
      const name = path.basename(p);
      if (name.startsWith('.') || name === 'converti') return;
      const entries = await fsp.readdir(p);
      for (const e of entries.sort()) await walk(path.join(p, e));
    } else if (st.isFile() && !seen.has(p) && (video ? VIDEO_EXTS.includes(path.extname(p).toLowerCase()) : isSupported(p) || (pdf && /\.pdf$/i.test(p)))) {
      seen.add(p);
      out.push({ path: p, size: st.size, kind: video ? 'video' : /\.pdf$/i.test(p) ? 'pdf' : 'image' });
    }
  }
  for (const p of paths) await walk(p);
  return out;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// Renvoie un chemin lisible par sharp (décode HEIC/BMP via sips si besoin) et une fonction de nettoyage.
async function readable(file) {
  const ext = path.extname(file).toLowerCase();
  if (!VIA_SIPS.includes(ext)) return { src: file, cleanup: async () => {} };
  if (process.platform !== 'darwin') throw new Error('Format HEIC non pris en charge sur ce système');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mue-'));
  const tmp = path.join(dir, 'decoded.tiff');
  await run('sips', ['-s', 'format', 'tiff', file, '--out', tmp]);
  return { src: tmp, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${name}-${i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

function formatFromExt(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.jpg', '.jpeg'].includes(ext)) return 'jpeg';
  if (['.tif', '.tiff'].includes(ext)) return 'tiff';
  if (['.png', '.webp', '.avif', '.gif'].includes(ext)) return ext.slice(1);
  return 'jpeg'; // HEIC, BMP, SVG : JPEG par défaut si « même format »
}

function outputName(file, format, opts) {
  const ext = OUTPUT_EXT[format];
  const suffix = opts.suffix || '';
  if (opts.rename && opts.rename.enabled) {
    const base = (opts.rename.base || 'image').trim() || 'image';
    const n = (opts.rename.start || 1) + (opts.index || 0);
    const digits = Math.max(3, String((opts.rename.start || 1) + (opts.total || 1) - 1).length);
    return `${base}-${String(n).padStart(digits, '0')}${suffix}${ext}`;
  }
  return path.parse(file).name + suffix + ext;
}

function outputDirFor(file, opts) {
  if (opts.output && opts.output.mode === 'custom' && opts.output.dir) return opts.output.dir;
  return path.join(path.dirname(file), 'converti');
}

function applyResize(img, meta, resize) {
  if (!resize || resize.mode === 'none') return img;
  if (resize.mode === 'percent') {
    const pct = Math.min(Math.max(Number(resize.percent) || 100, 1), 1000) / 100;
    if (pct === 1) return img;
    return img.resize({
      width: Math.max(1, Math.round(meta.width * pct)),
      height: Math.max(1, Math.round(meta.height * pct)),
      fit: 'fill',
    });
  }
  // mode 'max' : largeur / hauteur maximales, proportions conservées, jamais d'agrandissement
  const width = Number(resize.width) || null;
  const height = Number(resize.height) || null;
  if (!width && !height) return img;
  return img.resize({ width, height, fit: 'inside', withoutEnlargement: true });
}

function applyFormat(img, format, quality, hasAlpha) {
  const q = Math.min(Math.max(Math.round(quality), 1), 100);
  switch (format) {
    case 'jpeg':
      if (hasAlpha) img = img.flatten({ background: '#ffffff' });
      return img.jpeg({ quality: q, mozjpeg: true });
    case 'png':
      // 100 = sans perte ; en dessous, réduction de palette (forte compression)
      return q >= 100 ? img.png({ compressionLevel: 9 }) : img.png({ compressionLevel: 9, palette: true, quality: q });
    case 'webp':
      return q >= 100 ? img.webp({ lossless: true }) : img.webp({ quality: q, effort: 5 });
    case 'avif':
      return q >= 100 ? img.avif({ lossless: true }) : img.avif({ quality: q, effort: 4 });
    case 'tiff':
      return img.tiff({ quality: q, compression: q >= 100 ? 'lzw' : 'jpeg' });
    case 'gif':
      return img.gif();
    default:
      throw new Error(`Format inconnu : ${format}`);
  }
}

/**
 * Convertit une image.
 * opts: { format, quality, resize: {mode, width, height, percent}, keepMetadata,
 *         output: {mode: 'subfolder'|'custom', dir}, rename: {enabled, base, start}, index, total }
 */
async function convertFile(file, opts) {
  const inSize = (await fsp.stat(file)).size;
  const format = opts.format === 'same' ? formatFromExt(file) : opts.format;
  const { src, cleanup } = await readable(file);
  try {
    let img = sharp(src, { animated: false, limitInputPixels: false }).rotate();
    const meta = await sharp(src).metadata();
    // Dimensions après rotation EXIF
    const swap = meta.orientation >= 5;
    const base = { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };

    img = applyResize(img, base, opts.resize);
    if (opts.keepMetadata) img = img.keepMetadata();
    img = applyFormat(img, format, opts.quality ?? 82, meta.hasAlpha);

    const dir = outputDirFor(file, opts);
    await fsp.mkdir(dir, { recursive: true });
    const outPath = await uniquePath(path.join(dir, outputName(file, format, opts)));
    const info = await img.toFile(outPath);
    return { input: file, output: outPath, inSize, outSize: info.size, width: info.width, height: info.height, format };
  } finally {
    await cleanup();
  }
}

// Estime le poids de sortie sans écrire de fichier : on encode quelques zones de l'image
// redimensionnée et on extrapole à la surface totale. Précis à environ 10-20 %.
async function estimateSize(file, opts) {
  const format = opts.format === 'same' ? formatFromExt(file) : opts.format;
  const q = opts.quality ?? 82;
  const { src, cleanup } = await readable(file);
  try {
    const meta = await sharp(src).metadata();
    const swap = meta.orientation >= 5;
    const base = { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
    const raw = await rawPixels(applyResize(sharp(src, { limitInputPixels: false }).rotate(), base, opts.resize));
    const { width: W, height: H, channels } = raw;
    const enc = async (left, top, width, height) => (await applyFormat(
      sharp(raw.data, { raw: { width: W, height: H, channels } }).extract({ left, top, width, height }),
      format, q, channels === 4,
    ).toBuffer()).length;

    const S = 448;
    let bytes;
    if (W * H <= (S * 2) ** 2) {
      bytes = await enc(0, 0, W, H);
    } else {
      const header = await enc(0, 0, Math.min(16, W), Math.min(16, H));
      const w = Math.min(S, W), h = Math.min(S, H);
      let perPixel = 0;
      const spots = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.7], [0.3, 0.75], [0.7, 0.25]];
      for (const [cx, cy] of spots) {
        const left = Math.round(Math.min(Math.max(cx * W - w / 2, 0), W - w));
        const top = Math.round(Math.min(Math.max(cy * H - h / 2, 0), H - h));
        perPixel += Math.max(0, (await enc(left, top, w, h)) - header) / (w * h);
      }
      bytes = (perPixel / spots.length) * W * H + header;
    }
    if (opts.keepMetadata) bytes += (meta.exif?.length || 0) + (meta.icc?.length || 0) + (meta.xmp?.length || 0);
    return { bytes: Math.round(bytes), width: W, height: H };
  } finally {
    await cleanup();
  }
}

// Pixels bruts RGB(A) d'une image, orientation EXIF appliquée.
async function rawPixels(img) {
  const { data, info } = await img.toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Réduit le bruit d'une image.
 * opts: { strength, color, detail, format ('same' ou un format), quality, output, rename, index, total }
 */
async function denoiseFile(file, opts) {
  const inSize = (await fsp.stat(file)).size;
  const format = !opts.format || opts.format === 'same' ? formatFromExt(file) : opts.format;
  const { src, cleanup } = await readable(file);
  try {
    const raw = await rawPixels(sharp(src, { limitInputPixels: false }).rotate());
    const out = denoiseRaw(raw.data, raw.width, raw.height, raw.channels, opts);
    const img = applyFormat(
      sharp(out, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }),
      format, opts.quality ?? 92, raw.channels === 4,
    );
    const dir = outputDirFor(file, opts);
    await fsp.mkdir(dir, { recursive: true });
    const outPath = await uniquePath(path.join(dir, outputName(file, format, { ...opts, suffix: '-net' })));
    const info = await img.toFile(outPath);
    return { input: file, output: outPath, inSize, outSize: info.size, width: info.width, height: info.height, format };
  } finally {
    await cleanup();
  }
}

// Aperçu à 100 % d'une zone de l'image (cx, cy entre 0 et 1), avant et après réduction du bruit.
async function denoisePreview(file, opts, { width = 720, height = 480, cx = 0.5, cy = 0.5 } = {}) {
  const { src, cleanup } = await readable(file);
  try {
    const rotated = await sharp(src, { limitInputPixels: false }).rotate().toBuffer({ resolveWithObject: true });
    const W = rotated.info.width, H = rotated.info.height;
    const cw = Math.min(width, W), ch = Math.min(height, H);
    const left = Math.round(Math.min(Math.max(cx * W - cw / 2, 0), W - cw));
    const top = Math.round(Math.min(Math.max(cy * H - ch / 2, 0), H - ch));
    const raw = await rawPixels(sharp(rotated.data).extract({ left, top, width: cw, height: ch }));
    const out = denoiseRaw(raw.data, raw.width, raw.height, raw.channels, opts);
    const enc = async (buf) => `data:image/png;base64,${(await sharp(buf, { raw: { width: cw, height: ch, channels: raw.channels } }).png({ compressionLevel: 1 }).toBuffer()).toString('base64')}`;
    return { before: await enc(raw.data), after: await enc(out), width: cw, height: ch };
  } finally {
    await cleanup();
  }
}

// Applique les retouches géométriques à des pixels bruts, dans l'ordre de l'éditeur :
// quart de tour, miroirs, redressement (avec recadrage automatique des coins vides), puis cadre.
// edit: { quarter: 0..3, flipH, flipV, angle (degrés), crop: { x, y, w, h } entre 0 et 1 }
async function applyEdit(raw, edit = {}, { skipCrop = false } = {}) {
  const step = async (fn) => {
    const img = fn(sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }));
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    raw = { data, width: info.width, height: info.height, channels: info.channels };
  };
  const q = ((edit.quarter || 0) % 4 + 4) % 4;
  if (q) await step((i) => i.rotate(q * 90));
  if (edit.flipH || edit.flipV) await step((i) => i.flop(!!edit.flipH).flip(!!edit.flipV));
  const angle = Number(edit.angle) || 0;
  if (angle) {
    const { width: w, height: h } = raw;
    const k = innerScale(w, h, angle);
    await step((i) => i.rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }));
    const iw = Math.floor(w * k), ih = Math.floor(h * k);
    const left = Math.floor((raw.width - iw) / 2), top = Math.floor((raw.height - ih) / 2);
    await step((i) => i.extract({ left, top, width: iw, height: ih }));
  }
  const c = edit.crop;
  if (!skipCrop && c && (c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1)) {
    const left = Math.max(0, Math.round(c.x * raw.width)), top = Math.max(0, Math.round(c.y * raw.height));
    const width = Math.max(1, Math.min(raw.width - left, Math.round(c.w * raw.width)));
    const height = Math.max(1, Math.min(raw.height - top, Math.round(c.h * raw.height)));
    await step((i) => i.extract({ left, top, width, height }));
  }
  return raw;
}

// Image de travail de l'éditeur : orientation et miroirs appliqués, sans redressement ni cadre.
async function editBase(file, edit, maxSide = 1600) {
  const { src, cleanup } = await readable(file);
  try {
    let raw = await rawPixels(sharp(src, { limitInputPixels: false }).rotate().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }));
    raw = await applyEdit(raw, { quarter: edit.quarter, flipH: edit.flipH, flipV: edit.flipV });
    const buf = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }).jpeg({ quality: 85 }).toBuffer();
    return { url: `data:image/jpeg;base64,${buf.toString('base64')}`, width: raw.width, height: raw.height };
  } finally {
    await cleanup();
  }
}

// Angle de redressement proposé pour une image (après quart de tour et miroirs).
async function autoLevel(file, edit = {}) {
  const { src, cleanup } = await readable(file);
  try {
    let raw = await rawPixels(sharp(src).rotate().resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }));
    raw = await applyEdit(raw, { quarter: edit.quarter, flipH: edit.flipH, flipV: edit.flipV });
    // Le filtre de contours sous-estime un peu les petits angles : on corrige, puis on mesure
    // l'écart restant sur l'image redressée, deux fois de suite.
    let angle = 0;
    for (let pass = 0; pass < 3; pass++) {
      const turned = angle ? await applyEdit(raw, { angle }) : raw;
      const { data, info } = await sharp(turned.data, { raw: { width: turned.width, height: turned.height, channels: turned.channels } })
        .greyscale().raw().toBuffer({ resolveWithObject: true });
      const gray = new Float32Array(info.width * info.height);
      for (let i = 0; i < gray.length; i++) gray[i] = data[i * info.channels];
      const residual = detectTilt(gray, info.width, info.height);
      if (!residual) break;
      angle += residual;
    }
    return Math.round(angle * 10) / 10;
  } finally {
    await cleanup();
  }
}

// Enregistre une image retouchée (opts.edit) dans le format choisi.
async function editFile(file, opts) {
  const inSize = (await fsp.stat(file)).size;
  const format = !opts.format || opts.format === 'same' ? formatFromExt(file) : opts.format;
  const { src, cleanup } = await readable(file);
  try {
    const raw = await applyEdit(await rawPixels(sharp(src, { limitInputPixels: false }).rotate()), opts.edit);
    const img = applyFormat(sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }), format, opts.quality ?? 92, raw.channels === 4);
    const dir = outputDirFor(file, opts);
    await fsp.mkdir(dir, { recursive: true });
    const outPath = await uniquePath(path.join(dir, outputName(file, format, { ...opts, suffix: '-recadre' })));
    const info = await img.toFile(outPath);
    return { input: file, output: outPath, inSize, outSize: info.size, width: info.width, height: info.height, format };
  } finally {
    await cleanup();
  }
}

// Miniature + infos pour l'affichage dans la liste.
async function inspect(file) {
  const { src, cleanup } = await readable(file);
  try {
    const meta = await sharp(src).metadata();
    const swap = meta.orientation >= 5;
    const buf = await sharp(src).rotate().resize(120, 120, { fit: 'cover' }).webp({ quality: 70 }).toBuffer();
    return {
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      thumb: `data:image/webp;base64,${buf.toString('base64')}`,
    };
  } finally {
    await cleanup();
  }
}

// Traite une liste avec un nombre limité de tâches simultanées.
async function convertBatch(files, opts, onProgress, concurrency = Math.max(2, Math.min(4, os.cpus().length >> 1)), task = convertFile) {
  const results = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      try {
        results[i] = { ok: true, ...(await task(files[i], { ...opts, index: i, total: files.length })) };
      } catch (e) {
        results[i] = { ok: false, input: files[i], error: e.message };
      }
      onProgress && onProgress(i, results[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// Le débruitage occupe tout un cœur et beaucoup de mémoire : une image à la fois.
const denoiseBatch = (files, opts, onProgress) => convertBatch(files, opts, onProgress, 1, denoiseFile);

// Chaque image a ses propres retouches : opts.edits[chemin]
const editBatch = (files, opts, onProgress) => convertBatch(files, opts, onProgress, 2,
  (file, o) => editFile(file, { ...o, edit: (opts.edits || {})[file] || {} }));

module.exports = { readable, INPUT_EXTS, OUTPUT_EXT, isSupported, expandPaths, convertFile, convertBatch, estimateSize, inspect, denoiseFile, denoiseBatch, denoisePreview, editBase, autoLevel, editFile, editBatch };
