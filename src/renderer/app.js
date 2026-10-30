const $ = (id) => document.getElementById(id);

const PRESETS = {
  web: { format: 'webp', quality: 80, resize: { mode: 'max', width: 1920, height: '' }, keepMetadata: false },
  mail: { format: 'jpeg', quality: 72, resize: { mode: 'max', width: 1280, height: '' }, keepMetadata: false },
  max: { format: 'jpeg', quality: 95, resize: { mode: 'none' }, keepMetadata: true },
};

const FORMAT_HINTS = {
  jpeg: 'Lisible partout. Pas de transparence : le fond devient blanc.',
  png: 'Garde la transparence. Sous 100, les couleurs sont réduites pour alléger.',
  webp: 'Très léger et lu par tous les navigateurs. Idéal pour un site.',
  avif: 'Le plus léger, mais un peu plus long à créer.',
  tiff: 'Pour l\'impression et l\'archivage. Fichiers lourds.',
};

const DEFAULTS = {
  format: 'webp', quality: 80,
  resize: { mode: 'none', width: 1920, height: '', percent: 50 },
  keepMetadata: false,
  rename: { enabled: false, base: 'photo', start: 1 },
  output: { mode: 'subfolder', dir: '' },
  preset: null,
  denoise: { strength: 55, color: 60, detail: 30, format: 'same' },
  edit: { ratio: 'free', format: 'same' },
};

const DENOISE_LEVELS = {
  light: { strength: 30, color: 45, detail: 50 },
  medium: { strength: 55, color: 60, detail: 30 },
  strong: { strength: 80, color: 85, detail: 15 },
};

let prefs = { theme: 'system', output: { mode: 'subfolder', dir: '' }, ...readJSON('mue.prefs', {}) };
let userPresets = readJSON('mue.presets', []);
let settings = load();
settings.output = { ...prefs.output }; // chaque lancement repart du dossier par défaut
api.setTheme(prefs.theme);
let items = []; // { path, name, size, thumb, width, height, status: 'idle'|'busy'|'done'|'error', result, error }
let selected = null;
let tab = 'convert'; // 'convert', 'denoise' ou 'crop'
let previewZone = '0.5,0.5';
let running = false;
let lastOutput = null;

/* ---------- Préférences de l'app et préréglages personnels ---------- */

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}


function load() {
  try {
    const s = JSON.parse(localStorage.getItem('mue.settings'));
    if (s) return { ...DEFAULTS, ...s, resize: { ...DEFAULTS.resize, ...s.resize }, rename: { ...DEFAULTS.rename, ...s.rename }, output: { ...DEFAULTS.output, ...s.output }, denoise: { ...DEFAULTS.denoise, ...s.denoise }, edit: { ...DEFAULTS.edit, ...s.edit } };
  } catch {}
  return structuredClone(DEFAULTS);
}
function save() {
  try { localStorage.setItem('mue.settings', JSON.stringify(settings)); } catch {}
}

const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return `${b} o`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} Ko`;
  if (b < 1024 ** 3) return `${nf1.format(b / 1024 / 1024)} Mo`;
  return `${nf1.format(b / 1024 ** 3)} Go`;
}
function fmtGain(before, after) {
  const pct = Math.round((after / before - 1) * 100);
  return { text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`, up: pct > 0 };
}
const basename = (p) => p.split(/[\\/]/).pop();
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Réglages ---------- */

function bindSeg(id, get, set, { silent = false } = {}) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    set(b.dataset.v);
    if (silent) render(); else changed();
  });
  return () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
}

const renderFormat = bindSeg('format', () => settings.format, (v) => (settings.format = v));
const renderResize = bindSeg('resizeMode', () => settings.resize.mode, (v) => (settings.resize.mode = v));
const renderOut = bindSeg('outMode', () => settings.output.mode, async (v) => {
  if (v === 'custom') {
    const dir = await api.pickDir();
    if (dir) { settings.output = { mode: 'custom', dir }; changed(); }
    return;
  }
  settings.output.mode = 'subfolder';
});

function changed({ keepPreset = false } = {}) {
  if (!keepPreset) settings.preset = null;
  save();
  scheduleEstimates();
  render();
}

/* ---------- Estimation du poids de sortie ---------- */

// Une estimation n'est valable que pour les réglages avec lesquels elle a été calculée
const estimateKey = () => JSON.stringify([settings.format, settings.quality, buildOptions().resize, settings.keepMetadata]);
const currentEstimate = (it) => (it.est && it.est.key === estimateKey() ? it.est : null);

