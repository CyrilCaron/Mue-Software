const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const engine = require('./engine');
const pdf = require('./pdf');
const video = require('./video');
const fsp = require('fs/promises');
const sharp = require('sharp');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 560,
    title: 'Mue',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151713' : '#e3e4da',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('pick-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Ajouter des images',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Images', extensions: engine.INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return canceled ? [] : engine.expandPaths(filePaths);
});

ipcMain.handle('pick-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Dossier de destination',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('expand', (_e, paths) => engine.expandPaths(paths));

ipcMain.handle('inspect', async (_e, file) => {
  try { return await engine.inspect(file); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('convert', async (e, files, opts) => {
  return engine.convertBatch(files, opts, (_i, result) => e.sender.send('progress', result.input, result));
});

ipcMain.handle('estimate', async (_e, file, opts) => {
  try { return await engine.estimateSize(file, opts); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('edit-base', async (_e, file, edit) => {
  try { return await engine.editBase(file, edit); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('auto-level', async (_e, file, edit) => {
  try { return await engine.autoLevel(file, edit); } catch { return 0; }
});

ipcMain.handle('edit', async (e, files, opts) => {
  return engine.editBatch(files, opts, (_i, result) => e.sender.send('progress', result.input, result));
});

ipcMain.handle('denoise', async (e, files, opts) => {
  return engine.denoiseBatch(files, opts, (_i, result) => e.sender.send('progress', result.input, result));
});

ipcMain.handle('denoise-preview', async (_e, file, opts, area) => {
  try { return await engine.denoisePreview(file, opts, area); } catch (e) { return { error: e.message }; }
});

/* ---------- PDF ---------- */

ipcMain.handle('pick-pdf', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Ajouter des PDF ou des images',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'PDF et images', extensions: ['pdf', ...engine.INPUT_EXTS.map((e) => e.slice(1))] }],
  });
  return canceled ? [] : engine.expandPaths(filePaths, { pdf: true });
});
ipcMain.handle('expand-pdf', (_e, paths) => engine.expandPaths(paths, { pdf: true }));
ipcMain.handle('read-file', (_e, file) => fsp.readFile(file));

const safe = (fn) => async (...args) => { try { return { ok: true, ...(await fn(...args)) }; } catch (e) { return { ok: false, error: e.message }; } };

if (app.isPackaged) {
  pdf.setHelperPath(path.join(process.resourcesPath, 'native', 'mue-pdfkit'));
  // ffmpeg ne peut pas s'exécuter depuis l'archive asar : on utilise la copie décompressée
  video.setFfmpegPath(require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'));
}

/* ---------- Vidéo ---------- */

ipcMain.handle('pick-video', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Ajouter des vidéos',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Vidéos', extensions: video.VIDEO_EXTS.map((e) => e.slice(1)) }],
  });
  return canceled ? [] : engine.expandPaths(filePaths, { video: true });
});
ipcMain.handle('pick-subs', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Ajouter des sous-titres', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Sous-titres', extensions: ['srt', 'ass', 'ssa', 'vtt'] }],
  });
  return canceled ? [] : filePaths;
});
ipcMain.handle('expand-video', (_e, paths) => engine.expandPaths(paths, { video: true }));
ipcMain.handle('video-probe', (_e, file) => safe(async () => ({ info: await video.probe(file) }))());
ipcMain.handle('video-crop', (_e, file, info) => safe(async () => ({ crop: await video.detectCrop(file, info) }))());
ipcMain.handle('video-frame', (_e, file, info, s, at) => safe(async () => ({ src: await video.frame(file, info, s, at) }))());
ipcMain.handle('video-cancel', () => video.cancel());
ipcMain.handle('video-encode', async (e, jobs, s, output) => {
  const results = [];
  for (const job of jobs) {
    let r;
    try {
      r = { ok: true, ...(await video.encode(job.file, { ...s, dims: { ...s.dims, crop: job.per.crop } }, job.per, {
        output, onProgress: (p) => e.sender.send('video-progress', job.file, p),
      })) };
    } catch (err) {
      r = { ok: false, input: job.file, error: err.message, cancelled: !!err.cancelled };
    }
    e.sender.send('video-done', job.file, r);
    results.push(r);
    if (r.cancelled) break;
  }
  return results;
});

ipcMain.handle('pdf-info', (_e, file) => safe(pdf.info)(file));
ipcMain.handle('pdf-unlock', (_e, file, password) => safe(async () => ({ path: await pdf.unlock(file, password) }))());
ipcMain.handle('pdf-fields', (_e, file) => safe(async () => ({ fields: await pdf.formFields(file) }))());
ipcMain.handle('pdf-save-edited', (_e, file, opts) => safe(pdf.saveEdited)(file, opts));
ipcMain.handle('pdf-assemble', (_e, pages, opts) => safe(async () => {
  const dir = pdf.outputDir(pages[0].file, opts.output);
  const name = (opts.name || 'document').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '');
  return pdf.assemble(pages, path.join(dir, `${name}.pdf`));
})());

// Traite une liste de fichiers un par un, en signalant chaque résultat à l'interface
async function pdfBatch(e, files, task) {
  const results = [];
  for (const file of files) {
    let r;
    try { r = { ok: true, input: file, ...(await task(file)) }; } catch (err) { r = { ok: false, input: file, error: err.message }; }
    e.sender.send('pdf-progress', file, r);
    results.push(r);
  }
  return results;
}
ipcMain.handle('pdf-split', (e, files, opts) => pdfBatch(e, files, (f) => pdf.split(f, opts)));
ipcMain.handle('pdf-compress', (e, files, opts) => pdfBatch(e, files, (f) => pdf.compress(f, opts)));
ipcMain.handle('pdf-from-images', (_e, files, opts) => safe(async () => {
  const dir = pdf.outputDir(files[0], opts.output);
  const name = (opts.name || 'images').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '');
  return pdf.imagesToPdf(files, path.join(dir, `${name}.pdf`), { ...opts, readable: engine.readable });
})());

// Enregistre une page rendue par pdf.js (PNG) dans le format demandé
ipcMain.handle('pdf-save-page', (_e, file, index, png, opts) => safe(async () => {
  const dir = path.join(pdf.outputDir(file, opts.output), `${path.parse(file).name}-pages`);
  await fsp.mkdir(dir, { recursive: true });
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp' }[opts.format] || 'jpg';
  const target = await pdf.uniquePath(path.join(dir, `${path.parse(file).name}-p${String(index + 1).padStart(3, '0')}.${ext}`));
  let img = sharp(Buffer.from(png));
  if (opts.format === 'png') img = img.png({ compressionLevel: 9 });
  else if (opts.format === 'webp') img = img.webp({ quality: opts.quality || 85 });
  else img = img.flatten({ background: '#ffffff' }).jpeg({ quality: opts.quality || 85, mozjpeg: true });
  const info = await img.toFile(target);
  return { output: target, size: info.size };
})());

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('set-theme', (_e, theme) => {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
});

app.setName('Mue');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
