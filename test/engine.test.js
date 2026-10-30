// Test rapide du moteur : node test/engine.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const engine = require('../src/engine');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mue-test-'));
  const jpg = path.join(dir, 'photo.jpg');
  const png = path.join(dir, 'logo.png');
  await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#3a7bd5' } })
    .composite([{ input: Buffer.from('<svg width="2400" height="1600"><circle cx="1200" cy="800" r="600" fill="#f5a623"/></svg>') }])
    .withExif({ IFD0: { Artist: 'Test' } })
    .jpeg({ quality: 98 }).toFile(jpg);
  await sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="800" height="800"><rect x="100" y="100" width="600" height="600" fill="#e33"/></svg>') }])
    .png().toFile(png);
  const heic = path.join(dir, 'iphone.heic');
  if (process.platform === 'darwin') execFileSync('sips', ['-s', 'format', 'heic', jpg, '--out', heic]);

  const files = await engine.expandPaths([dir]);
  assert.strictEqual(files.length, process.platform === 'darwin' ? 3 : 2);

  for (const format of ['webp', 'avif', 'jpeg', 'png', 'tiff', 'gif']) {
    const r = await engine.convertFile(jpg, { format, quality: 80, resize: { mode: 'none' } });
    const m = await sharp(r.output).metadata();
    assert.strictEqual(m.width, 2400, format);
    console.log(`✓ jpg → ${format.padEnd(4)} ${(r.inSize / 1024) | 0} Ko → ${(r.outSize / 1024) | 0} Ko`);
  }

  let r = await engine.convertFile(jpg, { format: 'webp', quality: 80, resize: { mode: 'percent', percent: 50 } });
  assert.deepStrictEqual([r.width, r.height], [1200, 800]);
  console.log('✓ redimension 50 %');

  r = await engine.convertFile(jpg, { format: 'jpeg', quality: 80, resize: { mode: 'max', width: 1920 } });
  assert.deepStrictEqual([r.width, r.height], [1920, 1280]);
  r = await engine.convertFile(png, { format: 'png', quality: 80, resize: { mode: 'max', width: 1920 } });
  assert.strictEqual(r.width, 800, 'pas d’agrandissement');
  console.log('✓ redimension max px');

  r = await engine.convertFile(jpg, { format: 'jpeg', quality: 80 });
  assert.ok(!(await sharp(r.output).metadata()).exif, 'EXIF supprimés');
  r = await engine.convertFile(jpg, { format: 'jpeg', quality: 80, keepMetadata: true });
  assert.ok((await sharp(r.output).metadata()).exif, 'EXIF conservés');
  console.log('✓ métadonnées');

  r = await engine.convertFile(png, { format: 'jpeg', quality: 80 });
  console.log('✓ png transparent → jpeg');

  if (process.platform === 'darwin') {
    r = await engine.convertFile(heic, { format: 'jpeg', quality: 85 });
    assert.strictEqual(r.width, 2400);
    const info = await engine.inspect(heic);
    assert.ok(info.thumb.startsWith('data:image/webp'));
    console.log('✓ heic → jpeg + miniature');
  }

  const custom = path.join(dir, 'sortie');
  const res = await engine.convertBatch([jpg, png], {
    format: 'webp', quality: 75, output: { mode: 'custom', dir: custom }, rename: { enabled: true, base: 'vacances', start: 1 },
  });
  assert.ok(res.every((x) => x.ok));
  assert.deepStrictEqual(fs.readdirSync(custom).sort(), ['vacances-001.webp', 'vacances-002.webp']);
  console.log('✓ lot + dossier personnalisé + renommage');

  r = await engine.denoiseFile(jpg, { strength: 60, color: 60, detail: 30 });
  assert.ok(r.output.endsWith('photo-net.jpg'));
  assert.strictEqual(r.width, 2400);
  const pv = await engine.denoisePreview(jpg, { strength: 60 }, { width: 400, height: 300 });
  assert.ok(pv.before.startsWith('data:image/png') && pv.after.startsWith('data:image/png'));
  console.log('✓ réduction du bruit + aperçu');

  const est = await engine.estimateSize(jpg, { format: 'webp', quality: 80, resize: { mode: 'percent', percent: 50 } });
  r = await engine.convertFile(jpg, { format: 'webp', quality: 80, resize: { mode: 'percent', percent: 50 } });
  assert.deepStrictEqual([est.width, est.height], [r.width, r.height]);
  assert.ok(Math.abs(est.bytes / r.outSize - 1) < 0.35, `estimation ${est.bytes} vs ${r.outSize}`);
  console.log('✓ estimation du poids');

  const tilted = path.join(dir, 'penche.jpg');
  await sharp({ create: { width: 2000, height: 1400, channels: 3, background: '#8fb6d8' } })
    .composite([{ input: Buffer.from('<svg width="2000" height="1400"><rect y="800" width="2000" height="600" fill="#3d5a3a"/><rect x="400" y="300" width="300" height="500" fill="#ddd"/><rect x="1200" y="350" width="300" height="450" fill="#ddd"/></svg>') }])
    .png().toBuffer().then((b) => sharp(b).rotate(4, { background: '#fff' }).jpeg().toFile(tilted));
  const lvl = await engine.autoLevel(tilted);
  assert.ok(Math.abs(lvl + 4) < 0.5, `redressement auto ${lvl}`);
  r = await engine.editFile(jpg, { edit: { quarter: 1, flipH: true, angle: 3, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } } });
  assert.ok(r.output.endsWith('photo-recadre.jpg') && r.height > r.width);
  console.log('✓ recadrage, rotation, redressement auto (' + lvl + '°)');

  const pdf = require('../src/pdf');
  const doc = path.join(dir, 'album.pdf');
  await pdf.imagesToPdf([jpg, png, jpg], doc, { pageSize: 'a4' });
  assert.strictEqual((await pdf.info(doc)).pages, 3);
  const asm = await pdf.assemble([{ file: doc, index: 2, rotate: 90 }, { file: doc, index: 0 }], path.join(dir, 'asm.pdf'));
  assert.strictEqual((await pdf.info(asm.output)).pages, 2);
  const sp = await pdf.split(doc, { mode: 'ranges', ranges: '1-2, 3', output: { mode: 'custom', dir: path.join(dir, 'split') } });
  assert.strictEqual(sp.files, 2);
  const cp = await pdf.compress(doc, { level: 'strong', output: { mode: 'custom', dir: path.join(dir, 'cp') } });
  assert.ok(cp.outSize <= cp.inSize);
  assert.throws(() => pdf.parseRanges('2-9', 3));
  const signed = await pdf.saveEdited(doc, {
    annotations: { 0: [{ type: 'highlight', rect: [40, 40, 200, 80], color: '#f5d34a' }, { type: 'text', x: 50, y: 700, text: 'Note : été', size: 14, color: '#1d1f1a' }, { type: 'note', x: 500, y: 800, text: 'À vérifier' }, { type: 'ink', strokes: [[[50, 500], [90, 520]]], width: 3, color: '#c0392b' }] },
    password: process.platform === 'darwin' ? 'secret' : '',
    output: { mode: 'custom', dir: path.join(dir, 'signe') },
  });
  if (process.platform === 'darwin') {
    await assert.rejects(pdf.info(signed.output), /mot de passe/);
    const clear = await pdf.unlock(signed.output, 'secret');
    assert.strictEqual((await pdf.info(clear)).pages, 3);
  }
  assert.deepStrictEqual(await pdf.formFields(doc), []);
  console.log('✓ PDF : annotations, mot de passe, déverrouillage');
  console.log('✓ PDF : images → PDF, assemblage, découpe, compression (' + Math.round(cp.inSize / 1024) + ' → ' + Math.round(cp.outSize / 1024) + ' Ko)');

  const video = require('../src/video');
  const ff = require('ffmpeg-static');
  const clip = path.join(dir, 'clip.mkv');
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25,pad=640:480:0:60:black', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', clip]);
  const vi = await video.probe(clip);
  assert.ok(vi.video && vi.video.width === 640 && vi.audio.length === 1 && Math.abs(vi.duration - 3) < 0.2);
  const vc = await video.detectCrop(clip, vi);
  assert.ok(vc.top >= 56 && vc.bottom >= 56, 'bandes noires détectées');
  const vs = { format: 'mp4', dims: { height: '240', rotate: 0, flip: false, crop: vc }, filters: { deinterlace: 'auto', denoise: 'off', sharpen: 'off', grayscale: false }, video: { codec: 'h264', mode: 'quality', quality: 26, speed: 'fast', fps: 'same' }, audio: { codec: 'aac', bitrate: 96, mix: 'mono', normalize: false }, chapters: true, metadata: true };
  let lastRatio = 0;
  const ve = await video.encode(clip, vs, { info: vi, audio: [0], trim: { start: '0.5', end: '2.5' } }, { onProgress: (p) => { lastRatio = p.ratio; } });
  const vo = await video.probe(ve.output);
  assert.ok(vo.video.height === 240 && Math.abs(vo.duration - 2) < 0.2 && /mono/.test(vo.audio[0].layout));
  console.log('✓ vidéo : analyse, rognage auto, encodage H.264 240p, découpe (' + vo.video.width + '×' + vo.video.height + ', progression ' + Math.round(lastRatio * 100) + ' %)');

  assert.ok(fs.existsSync(jpg), 'original intact');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nTous les tests passent.');
})().catch((e) => { console.error(e); process.exit(1); });