let estimateTimer = null;
let estimateRun = 0;
function scheduleEstimates() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(runEstimates, 300);
}
async function runEstimates() {
  const run = ++estimateRun;
  const key = estimateKey();
  const opts = buildOptions();
  const queue = items.filter((i) => i.status === 'idle' && !(i.est && i.est.key === key));
  const worker = async () => {
    while (queue.length && run === estimateRun) {
      const it = queue.shift();
      const res = await api.estimate(it.path, opts);
      if (run !== estimateRun || res.error) continue;
      it.est = { key, bytes: res.bytes, width: res.width, height: res.height };
      if (tab === 'convert') { updateRow(it); renderShed(); }
    }
  };
  await Promise.all([worker(), worker()]);
}

$('quality').addEventListener('input', (e) => { settings.quality = +e.target.value; changed(); });
$('maxW').addEventListener('input', (e) => { settings.resize.width = e.target.value; changed(); });
$('maxH').addEventListener('input', (e) => { settings.resize.height = e.target.value; changed(); });
$('percent').addEventListener('input', (e) => { settings.resize.percent = e.target.value; changed(); });
$('percentChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { settings.resize.percent = +b.dataset.v; changed(); }
});
$('keepMeta').addEventListener('change', (e) => { settings.keepMetadata = e.target.checked; changed(); });
$('renameOn').addEventListener('change', (e) => { settings.rename.enabled = e.target.checked; changed(); });
$('renameBase').addEventListener('input', (e) => { settings.rename.base = e.target.value; changed(); });
$('renameStart').addEventListener('input', (e) => { settings.rename.start = +e.target.value || 0; changed(); });

$('presets').addEventListener('click', (e) => {
  const del = e.target.closest('.del');
  if (del) {
    e.stopPropagation();
    deletePreset(del.dataset.id);
    return;
  }
  const b = e.target.closest('[data-preset]');
  if (!b) return;
  const id = b.dataset.preset;
  const p = PRESETS[id] || userPresets.find((u) => u.id === id)?.values;
  if (!p) return;
  settings.format = p.format;
  settings.quality = p.quality;
  settings.resize = { ...settings.resize, ...p.resize };
  settings.keepMetadata = p.keepMetadata;
  if (p.rename) settings.rename = { ...p.rename };
  settings.preset = id;
  if (tab !== 'convert' && !running) { tab = 'convert'; items.forEach((i) => { if (i.status !== 'busy') { i.status = 'idle'; i.result = null; } }); }
  changed({ keepPreset: true });
});

function renderUserPresets() {
  $('userPresets').innerHTML = userPresets.map((u) => `<button class="it preset" data-preset="${u.id}">
    <span>${esc(u.name)}</span><span class="del" data-id="${u.id}" title="Supprimer ce préréglage">
    <svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span></button>`).join('');
  const list = $('presetList');
  list.innerHTML = userPresets.length
    ? userPresets.map((u) => `<li><span>${esc(u.name)} <small>${u.values.format.toUpperCase()}, qualité ${u.values.quality}</small></span><button data-id="${u.id}">Supprimer</button></li>`).join('')
    : '<li class="empty-note">Aucun pour l\'instant. Règle l\'app comme tu veux puis clique sur « Nouveau préréglage » dans la barre latérale.</li>';
}

function deletePreset(id) {
  userPresets = userPresets.filter((u) => u.id !== id);
  writeJSON('mue.presets', userPresets);
  if (settings.preset === id) settings.preset = null;
  render();
}

$('presetList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) deletePreset(b.dataset.id);
});

$('savePresetBtn').addEventListener('click', () => {
  $('savePresetBtn').hidden = true;
  $('presetForm').hidden = false;
  $('presetName').value = '';
  $('presetName').focus();
});
function closePresetForm() {
  $('presetForm').hidden = true;
  $('savePresetBtn').hidden = false;
}
$('presetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('presetName').value.trim();
  if (!name) return closePresetForm();
  const id = `u${Date.now()}`;
  userPresets.push({ id, name, values: {
    format: settings.format, quality: settings.quality, resize: { ...settings.resize },
    keepMetadata: settings.keepMetadata, rename: { ...settings.rename },
  } });
  writeJSON('mue.presets', userPresets);
  settings.preset = id;
  closePresetForm();
  changed({ keepPreset: true });
});
$('presetName').addEventListener('keydown', (e) => { if (e.key === 'Escape') closePresetForm(); });
$('presetName').addEventListener('blur', () => setTimeout(closePresetForm, 100));

/* ---------- Fenêtre de réglages ---------- */

const renderTheme = bindSeg('themeMode', () => prefs.theme, (v) => {
  prefs.theme = v;
  writeJSON('mue.prefs', prefs);
  api.setTheme(v);
}, { silent: true });
const renderDefaultOut = bindSeg('defaultOut', () => prefs.output.mode, async (v) => {
  if (v === 'custom') {
    const dir = await api.pickDir();
    if (!dir) return;
    prefs.output = { mode: 'custom', dir };
  } else {
    prefs.output = { mode: 'subfolder', dir: '' };
  }
  writeJSON('mue.prefs', prefs);
  settings.output = { ...prefs.output };
  changed({ keepPreset: true });
}, { silent: true });

