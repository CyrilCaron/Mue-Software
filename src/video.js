// Moteur vidéo : lit les informations d'un fichier et le réencode avec ffmpeg,
// avec des réglages complets (format, dimensions, filtres, vidéo, audio, sous-titres).
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');

let ffmpegPath = require('ffmpeg-static');
const setFfmpegPath = (p) => { ffmpegPath = p; };

const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp', '.vob', '.ogv'];
const isVideo = (f) => VIDEO_EXTS.includes(path.extname(f).toLowerCase());
const IMAGE_SUBS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];

function run(args, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr: stderr.toString() });
    });
  });
}

const toSeconds = (t) => {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return t;
  const parts = String(t).trim().replace(',', '.').split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((s, n) => s * 60 + n, 0);
};

/* ---------- Informations sur le fichier ---------- */

// ffprobe n'est pas livré : on lit la description que ffmpeg écrit quand on lui donne seulement une entrée
async function probe(file) {
  const { stderr } = await run(['-hide_banner', '-i', file]);
  const lines = stderr.split('\n');
  const info = { file, duration: 0, bitrate: null, video: null, audio: [], subs: [], chapters: [] };
  const d = stderr.match(/Duration: (\d+):(\d+):([\d.]+)(?:, start: [-\d.]+)?, bitrate: (\d+|N\/A)/);
  if (d) {
    info.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
    info.bitrate = d[4] === 'N/A' ? null : +d[4];
  }
  let current = null, audioN = 0, subN = 0;
  for (const line of lines) {
    const ch = line.match(/Chapter #\d+:\d+: start ([\d.]+), end ([\d.]+)/);
    if (ch) { current = { start: +ch[1], end: +ch[2], title: '' }; info.chapters.push(current); continue; }
    const st = line.match(/Stream #0:(\d+)(?:\[0x[\da-f]+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (.*)$/);
    if (st) {
      const [, index, lang, kind, rest] = st;
      const codec = rest.split(/[\s,(]/)[0];
      const flags = { default: /\(default\)/.test(rest), forced: /\(forced\)/.test(rest) };
      if (kind === 'Video' && !info.video && !/attached pic/.test(rest)) {
        const wh = rest.match(/, (\d{2,5})x(\d{2,5})/);
        const fps = rest.match(/([\d.]+) fps/);
        const kbs = rest.match(/(\d+) kb\/s/);
        current = info.video = { index: +index, codec, width: wh ? +wh[1] : 0, height: wh ? +wh[2] : 0, fps: fps ? +fps[1] : null, bitrate: kbs ? +kbs[1] : null, rotation: 0, interlaced: /top first|bottom first|interlaced/.test(rest) };
      } else if (kind === 'Audio') {
        const layout = rest.match(/Hz, ([^,]+)/);
        const kbs = rest.match(/(\d+) kb\/s/);
        current = { n: audioN++, index: +index, codec, lang: lang || '', title: '', layout: layout ? layout[1].trim() : '', bitrate: kbs ? +kbs[1] : null, ...flags };
        info.audio.push(current);
      } else if (kind === 'Subtitle') {
        current = { n: subN++, index: +index, codec, lang: lang || '', title: '', image: IMAGE_SUBS.includes(codec), ...flags };
        info.subs.push(current);
      } else current = null;
      continue;
    }
    const meta = line.match(/^\s+title\s+: (.*)$/);
    if (meta && current) current.title = meta[1].trim();
    const rot = line.match(/rotation of (-?[\d.]+) degrees/) || line.match(/^\s+rotate\s+: (-?\d+)/);
    if (rot && info.video) info.video.rotation = Math.round(+rot[1]);
  }
  if (!info.video && !info.audio.length) throw new Error('Ce fichier ne contient pas de vidéo lisible');
  const st = await fsp.stat(file);
  info.size = st.size;
  return info;
}

// Bandes noires : on échantillonne trois moments et on garde le cadre le plus large trouvé
async function detectCrop(file, info) {
  const v = info.video;
  if (!v) return null;
  let best = null;
  for (const at of [0.2, 0.5, 0.8]) {
    const { stderr } = await run(['-hide_banner', '-ss', String(info.duration * at), '-i', file, '-map', '0:v:0', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-frames:v', '12', '-an', '-f', 'null', '-']);
    const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (!all.length) continue;
    const [, w, h, x, y] = all[all.length - 1].map(Number);
    if (!best) best = { w, h, x, y };
    else {
      const x1 = Math.min(best.x, x), y1 = Math.min(best.y, y);
      const x2 = Math.max(best.x + best.w, x + w), y2 = Math.max(best.y + best.h, y + h);
      best = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
  }
  if (!best) return null;
  // Converti en marges (haut, bas, gauche, droite)
  const crop = { top: best.y, bottom: v.height - best.y - best.h, left: best.x, right: v.width - best.x - best.w };
  // Moins de 2 % de marge : on considère qu'il n'y a rien à rogner
  if (crop.top + crop.bottom < v.height * 0.02) { crop.top = 0; crop.bottom = 0; }
  if (crop.left + crop.right < v.width * 0.02) { crop.left = 0; crop.right = 0; }
  return crop;
}

/* ---------- Construction de la commande ffmpeg ---------- */

const CONTAINERS = {
  mp4: { ext: 'mp4', video: ['h264', 'hevc', 'av1', 'h264_hw', 'hevc_hw', 'copy'], audio: ['aac', 'mp3', 'ac3', 'opus', 'flac', 'copy'], subs: 'mov_text' },
  mkv: { ext: 'mkv', video: ['h264', 'hevc', 'av1', 'vp9', 'h264_hw', 'hevc_hw', 'copy'], audio: ['aac', 'opus', 'mp3', 'ac3', 'flac', 'copy'], subs: 'copy' },
  webm: { ext: 'webm', video: ['vp9', 'av1'], audio: ['opus'], subs: 'webvtt' },
  mov: { ext: 'mov', video: ['h264', 'hevc', 'prores', 'h264_hw', 'hevc_hw', 'copy'], audio: ['aac', 'flac', 'copy'], subs: 'mov_text' },
};
const SPEED = {
  x264: { fast: 'veryfast', medium: 'medium', slow: 'slow' },
  svt: { fast: '10', medium: '7', slow: '5' },
  vpx: { fast: '4', medium: '2', slow: '1' },
};
const DENOISE = { light: 'hqdn3d=2:1.5:4:3', medium: 'hqdn3d=4:3:6:4.5', strong: 'hqdn3d=7:5:9:7' };
const SHARPEN = { light: 'unsharp=5:5:0.4:3:3:0', medium: 'unsharp=5:5:0.8:3:3:0' };
const LAYOUT = { mono: 1, stereo: 2, '5.1': 6 };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Dimensions de sortie après rognage, rotation et réduction
function outputSize(info, s) {
  const v = info.video;
  if (!v) return null;
  const c = s.dims.crop || { top: 0, bottom: 0, left: 0, right: 0 };
  let w = v.width - c.left - c.right, h = v.height - c.top - c.bottom;
  const turned = ((s.dims.rotate || 0) + 360) % 180 === 90;
  if (turned) [w, h] = [h, w];
  const maxH = s.dims.height === 'same' ? null : +s.dims.height;
  // « 1080p » limite le plus petit côté, pour qu'une vidéo verticale ne soit pas écrasée
  if (maxH && Math.min(w, h) > maxH) {
    const k = maxH / Math.min(w, h);
    w *= k; h *= k;
  }
  return { width: even(w), height: even(h) };
}

function videoFilters(info, s, { preview = false } = {}) {
  const v = info.video, f = [];
  const fl = s.filters || {};
  if (fl.deinterlace === 'on' || (fl.deinterlace === 'auto' && v.interlaced)) f.push('bwdif=mode=send_frame');
  const c = s.dims.crop;
  if (c && (c.top || c.bottom || c.left || c.right)) f.push(`crop=${v.width - c.left - c.right}:${v.height - c.top - c.bottom}:${c.left}:${c.top}`);
  const r = ((s.dims.rotate || 0) + 360) % 360;
  if (r === 90) f.push('transpose=1');
  if (r === 180) f.push('transpose=1,transpose=1');
  if (r === 270) f.push('transpose=2');
  if (s.dims.flip) f.push('hflip');
  const out = outputSize(info, s);
  const turned = r % 180 === 90;
  const before = turned ? { width: v.height - (c?.top || 0) - (c?.bottom || 0), height: v.width - (c?.left || 0) - (c?.right || 0) } : { width: v.width - (c?.left || 0) - (c?.right || 0), height: v.height - (c?.top || 0) - (c?.bottom || 0) };
  if (out.width !== before.width || out.height !== before.height) f.push(`scale=${out.width}:${out.height}:flags=lanczos`);
  if (fl.denoise && DENOISE[fl.denoise]) f.push(DENOISE[fl.denoise]);
  if (fl.sharpen && SHARPEN[fl.sharpen]) f.push(SHARPEN[fl.sharpen]);
  if (fl.grayscale) f.push('hue=s=0');
  if (!preview && s.video.fps !== 'same') f.push(`fps=${s.video.fps}`);
  return f;
}

function audioBitrateFor(codec, s, channels) {
  if (codec === 'flac' || codec === 'copy') return 0;
  const base = +s.audio.bitrate || 160;
  return channels >= 6 ? Math.max(base, 384) : channels === 1 ? Math.round(base / 2) : base;
}

/**
 * file: chemin ; info: résultat de probe ; s: réglages ; per: choix propres à ce fichier
 * per = { audio: [n…], subs: [n…], burn: n|null, extSubs: [chemins], trim: { start, end } }
 * Renvoie { args, output, warnings, duration }
 */
function buildArgs(file, info, s, per = {}, output) {
  const box = CONTAINERS[s.format] || CONTAINERS.mp4;
  const warnings = [];
  const args = ['-hide_banner', '-nostdin', '-y'];
  const start = toSeconds(per.trim?.start), end = toSeconds(per.trim?.end);
  if (start) args.push('-ss', String(start));
  if (end) args.push('-to', String(end));
  args.push('-i', file);
  const ext = (per.extSubs || []).filter(Boolean);
  ext.forEach((p) => args.push('-i', p));
  const duration = Math.max(0.1, (end || info.duration) - (start || 0));

  // Vidéo
  let vcodec = s.video.codec;
  if (!box.video.includes(vcodec)) { warnings.push(`Le format ${s.format.toUpperCase()} n'accepte pas ce codec vidéo : ${box.video[0]} utilisé à la place.`); vcodec = box.video[0]; }
  const audioTracks = (per.audio || info.audio.map((a) => a.n)).map((n) => info.audio.find((a) => a.n === n)).filter(Boolean);

  if (info.video) {
    args.push('-map', `0:${info.video.index}`);
    const filters = vcodec === 'copy' ? [] : videoFilters(info, s);
    if (per.burn != null && vcodec !== 'copy') {
      const sub = info.subs.find((x) => x.n === per.burn);
      if (sub && !sub.image) {
        const esc = file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
        filters.push(`subtitles='${esc}':si=${sub.n}`);
      } else if (sub) warnings.push('Les sous-titres en image ne peuvent pas être incrustés ; ils sont ignorés.');
    }
    if (filters.length) args.push('-vf', filters.join(','));
    const rf = +s.video.quality;
    const speed = s.video.speed || 'medium';
    let vbit = null;
    if (s.video.mode === 'bitrate') vbit = +s.video.bitrate;
    if (s.video.mode === 'size') {
      const audioKbps = audioTracks.reduce((sum, a) => sum + audioBitrateFor(s.audio.codec, s, LAYOUT[s.audio.mix] || 2), 0);
      vbit = Math.max(150, Math.floor(((+s.video.size * 8 * 1024 * 0.97) / duration) - audioKbps));
    }
    switch (vcodec) {
      case 'copy': args.push('-c:v', 'copy'); break;
      case 'h264':
        args.push('-c:v', 'libx264', '-preset', SPEED.x264[speed], '-pix_fmt', 'yuv420p', '-profile:v', 'high');
        args.push(...(vbit ? ['-b:v', `${vbit}k`, '-maxrate', `${Math.round(vbit * 1.5)}k`, '-bufsize', `${vbit * 2}k`] : ['-crf', String(rf)]));
        break;
      case 'hevc':
        args.push('-c:v', 'libx265', '-preset', SPEED.x264[speed], '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error');
        args.push(...(vbit ? ['-b:v', `${vbit}k`] : ['-crf', String(rf)]));
        if (s.format !== 'mkv') args.push('-tag:v', 'hvc1');
        break;
      case 'av1':
        args.push('-c:v', 'libsvtav1', '-preset', SPEED.svt[speed], '-pix_fmt', 'yuv420p');
        args.push(...(vbit ? ['-b:v', `${vbit}k`] : ['-crf', String(Math.min(63, Math.round(rf * 1.4)))]));
        break;
      case 'vp9':
        args.push('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', SPEED.vpx[speed], '-row-mt', '1', '-pix_fmt', 'yuv420p');
        args.push(...(vbit ? ['-b:v', `${vbit}k`] : ['-crf', String(Math.min(63, Math.round(rf * 1.45))), '-b:v', '0']));
        break;
      case 'h264_hw':
      case 'hevc_hw':
        args.push('-c:v', vcodec === 'h264_hw' ? 'h264_videotoolbox' : 'hevc_videotoolbox', '-pix_fmt', vcodec === 'h264_hw' ? 'yuv420p' : 'nv12');
        args.push(...(vbit ? ['-b:v', `${vbit}k`] : ['-q:v', String(Math.max(1, Math.min(100, Math.round(100 - (rf - 10) * 3.2))))]));
        if (vcodec === 'hevc_hw' && s.format !== 'mkv') args.push('-tag:v', 'hvc1');
        break;
      case 'prores':
        args.push('-c:v', 'prores_videotoolbox', '-profile:v', '2');
        break;
      default: break;
    }
    if (vcodec !== 'copy' && s.video.fps !== 'same') args.push('-fps_mode', s.video.fpsMode === 'vfr' ? 'vfr' : 'cfr');
  }

  // Audio
  let acodec = s.audio.codec;
  if (!box.audio.includes(acodec)) { acodec = box.audio[0]; if (audioTracks.length) warnings.push(`Le format ${s.format.toUpperCase()} impose l'audio en ${acodec.toUpperCase()}.`); }
  audioTracks.forEach((a, k) => {
    args.push('-map', `0:${a.index}`);
    if (acodec === 'copy') { args.push(`-c:a:${k}`, 'copy'); return; }
    const enc = { aac: 'aac', opus: 'libopus', mp3: 'libmp3lame', ac3: 'ac3', flac: 'flac' }[acodec];
    args.push(`-c:a:${k}`, enc);
    const src = /5\.1|6 channels/.test(a.layout) ? 6 : /mono/.test(a.layout) ? 1 : 2;
    const ch = s.audio.mix === 'same' ? Math.min(src, acodec === 'mp3' ? 2 : 6) : LAYOUT[s.audio.mix];
    if (s.audio.mix !== 'same' || ch !== src) args.push(`-ac:a:${k}`, String(ch));
    const br = audioBitrateFor(acodec, s, ch);
    if (br) args.push(`-b:a:${k}`, `${br}k`);
    if (s.audio.normalize) args.push(`-filter:a:${k}`, 'loudnorm=I=-16:TP=-1.5:LRA=11');
    if (a.lang) args.push(`-metadata:s:a:${k}`, `language=${a.lang}`);
    if (a.title) args.push(`-metadata:s:a:${k}`, `title=${a.title}`);
  });
  if (!audioTracks.length) args.push('-an');

  // Sous-titres conservés comme pistes (pas incrustés)
  const keep = (per.subs || []).map((n) => info.subs.find((x) => x.n === n)).filter((x) => x && x.n !== per.burn);
  let sk = 0;
  for (const sub of keep) {
    if (sub.image && s.format !== 'mkv') { warnings.push(`Sous-titres « ${sub.title || sub.lang || sub.codec} » en image : seul le format MKV peut les garder.`); continue; }
    args.push('-map', `0:${sub.index}`, `-c:s:${sk}`, box.subs === 'copy' ? 'copy' : box.subs);
    if (sub.lang) args.push(`-metadata:s:s:${sk}`, `language=${sub.lang}`);
    sk++;
  }
  ext.forEach((p, k) => {
    args.push('-map', `${k + 1}:0`, `-c:s:${sk}`, box.subs === 'copy' ? 'srt' : box.subs);
    args.push(`-metadata:s:s:${sk}`, `title=${path.parse(p).name}`);
    sk++;
  });
  if (!sk) args.push('-sn');

  args.push('-map_chapters', s.chapters === false ? '-1' : '0');
  args.push('-map_metadata', s.metadata === false ? '-1' : '0');
  if (s.format === 'mp4' || s.format === 'mov') args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error', output);
  return { args, output, warnings, duration };
}

/* ---------- Encodage ---------- */

function outputDir(file, output) {
  if (output && output.mode === 'custom' && output.dir) return output.dir;
  return path.join(path.dirname(file), 'converti');
}
async function uniquePath(p) {
  for (let i = 0; ; i++) {
    const c = i ? p.replace(/(\.[^.]+)$/, `-${i}$1`) : p;
    try { await fsp.access(c); } catch { return c; }
  }
}

const jobs = new Map(); // fichier → processus en cours

/**
 * Encode un fichier. onProgress({ ratio, speed, eta }) est appelé environ deux fois par seconde.
 */
async function encode(file, s, per, { output, onProgress } = {}) {
  const info = per.info || await probe(file);
  const box = CONTAINERS[s.format] || CONTAINERS.mp4;
  const dir = outputDir(file, output);
  await fsp.mkdir(dir, { recursive: true });
  const name = path.parse(file).name;
  const target = await uniquePath(path.join(dir, `${name}.${box.ext}`));
  const { args, warnings, duration } = buildArgs(file, info, s, per, target);
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    jobs.set(file, child);
    let err = '', buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const blocks = buf.split('progress=');
      buf = blocks.pop();
      for (const b of blocks) {
        const t = b.match(/out_time_us=(\d+)/);
        const sp = b.match(/speed=\s*([\d.]+)x/);
        if (!t) continue;
        const ratio = Math.min(1, +t[1] / 1e6 / duration);
        const elapsed = (Date.now() - started) / 1000;
        onProgress && onProgress({ ratio, speed: sp ? +sp[1] : null, eta: ratio > 0.02 ? Math.round(elapsed / ratio - elapsed) : null });
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code, signal) => {
      jobs.delete(file);
      if (signal) reject(Object.assign(new Error('Conversion annulée'), { cancelled: true }));
      else if (code) reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `ffmpeg a échoué (${code})`));
      else resolve();
    });
  }).catch(async (e) => { await fsp.rm(target, { force: true }); throw e; });
  const size = (await fsp.stat(target)).size;
  return { input: file, output: target, inSize: info.size, outSize: size, warnings, seconds: Math.round((Date.now() - started) / 1000) };
}

function cancel(file) {
  const child = file ? jobs.get(file) : null;
  const list = child ? [child] : [...jobs.values()];
  list.forEach((c) => c.kill('SIGKILL'));
  return list.length;
}

// Image fixe à un instant donné, avec rognage, rotation, réduction et filtres appliqués
async function frame(file, info, s, at = null, maxWidth = 1280) {
  const t = at == null ? info.duration * 0.25 : at;
  const f = info.video ? videoFilters(info, s, { preview: true }) : [];
  f.push(`scale='min(${maxWidth},iw)':-2`);
  const { stdout, err } = await run(['-hide_banner', '-ss', String(Math.max(0, t)), '-i', file, '-map', `0:${info.video.index}`, '-frames:v', '1', '-vf', f.join(','), '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'], { timeout: 20000 });
  if (err && !stdout.length) throw new Error('Image impossible à extraire');
  return `data:image/jpeg;base64,${stdout.toString('base64')}`;
}

// Estimation grossière du poids de sortie (mode débit ou taille cible seulement)
function estimate(info, s, per = {}) {
  const start = toSeconds(per.trim?.start) || 0, end = toSeconds(per.trim?.end) || info.duration;
  const duration = Math.max(0.1, end - start);
  if (s.video.mode === 'size') return Math.round(+s.video.size * 1024 * 1024);
  if (s.video.mode !== 'bitrate') return null;
  const n = (per.audio || info.audio.map((a) => a.n)).length;
  const audio = n * audioBitrateFor(s.audio.codec, s, LAYOUT[s.audio.mix] || 2);
  return Math.round(((+s.video.bitrate + audio) * 1000 / 8) * duration);
}

module.exports = { VIDEO_EXTS, isVideo, setFfmpegPath, probe, detectCrop, buildArgs, outputSize, encode, cancel, frame, estimate, CONTAINERS, toSeconds };
