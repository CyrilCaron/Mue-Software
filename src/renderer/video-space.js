// Espace Vidéo : liste de vidéos, aperçu image par image, réglages complets, file d'attente.
(() => {
  const DEFAULTS = {
    format: 'mp4',
    dims: { height: '1080', crop: 'auto', custom: { top: 0, bottom: 0, left: 0, right: 0 }, rotate: 0, flip: false },
    filters: { deinterlace: 'auto', denoise: 'off', sharpen: 'off', grayscale: false },
    video: { codec: 'h264', mode: 'quality', quality: 22, bitrate: 4000, size: 25, speed: 'medium', fps: 'same', fpsMode: 'cfr' },
    audio: { codec: 'aac', bitrate: 160, mix: 'same', normalize: false },
    chapters: true, metadata: true, subsDefault: true, preset: 'fast1080',
  };
  const PRESETS = [
    { id: 'fast1080', label: 'Rapide 1080p', s: { format: 'mp4', dims: { height: '1080' }, video: { codec: 'h264', mode: 'quality', quality: 22, speed: 'fast' }, audio: { codec: 'aac', bitrate: 160 } } },
    { id: 'hq1080', label: 'Très bonne qualité 1080p', s: { format: 'mp4', dims: { height: '1080' }, video: { codec: 'h264', mode: 'quality', quality: 20, speed: 'slow' }, audio: { codec: 'aac', bitrate: 192 } } },
    { id: 'web720', label: 'Léger 720p, pour le web', s: { format: 'mp4', dims: { height: '720' }, video: { codec: 'h264', mode: 'quality', quality: 24, speed: 'medium' }, audio: { codec: 'aac', bitrate: 128 } } },
    { id: 'hevc', label: 'H.265, petit fichier', s: { format: 'mp4', dims: { height: 'same' }, video: { codec: 'hevc', mode: 'quality', quality: 24, speed: 'medium' }, audio: { codec: 'aac', bitrate: 160 } } },
    { id: 'apple', label: 'Puce Apple, très rapide', s: { format: 'mp4', dims: { height: 'same' }, video: { codec: 'hevc_hw', mode: 'quality', quality: 22 }, audio: { codec: 'aac', bitrate: 160 } } },
    { id: 'mail', label: 'Moins de 25 Mo (e-mail, Discord)', s: { format: 'mp4', dims: { height: '720' }, video: { codec: 'h264', mode: 'size', size: 24, speed: 'medium' }, audio: { codec: 'aac', bitrate: 96, mix: 'stereo' } } },
    { id: 'webm', label: 'WebM pour le web', s: { format: 'webm', dims: { height: '1080' }, video: { codec: 'vp9', mode: 'quality', quality: 22, speed: 'medium' }, audio: { codec: 'opus', bitrate: 128 } } },
    { id: 'archive', label: 'Archive MKV, tout garder', s: { format: 'mkv', dims: { height: 'same', crop: 'none' }, video: { codec: 'hevc', mode: 'quality', quality: 20, speed: 'slow' }, audio: { codec: 'copy' }, chapters: true, metadata: true } },
    { id: 'prores', label: 'ProRes pour le montage', s: { format: 'mov', dims: { height: 'same', crop: 'none' }, video: { codec: 'prores' }, audio: { codec: 'aac', bitrate: 256 } } },
  ];
  const FORMAT_HINTS = {
    mp4: 'Le plus compatible : lu partout, sur le web comme sur les téléphones.',
    mkv: 'Garde toutes les pistes et tous les sous-titres. Idéal pour archiver.',
    webm: 'Pour le web, en VP9 ou AV1 avec du son Opus.',
    mov: 'Format Apple, pour le montage (ProRes).',
  };
  const CODEC_HINTS = {
    h264: 'Le plus compatible.',
    hevc: 'Environ deux fois plus léger que H.264 à qualité égale, mais plus lent.',
    av1: 'Le plus léger, mais lent à encoder et pas encore lu partout.',
    vp9: 'Pour le web, avec le format WebM.',
    h264_hw: 'Utilise la puce vidéo du Mac : très rapide, fichier un peu plus lourd.',
    hevc_hw: 'Utilise la puce vidéo du Mac : très rapide, fichier un peu plus lourd.',
    prores: 'Pour le montage. Fichiers très lourds.',
    copy: 'Garde la vidéo telle quelle, sans réencodage. Rognage, dimensions et filtres sont ignorés.',
  };
  const ALLOWED = {
    mp4: ['h264', 'hevc', 'av1', 'h264_hw', 'hevc_hw', 'copy'],
    mkv: ['h264', 'hevc', 'av1', 'vp9', 'h264_hw', 'hevc_hw', 'copy'],
    webm: ['vp9', 'av1'],
    mov: ['h264', 'hevc', 'prores', 'h264_hw', 'hevc_hw', 'copy'],
  };
  const AUDIO_ALLOWED = { mp4: ['aac', 'mp3', 'ac3', 'opus', 'flac', 'copy'], mkv: ['aac', 'opus', 'mp3', 'ac3', 'flac', 'copy'], webm: ['opus'], mov: ['aac', 'flac', 'copy'] };

  const merge = (a, b) => {
    const out = { ...a };
    for (const k in b) out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a[k] || {}, b[k]) : b[k];
    return out;
  };
  const S = {
    items: [], sel: null, running: false, last: null,
    s: merge(DEFAULTS, readJSON('mue.video', {})),
  };
  S.s.output = { ...prefs.output };
  const save = () => writeJSON('mue.video', { ...S.s, output: undefined });

  const fmtTime = (t) => {
    if (t == null || Number.isNaN(t)) return '';
    t = Math.max(0, Math.round(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const toSec = (v) => {
    if (v == null || String(v).trim() === '') return null;
    const p = String(v).trim().replace(',', '.').split(':').map(Number);
    return p.some(Number.isNaN) ? null : p.reduce((a, n) => a * 60 + n, 0);
  };
  const itemOf = (path) => S.items.find((i) => i.path === path);
  const current = () => itemOf(S.sel) || S.items[0];

  /* ---------- Réglages effectifs ---------- */

  const cropFor = (it) => (S.s.dims.crop === 'auto' ? it.autoCrop || null : S.s.dims.crop === 'custom' ? { ...S.s.dims.custom } : null);
  const effective = (it) => ({ ...S.s, dims: { ...S.s.dims, crop: cropFor(it) } });
  function outSize(it) {
    const v = it.info && it.info.video;
    if (!v) return null;
    if (S.s.video.codec === 'copy') return { width: v.width, height: v.height };
    const c = cropFor(it) || { top: 0, bottom: 0, left: 0, right: 0 };
    let w = v.width - c.left - c.right, h = v.height - c.top - c.bottom;
    if (((S.s.dims.rotate || 0) + 360) % 180 === 90) [w, h] = [h, w];
    const max = S.s.dims.height === 'same' ? null : +S.s.dims.height;
    if (max && Math.min(w, h) > max) { const k = max / Math.min(w, h); w *= k; h *= k; }
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return { width: even(w), height: even(h) };
  }
  function estimate(it) {
    if (!it.info) return null;
    const dur = Math.max(0.1, (toSec(it.per.trim.end) || it.info.duration) - (toSec(it.per.trim.start) || 0));
    if (S.s.video.mode === 'size' && S.s.video.codec !== 'copy') return S.s.video.size * 1024 * 1024;
    if (S.s.video.mode !== 'bitrate' || ['copy', 'prores'].includes(S.s.video.codec)) return null;
    const audio = it.per.audio.length * (S.s.audio.codec === 'copy' || S.s.audio.codec === 'flac' ? 192 : +S.s.audio.bitrate);
    return ((+S.s.video.bitrate + audio) * 1000 / 8) * dur;
  }

  /* ---------- Ajout des vidéos ---------- */

  async function add(found) {
    const known = new Set(S.items.map((i) => i.path));
    const fresh = found.filter((f) => !known.has(f.path)).map((f) => ({ ...f, name: basename(f.path), status: 'probing', per: { audio: [], subs: [], burn: null, extSubs: [], trim: { start: '', end: '' } } }));
    if (!fresh.length) return;
    if (!S.items.length) S.sel = fresh[0].path;
    S.items.push(...fresh);
    render();
    for (const it of fresh) {
      const r = await api.videoProbe(it.path);
      if (!r.ok) { it.status = 'error'; it.error = r.error; updateRow(it); continue; }
      it.info = r.info;
      it.per.audio = r.info.audio.map((a) => a.n);
      it.per.subs = S.s.subsDefault ? r.info.subs.map((s) => s.n) : [];
      it.status = 'idle';
      updateRow(it);
      if (it.path === current()?.path) showDetail();
      renderStatus();
      if (it.info.video) {
        api.videoCrop(it.path, it.info).then((c) => { if (c.ok) { it.autoCrop = c.crop; updateRow(it); if (it === current()) { renderSettings(); schedulePreview(); } } });
        api.videoFrame(it.path, it.info, { ...DEFAULTS, video: { ...DEFAULTS.video }, dims: { ...DEFAULTS.dims, height: 'same', crop: null } }, it.info.duration * 0.25)
          .then((f) => { if (f.ok) { it.thumb = f.src; updateRow(it); } });
      }
    }
  }
  window.videoSpace = { addPaths: async (paths) => add(await api.expandVideo(paths)) };
  const pick = async () => add(await api.pickVideo());
  $('vidAdd').addEventListener('click', pick);
  $('vidEmptyAdd').addEventListener('click', pick);
  $('vidClear').addEventListener('click', () => { if (S.running) return; S.items = []; S.sel = null; S.last = null; $('vidStatus').textContent = ''; render(); });

  /* ---------- Liste ---------- */

  function rowHtml(it) {
    const v = it.info && it.info.video;
    let dims = v ? `${v.width} × ${v.height}` : '';
    const o = it.info && outSize(it);
    if (o && v && (o.width !== v.width || o.height !== v.height)) dims = `<span class="est" title="Source : ${v.width} × ${v.height}"><b>${o.width} × ${o.height}</b></span>`;
    let size = fmtSize(it.size), state = '<span class="wait">en attente</span>';
    const est = estimate(it);
    if (it.status === 'idle' && est) size = `<span class="est">${fmtSize(it.size)} → <b>≈ ${fmtSize(est)}</b></span>`;
    if (it.status === 'probing') state = '<span class="wait">analyse…</span>';
    if (it.status === 'busy') {
      const p = it.progress || {};
      const pct = Math.round((p.ratio || 0) * 100);
      state = `<span class="vprog"><span class="bar"><i style="width:${pct}%"></i></span>${pct} %</span>`;
      if (p.eta != null) state += `<br><span class="wait">${fmtTime(p.eta)} restant</span>`;
    }
    if (it.status === 'done' && it.result) {
      const g = fmtGain(it.result.inSize, it.result.outSize);
      size = `<s>${fmtSize(it.result.inSize)}</s>${fmtSize(it.result.outSize)}`;
      state = `<span class="gain${g.up ? ' up' : ''}">${g.text}</span>`;
    }
    if (it.status === 'cancelled') state = '<span class="wait">annulée</span>';
    if (it.status === 'error') state = `<span class="err" title="${esc(it.error || '')}">échec</span>`;
    const thumb = it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : '<span class="thumb"></span>';
    const trimmed = it.per.trim.start || it.per.trim.end;
    return `<td><div class="name">${thumb}<span title="${esc(it.path)}">${esc(it.name)}</span></div></td>
      <td>${it.info ? fmtTime(it.info.duration) : ''}${trimmed ? ' <span class="wait">✂</span>' : ''}</td>
      <td>${dims}</td><td class="r">${size}</td><td class="r">${state}</td>
      <td><button class="x" title="Retirer de la liste" aria-label="Retirer ${esc(it.name)}"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></td>`;
  }
  function renderRows() {
    $('vidRows').innerHTML = S.items.map((it) => `<tr data-path="${esc(it.path)}" class="${it.path === current()?.path ? 'sel' : ''}">${rowHtml(it)}</tr>`).join('');
  }
  function updateRow(it) {
    const tr = document.querySelector(`#vidRows tr[data-path="${CSS.escape(it.path)}"]`);
    if (tr) tr.innerHTML = rowHtml(it);
  }
  $('vidRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.closest('.x')) {
      if (S.running && itemOf(tr.dataset.path)?.status === 'busy') return;
      S.items = S.items.filter((i) => i.path !== tr.dataset.path);
      if (S.sel === tr.dataset.path) S.sel = S.items[0]?.path || null;
      render();
      return;
    }
    S.sel = tr.dataset.path;
    document.querySelectorAll('#vidRows tr').forEach((r) => r.classList.toggle('sel', r === tr));
    showDetail();
  });
  $('vidRows').addEventListener('dblclick', (e) => {
    const it = itemOf(e.target.closest('tr')?.dataset.path);
    if (it) api.reveal(it.result ? it.result.output : it.path);
  });

  /* ---------- Détail : aperçu, découpe, pistes ---------- */

  function showDetail() {
    const it = current();
    $('vidDetail').hidden = !it;
    if (!it) return;
    $('vidDur').textContent = it.info ? fmtTime(it.info.duration) : '';
    if (document.activeElement !== $('vidStart')) $('vidStart').value = it.per.trim.start;
    if (document.activeElement !== $('vidEnd')) $('vidEnd').value = it.per.trim.end;
    renderTracks(it);
    schedulePreview();
  }
  const atTime = (it) => (it.info ? (it.info.duration * +$('vidAt').value) / 1000 : 0);
  let pvTimer = null, pvSeq = 0;
  function schedulePreview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      const it = current();
      if (!it || !it.info) return;
      $('vidTime').textContent = fmtTime(atTime(it));
      if (!it.info.video) { $('vidNote').hidden = false; $('vidNote').textContent = 'Fichier audio seulement'; $('vidImg').removeAttribute('src'); return; }
      const seq = ++pvSeq;
      $('vidNote').hidden = !!$('vidImg').getAttribute('src');
      const r = await api.videoFrame(it.path, it.info, effective(it), atTime(it));
      if (seq !== pvSeq) return;
      if (r.ok) { $('vidImg').src = r.src; $('vidNote').hidden = true; }
      else { $('vidNote').hidden = false; $('vidNote').textContent = 'Aperçu impossible pour ce moment'; }
    }, 140);
  }
  $('vidAt').addEventListener('input', () => { const it = current(); if (it) $('vidTime').textContent = fmtTime(atTime(it)); schedulePreview(); });

  function setTrim(key, value) {
    const it = current();
    if (!it) return;
    it.per.trim[key] = value;
    updateRow(it);
    renderStatus();
  }
  $('vidStart').addEventListener('change', (e) => setTrim('start', e.target.value.trim()));
  $('vidEnd').addEventListener('change', (e) => setTrim('end', e.target.value.trim()));
  $('vidSetStart').addEventListener('click', () => { const it = current(); if (it) { const t = fmtTime(atTime(it)); $('vidStart').value = t; setTrim('start', t); } });
  $('vidSetEnd').addEventListener('click', () => { const it = current(); if (it) { const t = fmtTime(atTime(it)); $('vidEnd').value = t; setTrim('end', t); } });

  const langName = (l) => ({ fre: 'français', fra: 'français', fr: 'français', eng: 'anglais', en: 'anglais', spa: 'espagnol', ger: 'allemand', deu: 'allemand', ita: 'italien', jpn: 'japonais', por: 'portugais', und: '' }[l] ?? l);
  function renderTracks(it) {
    const info = it.info;
    if (!info) { $('vidAudio').innerHTML = ''; $('vidSubs').innerHTML = ''; return; }
    $('vidAudio').innerHTML = info.audio.length ? info.audio.map((a) => `<label class="track"><input type="checkbox" data-a="${a.n}"${it.per.audio.includes(a.n) ? ' checked' : ''}>
      <span class="t-name">${esc(a.title || `Piste ${a.n + 1}`)}</span><span class="t-meta">${esc([langName(a.lang), a.codec.toUpperCase(), a.layout].filter(Boolean).join(', '))}</span></label>`).join('')
      : '<p class="hint">Aucune piste audio.</p>';
    const subs = info.subs.map((s) => `<div class="track"><input type="checkbox" data-s="${s.n}"${it.per.subs.includes(s.n) || it.per.burn === s.n ? ' checked' : ''} aria-label="Garder">
      <span class="t-name">${esc(s.title || langName(s.lang) || `Sous-titres ${s.n + 1}`)}</span><span class="t-meta">${esc(s.image ? 'image' : s.codec)}${s.forced ? ', forcés' : ''}</span>
      ${s.image ? '' : `<label class="burn"><input type="checkbox" data-burn="${s.n}"${it.per.burn === s.n ? ' checked' : ''}>incruster</label>`}</div>`);
    const ext = it.per.extSubs.map((p, k) => `<div class="track"><input type="checkbox" checked disabled><span class="t-name">${esc(basename(p))}</span><span class="t-meta">fichier</span><button class="x" data-ext="${k}" title="Retirer"><svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`);
    $('vidSubs').innerHTML = subs.concat(ext).join('') || '<p class="hint">Aucun sous-titre dans ce fichier.</p>';
  }
  $('vidAudio').addEventListener('change', (e) => {
    const it = current(); const n = +e.target.dataset.a;
    if (!it || Number.isNaN(n)) return;
    it.per.audio = e.target.checked ? [...new Set([...it.per.audio, n])].sort((a, b) => a - b) : it.per.audio.filter((x) => x !== n);
    updateRow(it);
  });
  $('vidSubs').addEventListener('change', (e) => {
    const it = current();
    if (!it) return;
    if (e.target.dataset.s != null) {
      const n = +e.target.dataset.s;
      it.per.subs = e.target.checked ? [...new Set([...it.per.subs, n])] : it.per.subs.filter((x) => x !== n);
      if (!e.target.checked && it.per.burn === n) it.per.burn = null;
    }
    if (e.target.dataset.burn != null) {
      const n = +e.target.dataset.burn;
      it.per.burn = e.target.checked ? n : null;
      if (e.target.checked && !it.per.subs.includes(n)) it.per.subs.push(n);
      schedulePreview();
    }
    renderTracks(it);
  });
  $('vidSubs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ext]');
    const it = current();
    if (b && it) { it.per.extSubs.splice(+b.dataset.ext, 1); renderTracks(it); }
  });
  $('vidAddSubs').addEventListener('click', async () => {
    const it = current();
    if (!it) return;
    it.per.extSubs.push(...(await api.pickSubs()));
    renderTracks(it);
  });

  /* ---------- Réglages ---------- */

  function seg(id, get, set, { preview = true } = {}) {
    $(id).addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      await set(b.dataset.v);
      S.s.preset = null;
      changed(preview);
    });
    return () => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  }
  const segs = [
    seg('vsFormat', () => S.s.format, (v) => { S.s.format = v; fixCodecs(); }, { preview: false }),
    seg('vsHeight', () => S.s.dims.height, (v) => { S.s.dims.height = v; }),
    seg('vsCrop', () => S.s.dims.crop, (v) => {
      if (v === 'custom' && S.s.dims.crop !== 'custom') { const it = current(); if (it && it.autoCrop) S.s.dims.custom = { ...it.autoCrop }; }
      S.s.dims.crop = v;
    }),
    seg('vsDeint', () => S.s.filters.deinterlace, (v) => { S.s.filters.deinterlace = v; }),
    seg('vsDenoise', () => S.s.filters.denoise, (v) => { S.s.filters.denoise = v; }),
    seg('vsSharpen', () => S.s.filters.sharpen, (v) => { S.s.filters.sharpen = v; }),
    seg('vsCodec', () => S.s.video.codec, (v) => { S.s.video.codec = v; }, { preview: false }),
    seg('vsFps', () => S.s.video.fps, (v) => { S.s.video.fps = v; }, { preview: false }),
    seg('vsMode', () => S.s.video.mode, (v) => { S.s.video.mode = v; }, { preview: false }),
    seg('vsSpeed', () => S.s.video.speed, (v) => { S.s.video.speed = v; }, { preview: false }),
    seg('vsAcodec', () => S.s.audio.codec, (v) => { S.s.audio.codec = v; }, { preview: false }),
    seg('vsAbr', () => S.s.audio.bitrate, (v) => { S.s.audio.bitrate = +v; }, { preview: false }),
    seg('vsMix', () => S.s.audio.mix, (v) => { S.s.audio.mix = v; }, { preview: false }),
    seg('vsOut', () => S.s.output.mode, async (v) => {
      if (v === 'custom') { const dir = await api.pickDir(); if (dir) S.s.output = { mode: 'custom', dir }; }
      else S.s.output = { mode: 'subfolder', dir: '' };
    }, { preview: false }),
  ];
  function fixCodecs() {
    if (!ALLOWED[S.s.format].includes(S.s.video.codec)) S.s.video.codec = ALLOWED[S.s.format][0];
    if (!AUDIO_ALLOWED[S.s.format].includes(S.s.audio.codec)) S.s.audio.codec = AUDIO_ALLOWED[S.s.format][0];
  }
  function changed(preview = true) {
    save();
    renderSettings();
    renderRows();
    renderStatus();
    if (preview) schedulePreview();
  }
  $('vsGray').addEventListener('change', (e) => { S.s.filters.grayscale = e.target.checked; S.s.preset = null; changed(); });
  $('vsNorm').addEventListener('change', (e) => { S.s.audio.normalize = e.target.checked; changed(false); });
  $('vsChapters').addEventListener('change', (e) => { S.s.chapters = e.target.checked; changed(false); });
  $('vsMeta').addEventListener('change', (e) => { S.s.metadata = e.target.checked; changed(false); });
  $('vsSubsDefault').addEventListener('change', (e) => { S.s.subsDefault = e.target.checked; changed(false); });
  $('vsRf').addEventListener('input', (e) => { S.s.video.quality = +e.target.value; S.s.preset = null; changed(false); });
  $('vsBitrate').addEventListener('input', (e) => { S.s.video.bitrate = +e.target.value || 0; S.s.preset = null; save(); renderRows(); renderStatus(); });
  $('vsSize').addEventListener('input', (e) => { S.s.video.size = +e.target.value || 0; S.s.preset = null; save(); renderRows(); renderStatus(); });
  $('vsCropFields').addEventListener('input', (e) => {
    const k = e.target.dataset.c;
    if (!k) return;
    S.s.dims.custom[k] = Math.max(0, +e.target.value || 0);
    save(); renderRows(); schedulePreview();
  });
  $('vsRotate').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const d = S.s.dims;
    if (b.dataset.a === 'left') d.rotate = (d.rotate + 270) % 360;
    if (b.dataset.a === 'right') d.rotate = (d.rotate + 90) % 360;
    if (b.dataset.a === 'flip') d.flip = !d.flip;
    if (b.dataset.a === 'reset') { d.rotate = 0; d.flip = false; }
    changed();
  });

  // Préréglages
  $('vsPreset').innerHTML = '<option value="">Personnalisé</option>' + PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  $('vsPreset').addEventListener('change', (e) => {
    const p = PRESETS.find((x) => x.id === e.target.value);
    if (!p) return;
    const keep = { output: S.s.output, subsDefault: S.s.subsDefault };
    S.s = merge(merge(DEFAULTS, p.s), keep);
    S.s.dims.custom = { ...DEFAULTS.dims.custom };
    S.s.preset = p.id;
    changed();
  });

  function renderSettings() {
    segs.forEach((r) => r());
    const s = S.s, codec = s.video.codec;
    $('vsPreset').value = s.preset || '';
    $('vsFormatHint').textContent = FORMAT_HINTS[s.format];
    $('vsCodec').querySelectorAll('button').forEach((b) => { b.disabled = !ALLOWED[s.format].includes(b.dataset.v); });
    $('vsAcodec').querySelectorAll('button').forEach((b) => { b.disabled = !AUDIO_ALLOWED[s.format].includes(b.dataset.v); });
    $('vsCodecHint').textContent = CODEC_HINTS[codec];
    const reencode = codec !== 'copy';
    $('vsQualityF').hidden = !reencode || codec === 'prores';
    $('vsSpeedF').hidden = !['h264', 'hevc', 'av1', 'vp9'].includes(codec) || s.video.mode === 'size' && false;
    $('vsQualityBox').hidden = s.video.mode !== 'quality';
    $('vsBitrateBox').hidden = s.video.mode !== 'bitrate';
    $('vsSizeBox').hidden = s.video.mode !== 'size';
    $('vsRf').value = s.video.quality;
    $('vsRf').style.setProperty('--fill', `${((s.video.quality - 14) / 26) * 100}%`);
    $('vsRfV').textContent = `RF ${s.video.quality}`;
    $('vsRfLabel').textContent = s.video.quality <= 18 ? 'Quasi sans perte' : s.video.quality <= 23 ? 'Très bonne qualité' : s.video.quality <= 28 ? 'Bonne qualité' : 'Qualité réduite';
    if (document.activeElement !== $('vsBitrate')) $('vsBitrate').value = s.video.bitrate;
    if (document.activeElement !== $('vsSize')) $('vsSize').value = s.video.size;
    $('vsAbrF').hidden = ['copy', 'flac'].includes(s.audio.codec);
    $('vsGray').checked = s.filters.grayscale;
    $('vsNorm').checked = s.audio.normalize;
    $('vsChapters').checked = s.chapters;
    $('vsMeta').checked = s.metadata;
    $('vsSubsDefault').checked = s.subsDefault;
    $('vsCropFields').hidden = s.dims.crop !== 'custom';
    $('vsCropFields').querySelectorAll('input').forEach((i) => { if (document.activeElement !== i) i.value = s.dims.custom[i.dataset.c]; });
    const it = current(), ac = it && it.autoCrop;
    $('vsCropHint').textContent = s.dims.crop === 'auto'
      ? (ac && (ac.top || ac.bottom || ac.left || ac.right) ? `Bandes noires retirées : ${ac.top} / ${ac.bottom} / ${ac.left} / ${ac.right} px (haut, bas, gauche, droite).` : 'Retire les bandes noires détectées.')
      : '';
    $('vsOutHint').textContent = s.output.mode === 'custom' && s.output.dir ? s.output.dir.replace(/^\/Users\/[^/]+/, '~') : 'Dans un dossier « converti » à côté de chaque vidéo. Les originaux ne sont jamais modifiés.';
  }

  /* ---------- Conversion ---------- */

  function renderStatus(text) {
    const ready = S.items.filter((i) => i.status === 'idle' || i.status === 'cancelled' || i.status === 'error' && i.info).length;
    const all = S.items.filter((i) => i.info).length;
    const n = ready || all;
    $('vidGo').hidden = S.running;
    $('vidStop').hidden = !S.running;
    $('vidGo').disabled = S.running || !n;
    $('vidGo').textContent = !n ? 'Convertir' : ready ? `Convertir ${n} vidéo${n > 1 ? 's' : ''}` : 'Convertir à nouveau';
    $('vidReveal').hidden = S.running || !S.last;
    if (text != null) $('vidStatus').textContent = text;
  }

  let totals = null;
  function renderTotal() {
    if (!totals) { $('vidTotal').hidden = true; return; }
    const done = totals.jobs.reduce((s, j) => {
      const it = itemOf(j.file);
      const r = it.status === 'done' || it.status === 'error' ? 1 : it.status === 'busy' ? (it.progress?.ratio || 0) : 0;
      return s + r * j.weight;
    }, 0) / totals.weight;
    $('vidTotal').hidden = false;
    $('vidTotalBar').style.width = `${Math.round(done * 100)}%`;
    const busy = S.items.find((i) => i.status === 'busy');
    const k = totals.jobs.findIndex((j) => j.file === busy?.path) + 1;
    $('vidTotalText').textContent = busy ? `Vidéo ${k} sur ${totals.jobs.length}, ${Math.round(done * 100)} % au total` : `${Math.round(done * 100)} %`;
  }

  api.onVideoProgress((file, p) => {
    const it = itemOf(file);
    if (!it) return;
    it.status = 'busy';
    it.progress = p;
    updateRow(it);
    renderTotal();
  });
  api.onVideoDone((file, r) => {
    const it = itemOf(file);
    if (!it) return;
    if (r.ok) { it.status = 'done'; it.result = r; S.last = r.output; }
    else if (r.cancelled) it.status = 'cancelled';
    else { it.status = 'error'; it.error = r.error; }
    it.progress = null;
    updateRow(it);
    renderTotal();
  });

  $('vidGo').addEventListener('click', async () => {
    if (S.running) return;
    let queue = S.items.filter((i) => i.info && ['idle', 'cancelled', 'error'].includes(i.status));
    if (!queue.length) { S.items.forEach((i) => { if (i.info) { i.status = 'idle'; i.result = null; } }); queue = S.items.filter((i) => i.info); }
    if (!queue.length) return;
    const jobs = queue.map((it) => ({ file: it.path, per: { ...it.per, crop: cropFor(it), info: it.info }, weight: Math.max(1, (toSec(it.per.trim.end) || it.info.duration) - (toSec(it.per.trim.start) || 0)) }));
    totals = { jobs, weight: jobs.reduce((s, j) => s + j.weight, 0) };
    queue.forEach((it) => { it.status = 'idle'; it.error = null; });
    S.running = true;
    S.last = null;
    renderRows();
    renderStatus('');
    renderTotal();
    const t0 = Date.now();
    const { output, ...settings } = S.s;
    const results = await api.videoEncode(jobs.map(({ file, per }) => ({ file, per })), settings, { ...output });
    S.running = false;
    totals = null;
    renderTotal();
    const ok = results.filter((r) => r.ok);
    const a = ok.reduce((s, r) => s + r.inSize, 0), b = ok.reduce((s, r) => s + r.outSize, 0);
    const warn = [...new Set(results.flatMap((r) => r.warnings || []))];
    renderStatus(ok.length ? `${ok.length} vidéo${ok.length > 1 ? 's' : ''} en ${fmtTime((Date.now() - t0) / 1000)}, ${fmtSize(a)} → ${fmtSize(b)}${warn.length ? `. ${warn[0]}` : ''}` : results.some((r) => r.cancelled) ? 'Conversion annulée.' : (results[0]?.error || ''));
    renderRows();
  });
  $('vidStop').addEventListener('click', () => api.videoCancel());
  $('vidReveal').addEventListener('click', () => S.last && api.reveal(S.last));

  function render() {
    const has = S.items.length > 0;
    $('vidEmpty').hidden = has;
    $('vidTblWrap').hidden = !has;
    $('vidClear').hidden = !has || S.running;
    $('vidCount').textContent = has ? `${S.items.length} vidéo${S.items.length > 1 ? 's' : ''}` : '';
    renderSettings();
    renderRows();
    renderStatus();
    if (has) showDetail(); else $('vidDetail').hidden = true;
  }
  render();
})();