function renderPrefs() {
  renderTheme();
  renderDefaultOut();
  $('defaultOutHint').textContent = prefs.output.mode === 'custom'
    ? prefs.output.dir.replace(/^\/Users\/[^/]+/, '~')
    : 'Dans un dossier « converti » à côté de chaque image.';
}

api.appVersion().then((v) => { $('appVersion').textContent = `Mue ${v}`; });
const openSheet = () => { renderPrefs(); $('sheet').hidden = false; $('sheetClose').focus(); };
const closeSheet = () => { $('sheet').hidden = true; };
$('settingsBtn').addEventListener('click', openSheet);
$('sheetClose').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
  if (e.key === ',' && e.metaKey) { e.preventDefault(); openSheet(); }
});

function setIfIdle(el, v) {
  if (document.activeElement !== el) el.value = v;
}

function renderSettings() {
  renderFormat();
  renderResize();
  renderOut();
  $('formatHint').textContent = FORMAT_HINTS[settings.format];
  $('quality').value = settings.quality;
  $('quality').style.setProperty('--fill', `${settings.quality}%`);
  $('qualityValue').textContent = settings.quality;
  $('resizeMax').hidden = settings.resize.mode !== 'max';
  $('resizePercent').hidden = settings.resize.mode !== 'percent';
  setIfIdle($('maxW'), settings.resize.width || '');
  setIfIdle($('maxH'), settings.resize.height || '');
  setIfIdle($('percent'), settings.resize.percent);
  document.querySelectorAll('#percentChips button').forEach((b) => b.classList.toggle('on', +b.dataset.v === +settings.resize.percent));
  $('keepMeta').checked = settings.keepMetadata;
  $('renameOn').checked = settings.rename.enabled;
  $('renameFields').hidden = !settings.rename.enabled;
  setIfIdle($('renameBase'), settings.rename.base);
  setIfIdle($('renameStart'), settings.rename.start);
  const base = (settings.rename.base || 'photo').trim() || 'photo';
  const n = settings.rename.start;
  $('renameExample').textContent = `${base}-${String(n).padStart(3, '0')}, ${base}-${String(n + 1).padStart(3, '0')}…`;
  $('outHint').textContent = settings.output.mode === 'custom' && settings.output.dir
    ? settings.output.dir.replace(/^\/Users\/[^/]+/, '~')
    : 'Dans un dossier « converti » à côté de chaque image. Les originaux ne sont jamais modifiés.';
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === settings.preset));
}

/* ---------- Liste ---------- */

async function addPaths(paths) {
  const found = await api.expand(paths);
  addFound(found);
}

function addFound(found) {
  const known = new Set(items.map((i) => i.path));
  const fresh = found.filter((f) => !known.has(f.path)).map((f) => ({ ...f, name: basename(f.path), status: 'idle' }));
  if (!fresh.length) return;
  // Une nouvelle série remet à zéro les résultats précédents
  if (items.every((i) => i.status === 'done' || i.status === 'error') && items.length) {
    items.forEach((i) => { i.status = 'idle'; i.result = null; i.error = null; });
  }
  items.push(...fresh);
  lastOutput = null;
  render();
  scheduleEstimates();
  if (tab === 'denoise') schedulePreview();
  if (tab === 'crop') loadEditor();
  loadThumbs(fresh);
}

