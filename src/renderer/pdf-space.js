// Espace PDF : organiser les pages, découper, compresser, convertir.
// S'appuie sur les petites fonctions communes de app.js ($, fmtSize, esc, basename, readJSON, writeJSON, prefs).
(() => {
  const COLORS = ['#6a5acd', '#4f7a45', '#4d6f96', '#b8733a', '#a0457a', '#3f8f8a'];
  const LEVEL_HINTS = {
    light: 'Images peu retouchées, presque aucune perte visible. Gain modeste.',
    medium: 'Le bon compromis pour envoyer un PDF par e-mail.',
    strong: 'Le plus léger. Les photos perdent en finesse, le texte reste net.',
  };

  const S = {
    items: [],   // { path, name, size, kind: 'pdf'|'image', pages, color, status, result, error, progress }
    pages: [],   // { id, file, index, rotate }
    sel: new Set(),
    anchor: null,
    tab: 'read',
    running: false,
    last: null,
    s: {
      name: 'document', level: 'medium',
      split: { mode: 'each', every: 2, ranges: '' },
      cv: { dir: 'toImages', format: 'jpeg', dpi: '150', quality: 85, page: 'a4', name: 'images' },
      ...readJSON('mue.pdf', {}),
      output: { ...prefs.output },
    },
  };
  let nextId = 1;
  const save = () => writeJSON('mue.pdf', { ...S.s, output: undefined });

  /* ---------- pdf.js ---------- */

  let lib = null;
  const asset = (p) => new URL(`vendor/pdfjs/${p}`, location.href).href;
  async function pdfjs() {
    if (!lib) {
      lib = await import('./vendor/pdfjs/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');
    }
    return lib;
  }
  const docs = new Map();
  function openDoc(file) {
    if (!docs.has(file)) {
      docs.set(file, (async () => {
        const L = await pdfjs();
        const data = await api.readFile(file);
        return L.getDocument({
          data, cMapUrl: asset('cmaps/'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts/'),
          wasmUrl: asset('wasm/'), iccUrl: asset('iccs/'), isEvalSupported: false,
        }).promise;
      })());
    }
    return docs.get(file);
  }
  function closeDoc(file) {
    const d = docs.get(file);
    docs.delete(file);
    if (d) d.then((doc) => doc.destroy()).catch(() => {});
  }

  // Rend une page dans un canvas ; size = côté le plus long en pixels, ou scale = facteur (1 = 72 ppp)
  async function renderPage(file, index, { size, scale }) {
    const doc = await openDoc(file);
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const k = scale || size / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale: k });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    return canvas;
  }

  /* ---------- Fichiers ---------- */

  async function add(found) {
    const known = new Set(S.items.map((i) => i.path));
    const fresh = found.filter((f) => !known.has(f.path));
    for (const f of fresh) {
      const it = { ...f, name: basename(f.path), status: 'idle', color: COLORS[S.items.length % COLORS.length] };
      S.items.push(it);
      if (f.kind === 'pdf') {
        let res = await api.pdfInfo(f.path);
        if (!res.ok && /mot de passe/.test(res.error)) {
          // PDF protégé : on demande le mot de passe et on travaille sur une copie déverrouillée
          const unlocked = await askPassword(it.name);
          if (!unlocked) { S.items.splice(S.items.indexOf(it), 1); continue; }
          it.orig = f.path;
          it.path = unlocked;
          res = await api.pdfInfo(unlocked);
        }
        if (!res.ok) { it.status = 'error'; it.error = res.error; continue; }
        it.pages = res.pages;
        for (let i = 0; i < res.pages; i++) S.pages.push({ id: nextId++, file: it.path, index: i, rotate: 0 });
      }
    }
    if (fresh.length && !S.s.nameTouched) {
      const first = fresh.find((f) => f.kind === 'pdf');
      if (first && S.items.filter((i) => i.kind === 'pdf').length > 1) S.s.name = 'document-assemble';
      else if (first) S.s.name = `${basename(first.path).replace(/\.pdf$/i, '')}-modifie`;
    }
    resetDone();
    render();
  }
  window.pdfSpace = {
    addPaths: async (paths) => add(await api.expandPdf(paths)),
  };

  // Fenêtre de mot de passe ; renvoie le chemin de la copie déverrouillée, ou null
  function askPassword(name) {
    return new Promise((resolve) => {
      $('pwText').textContent = `« ${name} » est protégé par un mot de passe.`;
      $('pwErr').hidden = true;
      $('pwInput').value = '';
      $('pwSheet').hidden = false;
      $('pwInput').focus();
      const done = (v) => { $('pwSheet').hidden = true; $('pwForm').onsubmit = null; $('pwCancel').onclick = null; resolve(v); };
      $('pwCancel').onclick = () => done(null);
      $('pwForm').onsubmit = async (e) => {
        e.preventDefault();
        const it = S.items[S.items.length - 1];
        const r = await api.pdfUnlock(it.path, $('pwInput').value);
        if (r.ok) done(r.path);
        else { $('pwErr').textContent = r.error; $('pwErr').hidden = false; $('pwInput').select(); }
      };
    });
  }

  // Options d'enregistrement : les copies déverrouillées s'enregistrent à côté de l'original
  function outOpts() {
    const origins = {};
    S.items.forEach((i) => { if (i.orig) origins[i.path] = i.orig; });
    return { ...S.s.output, origins };
  }

  function remove(path) {
    S.items = S.items.filter((i) => i.path !== path);
    S.pages = S.pages.filter((p) => p.file !== path);
    [...S.sel].forEach((id) => { if (!S.pages.some((p) => p.id === id)) S.sel.delete(id); });
    closeDoc(path);
    render();
  }

  function resetDone() {
    S.items.forEach((i) => { if (i.status === 'done' || (i.status === 'error' && i.result)) { i.status = 'idle'; i.result = null; } });
    S.last = null;
  }

  /* ---------- Organiser : grille de pages ---------- */

  const itemOf = (file) => S.items.find((i) => i.path === file);
  let observer = null;
  const thumbQueue = [];
  let thumbBusy = 0;
  function queueThumb(tile) {
    thumbQueue.push(tile);
    pumpThumbs();
  }
  async function pumpThumbs() {
    while (thumbBusy < 2 && thumbQueue.length) {
      const tile = thumbQueue.shift();
      if (!tile.isConnected || tile.dataset.rendered) continue;
      tile.dataset.rendered = '1';
      thumbBusy++;
      const p = S.pages.find((x) => x.id === +tile.dataset.id);
      renderPage(p.file, p.index, { size: 240 * (window.devicePixelRatio > 1 ? 1.6 : 1) })
        .then((c) => {
          c.style.transform = rotation(p.rotate, c);
          tile.querySelector('.pv').replaceChildren(c);
        })
        .catch(() => {})
        .finally(() => { thumbBusy--; pumpThumbs(); });
    }
  }

  // Une page tournée d'un quart de tour doit rester dans sa case carrée
  function rotation(deg, c) {
    if (!deg) return '';
    const k = deg % 180 ? Math.min(c.width, c.height) / Math.max(c.width, c.height) : 1;
    return `rotate(${deg}deg) scale(${k})`;
  }

  function renderGrid() {
    const grid = $('pdfPages');
    if (!observer) {
      observer = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && queueThumb(e.target)), { root: grid, rootMargin: '300px' });
    }
    const existing = new Map([...grid.children].map((t) => [+t.dataset.id, t]));
    const frag = document.createDocumentFragment();
    S.pages.forEach((p, n) => {
      let tile = existing.get(p.id);
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'pg';
        tile.draggable = true;
        tile.dataset.id = p.id;
        tile.innerHTML = '<div class="pv"><div class="ph"></div></div><div class="lbl"><i></i><span></span></div>';
        observer.observe(tile);
      }
      const it = itemOf(p.file);
      tile.querySelector('.lbl i').style.background = it ? it.color : 'var(--muted)';
      tile.querySelector('.lbl span').textContent = `${n + 1} · ${it ? it.name.replace(/\.pdf$/i, '') : ''} p. ${p.index + 1}`;
      tile.title = `${it ? it.name : ''}, page ${p.index + 1}`;
      tile.classList.toggle('sel', S.sel.has(p.id));
      const c = tile.querySelector('canvas');
      if (c) c.style.transform = rotation(p.rotate, c);
      frag.appendChild(tile);
    });
    grid.replaceChildren(frag);
  }

  $('pdfPages').addEventListener('click', (e) => {
    const tile = e.target.closest('.pg');
    if (!tile) { if (e.target === $('pdfPages')) { S.sel.clear(); render(); } return; }
    const id = +tile.dataset.id;
    if (e.shiftKey && S.anchor != null) {
      const ids = S.pages.map((p) => p.id);
      const [a, b] = [ids.indexOf(S.anchor), ids.indexOf(id)].sort((x, y) => x - y);
      ids.slice(a, b + 1).forEach((x) => S.sel.add(x));
    } else if (e.metaKey || e.ctrlKey) {
      S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
      S.anchor = id;
    } else {
      S.sel = new Set([id]);
      S.anchor = id;
    }
    render();
  });

  // Glisser-déposer pour réordonner
  let dragIds = null;
  $('pdfPages').addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.pg');
    if (!tile) return;
    const id = +tile.dataset.id;
    if (!S.sel.has(id)) { S.sel = new Set([id]); S.anchor = id; }
    dragIds = S.pages.filter((p) => S.sel.has(p.id)).map((p) => p.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-mue-pages', dragIds.join(','));
    requestAnimationFrame(() => document.querySelectorAll('.pg.sel').forEach((t) => t.classList.add('dragging')));
  });
  const clearDrop = () => document.querySelectorAll('.drop-before, .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  $('pdfPages').addEventListener('dragover', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    e.stopPropagation();
    const tile = e.target.closest('.pg');
    clearDrop();
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    tile.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  $('pdfPages').addEventListener('drop', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    e.stopPropagation();
    const tile = document.querySelector('.drop-before, .drop-after');
    const moving = S.pages.filter((p) => dragIds.includes(p.id));
    let rest = S.pages.filter((p) => !dragIds.includes(p.id));
    let at = rest.length;
    if (tile && !dragIds.includes(+tile.dataset.id)) {
      at = rest.findIndex((p) => p.id === +tile.dataset.id) + (tile.classList.contains('drop-after') ? 1 : 0);
    } else if (tile) {
      at = -1; // déposé sur soi-même : rien ne bouge
    }
    if (at >= 0) { rest.splice(at, 0, ...moving); S.pages = rest; }
    clearDrop();
    render();
  });
  $('pdfPages').addEventListener('dragend', () => {
    dragIds = null;
    clearDrop();
    document.querySelectorAll('.pg.dragging').forEach((t) => t.classList.remove('dragging'));
  });

  $('pgTools').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b || !S.sel.size) return;
    const a = b.dataset.a;
    if (a === 'left' || a === 'right') {
      S.pages.forEach((p) => { if (S.sel.has(p.id)) p.rotate = (p.rotate + (a === 'left' ? -90 : 90) + 360) % 360; });
    } else if (a === 'delete') {
      S.pages = S.pages.filter((p) => !S.sel.has(p.id));
      S.sel.clear();
    } else if (a === 'dup') {
      const out = [];
      for (const p of S.pages) {
        out.push(p);
        if (S.sel.has(p.id)) out.push({ ...p, id: nextId++ });
      }
      S.pages = out;
    }
    render();
  });
  $('pgAll').addEventListener('click', () => { S.sel = new Set(S.pages.map((p) => p.id)); render(); });
  $('pgNone').addEventListener('click', () => { S.sel.clear(); render(); });
  $('pgName').addEventListener('input', (e) => { S.s.name = e.target.value; S.s.nameTouched = true; save(); });

  /* ---------- Réglages ---------- */

  function seg(id, get, set) {
    $(id).addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || S.running) return;
      await set(b.dataset.v);
      save();
      render();
    });
    return () => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  }
  const segs = [
    seg('pdfTab', () => S.tab, (v) => { if (v !== S.tab) { S.tab = v; resetDone(); } }),
    seg('spMode', () => S.s.split.mode, (v) => { S.s.split.mode = v; }),
    seg('cpLevel', () => S.s.level, (v) => { S.s.level = v; }),
    seg('cvDir', () => S.s.cv.dir, (v) => { S.s.cv.dir = v; resetDone(); }),
    seg('cvFormat', () => S.s.cv.format, (v) => { S.s.cv.format = v; }),
    seg('cvDpi', () => S.s.cv.dpi, (v) => { S.s.cv.dpi = v; }),
    seg('cvPage', () => S.s.cv.page, (v) => { S.s.cv.page = v; }),
    seg('pdfOut', () => S.s.output.mode, async (v) => {
      if (v === 'custom') {
        const dir = await api.pickDir();
        if (dir) S.s.output = { mode: 'custom', dir };
      } else S.s.output = { mode: 'subfolder', dir: '' };
    }),
  ];
  $('spEvery').addEventListener('input', (e) => { S.s.split.every = +e.target.value || 1; save(); renderStatus(); });
  $('spRanges').addEventListener('input', (e) => { S.s.split.ranges = e.target.value; save(); renderStatus(); });
  $('cvQuality').addEventListener('input', (e) => { S.s.cv.quality = +e.target.value; save(); renderSettings(); });
  $('cvName').addEventListener('input', (e) => { S.s.cv.name = e.target.value; save(); });

  function renderSettings() {
    segs.forEach((r) => r());
    document.querySelectorAll('.pdf-mode').forEach((m) => (m.hidden = m.dataset.mode !== S.tab));
    $('spEveryField').hidden = S.s.split.mode !== 'every';
    $('spRangesField').hidden = S.s.split.mode !== 'ranges';
    if (document.activeElement !== $('spEvery')) $('spEvery').value = S.s.split.every;
    if (document.activeElement !== $('spRanges')) $('spRanges').value = S.s.split.ranges;
    $('spHint').textContent = {
      each: 'Un fichier par page.',
      every: 'Un fichier par groupe de pages, le dernier peut être plus court.',
      ranges: 'Un fichier par plage. Exemple : 1-3, 5, 8-fin.',
    }[S.s.split.mode];
    $('cpHint').textContent = LEVEL_HINTS[S.s.level];
    const toPdf = S.s.cv.dir === 'toPdf';
    document.querySelector('.cv-images').hidden = toPdf;
    document.querySelector('.cv-pdf').hidden = !toPdf;
    $('cvQualityF').hidden = S.s.cv.format === 'png';
    $('cvQuality').value = S.s.cv.quality;
    $('cvQuality').style.setProperty('--fill', `${((S.s.cv.quality - 30) / 70) * 100}%`);
    $('cvQualityV').textContent = S.s.cv.quality;
    if (document.activeElement !== $('cvName')) $('cvName').value = S.s.cv.name;
    if (document.activeElement !== $('pgName')) $('pgName').value = S.s.name;
    $('pdfOutHint').textContent = S.s.output.mode === 'custom' && S.s.output.dir
      ? S.s.output.dir.replace(/^\/Users\/[^/]+/, '~')
      : 'Dans un dossier « converti » à côté du fichier d\'origine. Les originaux ne sont jamais modifiés.';
    $('pgSelCount').textContent = S.sel.size;
    $('pgExtract').hidden = !S.sel.size;
  }

  /* ---------- Liste des fichiers (Découper, Compresser, Convertir) ---------- */

  const wantedKind = () => (S.tab === 'convert' && S.s.cv.dir === 'toPdf' ? 'image' : 'pdf');
  const listed = () => S.items.filter((i) => i.kind === wantedKind());

  function rowHtml(it) {
    let size = fmtSize(it.size);
    let state = '<span class="wait">en attente</span>';
    if (it.status === 'busy') state = it.progress ? `<span class="wait">${esc(it.progress)}</span>` : '<span class="prog"><i></i></span>';
    if (it.status === 'error') state = `<span class="err" title="${esc(it.error || '')}">échec</span>`;
    if (it.status === 'done' && it.result) {
      const r = it.result;
      if (r.outSize != null) {
        const g = fmtGain(r.inSize, r.outSize);
        size = `<s>${fmtSize(r.inSize)}</s>${fmtSize(r.outSize)}`;
        state = `<span class="gain${g.up ? ' up' : ''}">${g.text}</span>`;
      } else if (r.files != null) state = `<span class="gain">${r.files} fichier${r.files > 1 ? 's' : ''}</span>`;
      else if (r.images != null) state = `<span class="gain">${r.images} image${r.images > 1 ? 's' : ''}</span>`;
      else state = '<span class="gain">fait</span>';
    }
    const icon = it.kind === 'pdf'
      ? `<span class="thumb doc" style="--c:${it.color}"></span>`
      : (it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : '<span class="thumb"></span>');
    return `<td><div class="name">${icon}<span title="${esc(it.path)}">${esc(it.name)}</span></div></td>
      <td>${it.kind === 'pdf' ? (it.pages != null ? `${it.pages} page${it.pages > 1 ? 's' : ''}` : '') : ''}</td>
      <td class="r">${size}</td><td class="r">${state}</td>
      <td><button class="x" title="Retirer de la liste" aria-label="Retirer ${esc(it.name)}"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></td>`;
  }

  function renderTable() {
    const rows = listed();
    $('pdfRows').innerHTML = rows.map((it) => `<tr data-path="${esc(it.path)}">${rowHtml(it)}</tr>`).join('');
    const other = S.items.length - rows.length;
    $('pdfHidden').hidden = !other;
    if (other) {
      $('pdfHidden').textContent = wantedKind() === 'pdf'
        ? `${other} image${other > 1 ? 's' : ''} masquée${other > 1 ? 's' : ''} : elles servent dans Convertir, Images → PDF.`
        : `${other} PDF masqué${other > 1 ? 's' : ''} ici : cet onglet assemble des images.`;
    }
    // Miniatures des images, chargées à la demande
    rows.filter((i) => i.kind === 'image' && !i.thumb && !i.thumbLoading).forEach(async (it) => {
      it.thumbLoading = true;
      const info = await api.inspect(it.path);
      if (!info.error) { it.thumb = info.thumb; renderTable(); }
    });
  }
  const updateRow = (it) => {
    const tr = document.querySelector(`#pdfRows tr[data-path="${CSS.escape(it.path)}"]`);
    if (tr) tr.innerHTML = rowHtml(it);
  };
  $('pdfRows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr && e.target.closest('.x') && !S.running) remove(tr.dataset.path);
  });
  $('pdfRows').addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    const it = tr && itemOf(tr.dataset.path);
    if (it) api.reveal(it.result && (it.result.output || (it.result.outputs || [])[0]) || it.path);
  });

  /* ---------- Action principale ---------- */

  function action() {
    const pdfs = S.items.filter((i) => i.kind === 'pdf' && i.status !== 'error');
    const n = (k, word) => `${k} ${word}${k > 1 ? 's' : ''}`;
    switch (S.tab) {
      case 'read': return { label: 'Enregistrer une copie', ok: !!(window.pdfViewer && window.pdfViewer.current()) };
      case 'organize': return { label: S.pages.length ? `Enregistrer le PDF (${n(S.pages.length, 'page')})` : 'Enregistrer le PDF', ok: S.pages.length > 0 };
      case 'split': return { label: pdfs.length ? `Découper ${n(pdfs.length, 'PDF').replace('PDFs', 'PDF')}` : 'Découper', ok: pdfs.length > 0 };
      case 'compress': return { label: pdfs.length ? `Compresser ${n(pdfs.length, 'PDF').replace('PDFs', 'PDF')}` : 'Compresser', ok: pdfs.length > 0 };
      default: {
        if (S.s.cv.dir === 'toPdf') {
          const imgs = S.items.filter((i) => i.kind === 'image');
          return { label: imgs.length ? `Créer un PDF de ${n(imgs.length, 'page')}` : 'Créer le PDF', ok: imgs.length > 0 };
        }
        const pages = pdfs.reduce((s, i) => s + (i.pages || 0), 0);
        return { label: pdfs.length ? `Exporter ${n(pages, 'page')} en images` : 'Exporter en images', ok: pdfs.length > 0 };
      }
    }
  }

  function renderStatus(text) {
    const a = action();
    $('pdfGo').textContent = S.running ? 'En cours…' : a.ok ? a.label : a.label;
    $('pdfGo').disabled = S.running || !a.ok;
    $('pdfReveal').hidden = S.running || !S.last;
    if (text != null) $('pdfStatus').textContent = text;
  }

  async function run(fn) {
    S.running = true;
    S.last = null;
    render();
    try { await fn(); } finally { S.running = false; render(); }
  }

  api.onPdfProgress((file, r) => {
    const it = itemOf(file);
    if (!it) return;
    it.status = r.ok ? 'done' : 'error';
    it.result = r.ok ? r : null;
    it.error = r.error;
    it.progress = null;
    if (r.ok) S.last = r.output || (r.outputs || [])[0];
    updateRow(it);
  });

  $('pdfGo').addEventListener('click', () => {
    if (S.running || !action().ok) return;
    const out = outOpts();
    if (S.tab === 'read') return run(() => window.pdfViewer.save(out));
    if (S.tab === 'organize') {
      return run(async () => {
        $('pdfStatus').textContent = 'Assemblage…';
        const r = await api.pdfAssemble(S.pages.map(({ file, index, rotate }) => ({ file, index, rotate })), { name: S.s.name, output: out });
        if (r.ok) { S.last = r.output; $('pdfStatus').textContent = `${basename(r.output)}, ${fmtSize(r.size)}`; }
        else $('pdfStatus').textContent = r.error;
      });
    }
    const pdfs = S.items.filter((i) => i.kind === 'pdf' && i.status !== 'error' || (i.kind === 'pdf' && i.result));
    if (S.tab === 'split' || S.tab === 'compress') {
      return run(async () => {
        resetDone();
        pdfs.forEach((i) => { i.status = 'busy'; });
        renderTable();
        $('pdfStatus').textContent = '';
        const opts = S.tab === 'split' ? { ...S.s.split, output: out } : { level: S.s.level, output: out };
        const res = await (S.tab === 'split' ? api.pdfSplit : api.pdfCompress)(pdfs.map((i) => i.path), opts);
        const failed = res.filter((r) => !r.ok);
        if (S.tab === 'compress') {
          const okR = res.filter((r) => r.ok);
          const a = okR.reduce((s, r) => s + r.inSize, 0), b = okR.reduce((s, r) => s + r.outSize, 0);
          $('pdfStatus').textContent = okR.length ? `${fmtSize(a)} → ${fmtSize(b)}` : '';
        } else {
          const files = res.reduce((s, r) => s + (r.files || 0), 0);
          $('pdfStatus').textContent = files ? `${files} fichier${files > 1 ? 's' : ''} créé${files > 1 ? 's' : ''}` : '';
        }
        if (failed.length) $('pdfStatus').textContent = failed[0].error;
      });
    }
    if (S.s.cv.dir === 'toPdf') {
      const imgs = S.items.filter((i) => i.kind === 'image');
      return run(async () => {
        $('pdfStatus').textContent = 'Création du PDF…';
        const r = await api.pdfFromImages(imgs.map((i) => i.path), { pageSize: S.s.cv.page, name: S.s.cv.name, output: out });
        if (r.ok) { S.last = r.output; $('pdfStatus').textContent = `${basename(r.output)}, ${fmtSize(r.size)}`; imgs.forEach((i) => { i.status = 'done'; i.result = {}; }); }
        else $('pdfStatus').textContent = r.error;
      });
    }
    // PDF → images : rendu par pdf.js ici, enregistrement par le moteur
    return run(async () => {
      resetDone();
      const scale = +S.s.cv.dpi / 72;
      let total = 0;
      for (const it of pdfs) {
        it.status = 'busy';
        updateRow(it);
        try {
          for (let i = 0; i < it.pages; i++) {
            it.progress = `page ${i + 1} / ${it.pages}`;
            updateRow(it);
            const canvas = await renderPage(it.path, i, { scale });
            const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
            const r = await api.pdfSavePage(it.path, i, new Uint8Array(await blob.arrayBuffer()), { format: S.s.cv.format, quality: S.s.cv.quality, output: out });
            if (!r.ok) throw new Error(r.error);
            S.last = r.output;
            total++;
          }
          it.status = 'done';
          it.result = { images: it.pages };
        } catch (e) {
          it.status = 'error';
          it.error = e.message;
        }
        it.progress = null;
        updateRow(it);
      }
      $('pdfStatus').textContent = total ? `${total} image${total > 1 ? 's' : ''} enregistrée${total > 1 ? 's' : ''}` : '';
    });
  });
  $('pdfReveal').addEventListener('click', () => S.last && api.reveal(S.last));

  /* ---------- Ajout, vidage ---------- */

  const pick = async () => add(await api.pickPdf());
  $('pdfAdd').addEventListener('click', pick);
  $('pdfEmptyAdd').addEventListener('click', pick);
  $('pdfClear').addEventListener('click', () => {
    S.items.forEach((i) => closeDoc(i.path));
    S.items = []; S.pages = []; S.sel.clear(); S.last = null;
    $('pdfStatus').textContent = '';
    render();
  });
  window.addEventListener('keydown', (e) => {
    if (document.body.dataset.space !== 'pdf' || S.tab !== 'organize' || !S.sel.size || /INPUT/.test(document.activeElement.tagName)) return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      S.pages = S.pages.filter((p) => !S.sel.has(p.id));
      S.sel.clear();
      render();
    }
    if (e.key === 'a' && e.metaKey) { e.preventDefault(); S.sel = new Set(S.pages.map((p) => p.id)); render(); }
  });

  function render() {
    const organize = S.tab === 'organize', read = S.tab === 'read';
    const has = organize ? S.pages.length > 0 : read ? S.items.some((i) => i.kind === 'pdf' && i.pages) : listed().length > 0;
    $('viewer').hidden = !read || !has;
    const anything = S.items.length > 0;
    $('pdfEmpty').hidden = has;
    $('pdfPages').hidden = !organize || !has;
    $('pdfTblWrap').hidden = organize || read || !has;
    $('pdfClear').hidden = !anything || S.running;
    const toPdf = S.tab === 'convert' && S.s.cv.dir === 'toPdf';
    $('pdfEmptyTitle').textContent = toPdf ? 'Glisse tes images ici' : 'Glisse tes PDF ici';
    $('pdfEmptyText').textContent = toPdf
      ? 'Chaque image devient une page du PDF, dans l\'ordre de la liste.'
      : organize && anything ? 'Les PDF ajoutés n\'ont pas de page à afficher.' : 'Un ou plusieurs fichiers, ou un dossier entier.';
    const pdfCount = S.items.filter((i) => i.kind === 'pdf').length;
    $('pdfCount').textContent = read ? '' : organize
      ? (S.pages.length ? `${S.pages.length} page${S.pages.length > 1 ? 's' : ''}, ${pdfCount} PDF` : '')
      : (listed().length ? `${listed().length} fichier${listed().length > 1 ? 's' : ''}` : '');
    renderSettings();
    if (organize) renderGrid();
    else if (read) { if (window.pdfViewer) window.pdfViewer.refresh(); }
    else renderTable();
    renderStatus();
  }
  window.pdfCore = { S, openDoc, renderPage, itemOf, render: () => render(), status: (t) => renderStatus(t), outOpts };

  render();
})();