// Miniatures chargées 3 par 3 pour ne pas saturer la machine
async function loadThumbs(list) {
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      const info = await api.inspect(it.path);
      if (!info.error) Object.assign(it, info);
      updateRow(it);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function rowHtml(it) {
  let size = fmtSize(it.size);
  let gain = '<span class="wait">en attente</span>';
  const est = currentEstimate(it);
  if (tab === 'convert' && it.status === 'idle') {
    if (est) {
      const g = fmtGain(it.size, est.bytes);
      size = `<span class="est">${fmtSize(it.size)} → <b>≈ ${fmtSize(est.bytes)}</b></span>`;
      gain = `<span class="gain soft${g.up ? ' up' : ''}" title="Estimation">≈ ${g.text}</span>`;
    } else {
      gain = '<span class="wait">estimation…</span>';
    }
  }
  if (tab === 'crop' && it.status === 'idle') gain = isEdited(it.edit) ? '<span class="edited">retouchée</span>' : '<span class="wait">—</span>';
  if (it.status === 'busy') gain = '<span class="prog"><i></i></span>';
  if (it.status === 'done' && it.result.op !== 'convert') {
    size = fmtSize(it.result.outSize);
    gain = `<span class="gain">${it.result.op === 'crop' ? 'enregistrée' : 'débruitée'}</span>`;
  } else if (it.status === 'done') {
    const g = fmtGain(it.size, it.result.outSize);
    size = `<s>${fmtSize(it.size)}</s>${fmtSize(it.result.outSize)}`;
    gain = `<span class="gain${g.up ? ' up' : ''}">${g.text}</span>`;
  }
  if (it.status === 'error') gain = `<span class="err" title="${esc(it.error)}">échec</span>`;
  let dims = it.status === 'done' ? `${it.result.width} × ${it.result.height}` : it.width ? `${it.width} × ${it.height}` : '';
  if (est && it.status === 'idle' && tab === 'convert' && it.width && (est.width !== it.width || est.height !== it.height)) {
    dims = `<span class="est" title="Taille d'origine : ${it.width} × ${it.height}"><b>${est.width} × ${est.height}</b></span>`;
  }
  const thumb = it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : '<span class="thumb"></span>';
  return `<td><div class="name">${thumb}<span title="${esc(it.path)}">${esc(it.name)}</span></div></td>
    <td>${dims}</td><td class="r">${size}</td><td class="r">${gain}</td>
    <td><button class="x" title="Retirer de la liste" aria-label="Retirer ${esc(it.name)}"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></td>`;
}

function updateRow(it) {
  const tr = document.querySelector(`tr[data-path="${CSS.escape(it.path)}"]`);
  if (tr) tr.innerHTML = rowHtml(it);
}

function renderRows() {
  const tbody = $('rows');
  const existing = new Map([...tbody.children].map((tr) => [tr.dataset.path, tr]));
  const frag = document.createDocumentFragment();
  for (const it of items) {
    let tr = existing.get(it.path);
    if (!tr) { tr = document.createElement('tr'); tr.dataset.path = it.path; }
    tr.innerHTML = rowHtml(it);
    tr.classList.toggle('sel', it.path === selected);
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
}

$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  if (e.target.closest('.x')) {
    if (running) return;
    items = items.filter((i) => i.path !== tr.dataset.path);
    render();
    return;
  }
  selected = tr.dataset.path;
  document.querySelectorAll('#rows tr').forEach((r) => r.classList.toggle('sel', r === tr));
  if (tab === 'denoise') schedulePreview();
  if (tab === 'crop') loadEditor();
});
$('rows').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  const it = tr && items.find((i) => i.path === tr.dataset.path);
  if (it) api.reveal(it.status === 'done' ? it.result.output : it.path);
});

/* ---------- Jauge et bouton ---------- */

function renderShed() {
  const total = items.reduce((s, i) => s + i.size, 0);
  const done = items.filter((i) => i.status === 'done');
  const pending = items.filter((i) => i.status !== 'done').length;
  const skin = $('skin');
  if (!items.length) {
    $('before').textContent = 'Aucune image';
    $('after').textContent = '';
    $('skinNew').style.width = '100%';
    skin.classList.remove('done');
  } else if (done.length) {
    const inSum = done.reduce((s, i) => s + i.size, 0);
    const outSum = done.reduce((s, i) => s + i.result.outSize, 0);
    $('before').textContent = `${fmtSize(inSum)} avant`;
    $('after').textContent = fmtSize(outSum);
    $('skinNew').style.width = `${Math.max(2, Math.min(100, (outSum / inSum) * 100))}%`;
    skin.classList.add('done');
  } else {
    const ests = items.map(currentEstimate);
    skin.classList.remove('done');
    if (ests.every(Boolean)) {
      const outSum = ests.reduce((s, e) => s + e.bytes, 0);
      $('before').textContent = `${fmtSize(total)} avant`;
      $('after').textContent = `≈ ${fmtSize(outSum)}`;
      $('skinNew').style.width = `${Math.max(2, Math.min(100, (outSum / total) * 100))}%`;
      skin.classList.add('est');
    } else {
      $('before').textContent = `${items.length} image${items.length > 1 ? 's' : ''}, ${fmtSize(total)}`;
      $('after').textContent = '…';
      $('skinNew').style.width = '100%';
    }
  }
  if (done.length) skin.classList.remove('est');
  $('skin').hidden = tab !== 'convert';
  $('before').parentElement.hidden = tab !== 'convert';
  const btn = $('convertBtn');
  if (tab === 'crop') {
    const n = items.filter((i) => isEdited(i.edit) && i.status !== 'done').length;
    if (running) {
      btn.textContent = 'Enregistrement…';
      btn.disabled = true;
    } else {
      btn.textContent = n ? `Enregistrer ${n} image${n > 1 ? 's' : ''} retouchée${n > 1 ? 's' : ''}` : 'Aucune retouche à enregistrer';
      btn.disabled = !n;
    }
    $('revealBtn').hidden = running || !lastOutput;
    return;
  }
  const verb = tab === 'denoise' ? 'Réduire le bruit' : 'Convertir';
  if (running) {
    const n = items.filter((i) => i.status === 'done' || i.status === 'error').length;
    btn.textContent = `${tab === 'denoise' ? 'Réduction du bruit' : 'Conversion'}… ${n} / ${items.length}`;
    btn.disabled = true;
  } else {
    const n = pending || items.length;
    const what = tab === 'denoise' ? ` de ${n} image${n > 1 ? 's' : ''}` : ` ${n} image${n > 1 ? 's' : ''}`;
    btn.textContent = items.length ? (pending ? verb + what : `${verb} à nouveau`) : verb;
    btn.disabled = !items.length;
  }
  $('revealBtn').hidden = running || !lastOutput;
}

function render() {
  const has = items.length > 0;
  $('empty').hidden = has;
  $('tblWrap').hidden = !has;
  $('clearBtn').hidden = !has || running;
  $('count').textContent = has ? `${items.length} fichier${items.length > 1 ? 's' : ''}` : '';
  renderSettings();
  renderDenoise();
  renderUserPresets();
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === settings.preset));
  if (!$('sheet').hidden) renderPrefs();
  renderRows();
  renderShed();
  const isDn = tab === 'denoise', isCrop = tab === 'crop';
  $('card').classList.toggle('denoise', isDn);
  $('card').classList.toggle('cropping', isCrop);
  $('gainHead').textContent = tab === 'convert' ? 'Gain' : 'État';
  $('preview').hidden = !isDn || !has;
  $('editor').hidden = !isCrop || !has;
  $('inspConvert').hidden = tab !== 'convert';
  $('inspDenoise').hidden = !isDn;
  $('inspCrop').hidden = !isCrop;
  renderCropPanel();
}

function buildOptions() {
  const r = settings.resize;
  return {
    format: settings.format,
    quality: settings.quality,
    resize: r.mode === 'max' ? { mode: 'max', width: +r.width || null, height: +r.height || null }
      : r.mode === 'percent' ? { mode: 'percent', percent: +r.percent || 100 } : { mode: 'none' },
    keepMetadata: settings.keepMetadata,
    rename: settings.rename,
    output: settings.output,
  };
}

$('convertBtn').addEventListener('click', async () => {
  if (running || !items.length) return;
  // Si tout est déjà converti, on recommence avec les réglages actuels
  if (tab !== 'crop' && items.every((i) => i.status === 'done' || i.status === 'error')) items.forEach((i) => { i.status = 'idle'; i.result = null; });
  const batch = items.filter((i) => i.status !== 'done' && (tab !== 'crop' || isEdited(i.edit)));
  if (!batch.length) return;
  batch.forEach((i) => { i.status = 'busy'; i.error = null; });
  running = true;
  lastOutput = null;
  render();
  try {
    if (tab === 'denoise') await api.denoise(batch.map((i) => i.path), buildDenoiseOptions());
    else if (tab === 'crop') await api.edit(batch.map((i) => i.path), buildEditOptions(batch));
    else await api.convert(batch.map((i) => i.path), buildOptions());
  } finally {
    running = false;
    render();
  }
});

api.onProgress((path, result) => {
  const it = items.find((i) => i.path === path);
  if (!it) return;
  if (result.ok) { it.status = 'done'; it.result = { ...result, op: tab }; lastOutput = result.output; }
  else { it.status = 'error'; it.error = result.error; }
  updateRow(it);
  renderShed();
});

$('revealBtn').addEventListener('click', () => lastOutput && api.reveal(lastOutput));

/* ---------- Réduction du bruit ---------- */

const renderTab = bindSeg('imgTab', () => tab, (v) => {
  if (running || v === tab) return;
  tab = v;
  // Un résultat appartient à une opération : on repart de zéro en changeant d'onglet
  items.forEach((i) => { if (i.status === 'done' || i.status === 'error') { i.status = 'idle'; i.result = null; } });
  lastOutput = null;
  if (tab === 'denoise') schedulePreview();
  else if (tab === 'crop') loadEditor();
  else scheduleEstimates();
}, { silent: true });

const renderDnLevel = bindSeg('dnLevel', () => {
  const d = settings.denoise;
  return Object.keys(DENOISE_LEVELS).find((k) => ['strength', 'color', 'detail'].every((f) => DENOISE_LEVELS[k][f] === d[f]));
}, (v) => { Object.assign(settings.denoise, DENOISE_LEVELS[v]); schedulePreview(); }, { silent: true });
const renderDnFormat = bindSeg('dnFormat', () => settings.denoise.format, (v) => { settings.denoise.format = v; }, { silent: true });

for (const [id, key] of [['dnStrength', 'strength'], ['dnColor', 'color'], ['dnDetail', 'detail']]) {
  $(id).addEventListener('input', (e) => {
    settings.denoise[key] = +e.target.value;
    save();
    renderDenoise();
    schedulePreview();
  });
}

function renderDenoise() {
  renderTab();
  renderDnLevel();
  renderDnFormat();
  const d = settings.denoise;
  for (const [id, key] of [['dnStrength', 'strength'], ['dnColor', 'color'], ['dnDetail', 'detail']]) {
    $(id).value = d[key];
    $(id).style.setProperty('--fill', `${d[key]}%`);
    $(id + 'V').textContent = d[key];
  }
  document.querySelectorAll('#pvZones button').forEach((b) => b.classList.toggle('on', b.dataset.v === previewZone));
  save();
}

function buildDenoiseOptions() {
  const d = settings.denoise;
  return { strength: d.strength, color: d.color, detail: d.detail, format: d.format, quality: 92, rename: settings.rename, output: settings.output };
}

// L'aperçu n'est recalculé qu'une fois que l'on arrête de bouger les curseurs
let previewTimer = null;
let previewSeq = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 180);
}
async function updatePreview() {
  if (tab !== 'denoise') return;
  const it = items.find((i) => i.path === selected) || items[0];
  const cmp = $('cmp');
  if (!it) { $('pvNote').hidden = false; return; }
  const seq = ++previewSeq;
  const box = cmp.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const [cx, cy] = previewZone.split(',').map(Number);
  cmp.classList.add('loading');
  const res = await api.denoisePreview(it.path, buildDenoiseOptions(), {
    width: Math.round(Math.min(box.width * dpr, 1600)), height: Math.round(Math.min(box.height * dpr, 1100)), cx, cy,
  });
  if (seq !== previewSeq) return;
  cmp.classList.remove('loading');
  if (res.error) { $('pvNote').hidden = false; $('pvNote').textContent = 'Aperçu impossible pour cette image.'; return; }
  $('pvNote').hidden = true;
  $('pvBefore').src = res.before;
  $('pvAfter').src = res.after;
}

$('pvSplit').addEventListener('input', (e) => $('cmp').style.setProperty('--split', `${e.target.value}%`));
$('pvZones').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  previewZone = b.dataset.v;
  renderDenoise();
  schedulePreview();
});
window.addEventListener('resize', () => {
  if (tab === 'denoise') schedulePreview();
  if (tab === 'crop') layoutEditor();
});

/* ---------- Recadrer, pivoter, redresser ---------- */

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const RATIOS = { '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '4:5': 4 / 5 };
const newEdit = () => ({ quarter: 0, flipH: false, flipV: false, angle: 0, crop: { ...FULL } });
const isEdited = (e) => !!e && (e.quarter || e.flipH || e.flipV || e.angle || e.crop.x > 0.001 || e.crop.y > 0.001 || e.crop.w < 0.999 || e.crop.h < 0.999);

let editorItem = null;
let base = null; // { url, width, height, key }
let portrait = false; // proportions retournées (ex. 3:4 au lieu de 4:3)

const curItem = () => items.find((i) => i.path === selected) || items[0];
function innerScale(w, h, deg) {
  const t = (Math.abs(deg) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}

// Proportion cible du cadre, en largeur / hauteur réelles (null = libre)
function targetRatio() {
  const r = settings.edit.ratio;
  if (r === 'free' || !base) return null;
  let v = r === 'orig' ? base.width / base.height : RATIOS[r];
  if (r !== 'orig' && portrait !== (v < 1)) v = 1 / v;
  return v;
}

// Plus grand cadre centré de la proportion voulue
function fitCrop(ratio) {
  if (!ratio || !base) return { ...FULL };
  const imgRatio = base.width / base.height;
  let w = 1, h = imgRatio / ratio;
  if (h > 1) { h = 1; w = ratio / imgRatio; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

async function loadEditor() {
  const it = curItem();
  if (!it) return;
  if (!it.edit) it.edit = newEdit();
  editorItem = it;
  selected = it.path;
  document.querySelectorAll('#rows tr').forEach((r) => r.classList.toggle('sel', r.dataset.path === it.path));
  const e = it.edit;
  const key = `${it.path}|${e.quarter}|${e.flipH}|${e.flipV}`;
  if (!base || base.key !== key) {
    $('edNote').hidden = false;
    $('edNote').textContent = 'Chargement…';
    $('frameImg').hidden = true;
    const res = await api.editBase(it.path, e);
    if (editorItem !== it) return;
    if (res.error) { $('edNote').textContent = 'Impossible d\'ouvrir cette image.'; return; }
    base = { ...res, key };
    $('edImg').src = res.url;
  }
  $('edNote').hidden = true;
  $('frameImg').hidden = false;
  layoutEditor();
  renderCropPanel();
}

// Taille du cadre d'affichage : l'image entière, ajustée à la scène
function layoutEditor() {
  if (!base || !editorItem) return;
  const st = $('stage').getBoundingClientRect();
  const pad = 24;
  const k = Math.min((st.width - pad * 2) / base.width, (st.height - pad * 2) / base.height);
  const fi = $('frameImg');
  fi.style.width = `${Math.max(40, base.width * k)}px`;
  fi.style.height = `${Math.max(40, base.height * k)}px`;
  drawEditor();
}

function drawEditor() {
  const e = editorItem && editorItem.edit;
  if (!e || !base) return;
  const s = 1 / innerScale(base.width, base.height, e.angle);
  $('edImg').style.transform = `rotate(${e.angle}deg) scale(${s})`;
  const c = e.crop, box = $('cropBox').style;
  box.left = `${c.x * 100}%`; box.top = `${c.y * 100}%`;
  box.width = `${c.w * 100}%`; box.height = `${c.h * 100}%`;
}

function editChanged({ row = true } = {}) {
  drawEditor();
  renderCropPanel();
  if (row && editorItem) updateRow(editorItem);
  renderShed();
}

// Déplacer et redimensionner le cadre
(() => {
  let drag = null;
  $('cropBox').addEventListener('pointerdown', (ev) => {
    if (!editorItem) return;
    ev.preventDefault();
    const handle = ev.target.dataset.h || 'move';
    const r = $('frameImg').getBoundingClientRect();
    drag = { handle, r, start: { ...editorItem.edit.crop }, x0: ev.clientX, y0: ev.clientY };
    $('cropBox').classList.add('dragging');
    $('cropBox').setPointerCapture(ev.pointerId);
  });
  $('cropBox').addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const { handle, r, start } = drag;
    const dx = (ev.clientX - drag.x0) / r.width, dy = (ev.clientY - drag.y0) / r.height;
    const MIN = 0.04;
    let { x, y, w, h } = start;
    if (handle === 'move') {
      x = Math.min(Math.max(start.x + dx, 0), 1 - w);
      y = Math.min(Math.max(start.y + dy, 0), 1 - h);
    } else {
      let x1 = x, y1 = y, x2 = x + w, y2 = y + h;
      if (handle.includes('w')) x1 = Math.min(Math.max(start.x + dx, 0), x2 - MIN);
      if (handle.includes('e')) x2 = Math.max(Math.min(start.x + start.w + dx, 1), x1 + MIN);
      if (handle.includes('n')) y1 = Math.min(Math.max(start.y + dy, 0), y2 - MIN);
      if (handle.includes('s')) y2 = Math.max(Math.min(start.y + start.h + dy, 1), y1 + MIN);
      x = x1; y = y1; w = x2 - x1; h = y2 - y1;
      const ratio = targetRatio();
      if (ratio) {
        // On garde la proportion : la dimension tirée commande l'autre, ancrée sur le côté opposé
        // Unités normalisées → proportions réelles : on passe par la taille affichée du cadre
        const vertical = handle === 'n' || handle === 's';
        if (vertical) w = (h * r.height * ratio) / r.width; else h = (w * r.width) / ratio / r.height;
        // Si ça déborde, on réduit les deux dimensions
        const ax = handle.includes('w') ? start.x + start.w : handle.includes('e') ? start.x : start.x + start.w / 2;
        const ay = handle.includes('n') ? start.y + start.h : handle.includes('s') ? start.y : start.y + start.h / 2;
        const maxW = handle.includes('w') ? ax : handle.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
        const maxH = handle.includes('n') ? ay : handle.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
        const f = Math.min(1, maxW / w, maxH / h);
        w *= f; h *= f;
        x = handle.includes('w') ? ax - w : handle.includes('e') ? ax : ax - w / 2;
        y = handle.includes('n') ? ay - h : handle.includes('s') ? ay : ay - h / 2;
      }
    }
    editorItem.edit.crop = { x, y, w, h };
    editChanged({ row: false });
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    $('cropBox').classList.remove('dragging');
    if (editorItem) updateRow(editorItem);
  };
  $('cropBox').addEventListener('pointerup', end);
  $('cropBox').addEventListener('pointercancel', end);
})();

$('edRatio').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-v]');
  if (!b) return;
  settings.edit.ratio = b.dataset.v;
  save();
  if (editorItem) { editorItem.edit.crop = fitCrop(targetRatio()); editChanged(); }
  renderCropPanel();
});
$('edSwap').addEventListener('click', () => {
  portrait = !portrait;
  if (editorItem && targetRatio()) { editorItem.edit.crop = fitCrop(targetRatio()); editChanged(); }
});

$('edTools').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-a]');
  if (!b || !editorItem) return;
  const e = editorItem.edit;
  if (b.dataset.a === 'left') e.quarter = (e.quarter + 3) % 4;
  if (b.dataset.a === 'right') e.quarter = (e.quarter + 1) % 4;
  if (b.dataset.a === 'flipH') e.flipH = !e.flipH;
  if (b.dataset.a === 'flipV') e.flipV = !e.flipV;
  // L'image change de forme : on repart d'un cadre plein (ou de la proportion choisie)
  e.crop = { ...FULL };
  e.angle = b.dataset.a.startsWith('flip') ? -e.angle : e.angle;
  updateRow(editorItem);
  loadEditor().then(() => { e.crop = fitCrop(targetRatio()); editChanged(); });
});

$('edAngle').addEventListener('input', (ev) => {
  if (!editorItem) return;
  editorItem.edit.angle = +ev.target.value;
  $('frameImg').classList.add('tilting');
  editChanged({ row: false });
});
$('edAngle').addEventListener('change', () => { $('frameImg').classList.remove('tilting'); editorItem && updateRow(editorItem); });
$('edAngleZero').addEventListener('click', () => { if (editorItem) { editorItem.edit.angle = 0; editChanged(); } });

async function autoLevelItem(it) {
  if (!it.edit) it.edit = newEdit();
  const angle = await api.autoLevel(it.path, it.edit);
  it.edit.angle = Math.max(-20, Math.min(20, angle || 0));
  return angle;
}
$('edAuto').addEventListener('click', async () => {
  if (!editorItem) return;
  $('edAuto').disabled = true;
  $('edAutoHint').textContent = 'Analyse de l\'image…';
  const angle = await autoLevelItem(editorItem);
  $('edAuto').disabled = false;
  $('edAutoHint').textContent = angle
    ? `Image redressée de ${nf1.format(angle)}°. Ajuste avec le curseur si besoin.`
    : 'Aucune ligne nette trouvée : l\'image semble déjà droite.';
  editChanged();
});
$('edAutoAll').addEventListener('click', async () => {
  if (running || !items.length) return;
  const b = $('edAutoAll');
  b.disabled = true;
  let n = 0;
  for (const it of items) {
    b.textContent = `Analyse ${++n} / ${items.length}…`;
    await autoLevelItem(it);
    updateRow(it);
  }
  b.disabled = false;
  b.textContent = 'Redresser toutes les images';
  editChanged();
});
$('edReset').addEventListener('click', () => {
  if (!editorItem) return;
  editorItem.edit = newEdit();
  updateRow(editorItem);
  loadEditor().then(() => { editorItem.edit.crop = fitCrop(targetRatio()); editChanged(); });
});

const renderEdFormat = bindSeg('edFormat', () => settings.edit.format, (v) => { settings.edit.format = v; save(); }, { silent: true });

function renderCropPanel() {
  renderEdFormat();
  document.querySelectorAll('#edRatio button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.edit.ratio));
  $('edSwap').hidden = settings.edit.ratio === 'free' || settings.edit.ratio === 'orig' || settings.edit.ratio === '1:1';
  const a = editorItem && editorItem.edit ? editorItem.edit.angle : 0;
  if (document.activeElement !== $('edAngle')) $('edAngle').value = a;
  $('edAngle').style.setProperty('--fill', `${((a + 20) / 40) * 100}%`);
  $('edAngleV').textContent = `${nf1.format(a)}°`;
}

function buildEditOptions(batch) {
  const edits = {};
  for (const it of batch) edits[it.path] = it.edit;
  return { edits, format: settings.edit.format, quality: 92, rename: settings.rename, output: settings.output };
}

/* ---------- Ajout de fichiers ---------- */

const pick = async () => addFound(await api.pickFiles());
$('addBtn').addEventListener('click', pick);
$('emptyAddBtn').addEventListener('click', pick);
$('clearBtn').addEventListener('click', () => { items = []; selected = null; lastOutput = null; render(); });

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!hasFiles(e)) return;
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  if (document.body.dataset.space === 'pdf') window.pdfSpace.addPaths(paths);
  else if (document.body.dataset.space === 'video') window.videoSpace.addPaths(paths);
  else if (!running) addPaths(paths);
});

window.addEventListener('keydown', (e) => {
  if ((e.key === 'Backspace' || e.key === 'Delete') && selected && !running && !/INPUT/.test(document.activeElement.tagName)) {
    items = items.filter((i) => i.path !== selected);
    selected = null;
    render();
  }
});

/* ---------- Espaces ---------- */

const SPACES = {
  video: { title: 'Vidéo', text: 'Convertir et alléger tes vidéos, changer leur format ou leur taille.' },
};

document.querySelectorAll('.it[data-module]').forEach((b) => b.addEventListener('click', () => {
  const space = b.dataset.module;
  document.body.dataset.space = space;
  document.querySelectorAll('.it[data-module]').forEach((x) => x.classList.toggle('on', x === b));
  const isImages = space === 'images', isPdf = space === 'pdf', isVideo = space === 'video';
  $('videoCard').hidden = !isVideo;
  $('videoInsp').hidden = !isVideo;
  $('card').hidden = !isImages;
  $('insp').hidden = !isImages;
  $('pdfCard').hidden = !isPdf;
  $('pdfInsp').hidden = !isPdf;
  document.querySelectorAll('.images-only').forEach((el) => (el.hidden = !isImages));
  $('soonCard').hidden = isImages || isPdf || isVideo;
  if (!isImages && !isPdf && !isVideo) {
    $('soonTitle').textContent = SPACES[space].title;
    $('soonText').textContent = SPACES[space].text;
    $('soonMark').innerHTML = b.querySelector('svg').outerHTML;
  }
}));

render();
