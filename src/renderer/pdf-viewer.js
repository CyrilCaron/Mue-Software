// Lecteur PDF : affichage, recherche, annotations, signature, formulaires, mot de passe.
// Les annotations sont gardées en points PDF (origine en bas à gauche) et dessinées dans un calque SVG.
(() => {
  const core = window.pdfCore;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const CSS_SCALE = 96 / 72; // 100 % = taille réelle à l'écran
  const HINTS = {
    select: 'Clique sur une annotation pour la sélectionner et fais-la glisser pour la déplacer. Double-clic sur un texte ou une note pour le modifier.',
    highlight: 'Trace un rectangle sur la zone à surligner.',
    text: 'Clique où placer le texte, puis écris. Clique ailleurs pour valider.',
    note: 'Clique pour poser une note. Elle s\'ouvre dans tous les lecteurs PDF.',
    ink: 'Dessine en maintenant le clic.',
    sign: 'Clique où placer ta signature.',
  };

  const V = {
    file: null, doc: null, pages: [], zoom: 1, fit: true,
    tool: 'select', colors: { highlight: '#f5d34a', text: '#1d1f1a', ink: '#c0392b', note: '#f5d34a', select: '#1d1f1a', sign: '#1d3a8a' },
    sizes: { text: 14, ink: 3 },
    ann: new Map(),      // fichier → { [page]: [annotation] }
    history: new Map(),  // fichier → [instantanés]
    fields: new Map(),   // fichier → { list, values }
    sel: null,           // { page, i }
    hits: [], hit: -1, text: new Map(),
    protect: false, password: '', flatten: false,
    signature: readJSON('mue.signature', null),
    loading: null,
  };

  const annOf = (file = V.file) => { if (!V.ann.has(file)) V.ann.set(file, {}); return V.ann.get(file); };
  const listOf = (page) => { const a = annOf(); return (a[page] = a[page] || []); };
  const snapshot = () => {
    const h = V.history.get(V.file) || [];
    h.push(JSON.stringify(annOf()));
    if (h.length > 60) h.shift();
    V.history.set(V.file, h);
  };
  const hasEdits = () => Object.values(annOf()).some((l) => l.length) || Object.keys((V.fields.get(V.file) || {}).values || {}).length;

  /* ---------- Document courant ---------- */

  function pdfItems() { return core.S.items.filter((i) => i.kind === 'pdf' && i.pages); }

  function refresh() {
    const items = pdfItems();
    const sel = $('vDoc');
    sel.innerHTML = items.map((i) => `<option value="${esc(i.path)}">${esc(i.name)}</option>`).join('');
    sel.hidden = items.length < 2;
    if (!items.length) { V.file = null; return; }
    if (!items.some((i) => i.path === V.file)) open(items[0].path);
    else sel.value = V.file;
    renderTools();
  }
  $('vDoc').addEventListener('change', (e) => open(e.target.value));

  async function open(file) {
    V.file = file;
    V.sel = null;
    V.hits = []; V.hit = -1;
    $('vDoc').value = file;
    const token = (V.loading = {});
    const doc = await core.openDoc(file);
    if (V.loading !== token) return;
    V.doc = doc;
    V.pages = [];
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      V.pages.push({ index: i, page, base: page.getViewport({ scale: 1 }) });
    }
    if (V.loading !== token) return;
    buildPages();
    buildThumbs();
    loadFields();
    renderTools();
    core.status('');
    core.render();
  }

  /* ---------- Pages ---------- */

  let io = null, ioThumbs = null;
  function scale() { return V.zoom * CSS_SCALE; }
  function fitZoom() {
    const w = $('vPages').clientWidth - 48;
    const widest = Math.max(...V.pages.map((p) => p.base.width));
    return Math.max(0.25, Math.min(3, w / (widest * CSS_SCALE)));
  }

  function buildPages() {
    if (V.fit) V.zoom = fitZoom();
    const box = $('vPages');
    if (!io) io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && drawCanvas(V.pages[+e.target.dataset.i])), { root: box, rootMargin: '600px 0px' });
    io.disconnect();
    box.replaceChildren(...V.pages.map((p) => {
      const el = document.createElement('div');
      el.className = 'vp';
      el.dataset.i = p.index;
      const svg = document.createElementNS(SVGNS, 'svg');
      el.append(svg);
      p.el = el; p.svg = svg; p.canvas = null; p.drawn = 0;
      bindPage(p);
      io.observe(el);
      return el;
    }));
    layout();
  }

  function layout() {
    for (const p of V.pages) {
      p.vp = p.page.getViewport({ scale: scale() });
      p.el.style.width = `${p.vp.width}px`;
      p.el.style.height = `${p.vp.height}px`;
      p.svg.setAttribute('viewBox', `0 0 ${p.vp.width} ${p.vp.height}`);
      p.svg.setAttribute('class', `tool-${V.tool}`);
      drawOverlay(p);
      if (p.drawn && p.drawn !== scale()) { p.drawn = 0; if (isNear(p)) drawCanvas(p); }
    }
    $('vZoomV').textContent = `${Math.round(V.zoom * 100)} %`;
    $('vPageCount').textContent = `/ ${V.pages.length}`;
    $('vPageIn').max = V.pages.length;
  }
  const isNear = (p) => { const r = p.el.getBoundingClientRect(), b = $('vPages').getBoundingClientRect(); return r.bottom > b.top - 600 && r.top < b.bottom + 600; };

  async function drawCanvas(p) {
    if (!p || p.drawn === scale() || p.busy) return;
    p.busy = true;
    const s = scale(), dpr = window.devicePixelRatio || 1;
    const vp = p.page.getViewport({ scale: s * dpr });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    try {
      await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (p.canvas) p.canvas.remove();
      p.el.prepend(c);
      p.canvas = c;
      p.drawn = s;
    } catch { /* rendu interrompu */ }
    p.busy = false;
    if (p.drawn !== scale() && isNear(p)) drawCanvas(p);
  }

  function buildThumbs() {
    const box = $('vThumbs');
    if (!ioThumbs) {
      ioThumbs = new IntersectionObserver((es) => es.forEach(async (e) => {
        if (!e.isIntersecting || e.target.dataset.done) return;
        e.target.dataset.done = '1';
        const p = V.pages[+e.target.dataset.i];
        const vp = p.page.getViewport({ scale: 160 / p.base.width });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.catch(() => {});
        e.target.querySelector('.ph')?.replaceWith(c);
      }), { root: box, rootMargin: '300px' });
    }
    ioThumbs.disconnect();
    box.replaceChildren(...V.pages.map((p) => {
      const t = document.createElement('div');
      t.className = 'vthumb';
      t.dataset.i = p.index;
      t.innerHTML = `<div class="ph" style="aspect-ratio:${p.base.width}/${p.base.height}"></div><span>${p.index + 1}</span>`;
      t.addEventListener('click', () => goTo(p.index));
      ioThumbs.observe(t);
      return t;
    }));
    markCurrent();
  }

  function goTo(i, center = null) {
    const p = V.pages[Math.max(0, Math.min(V.pages.length - 1, i))];
    if (!p) return;
    const box = $('vPages');
    const top = p.el.offsetTop - box.offsetTop - 12 + (center != null ? center - box.clientHeight / 2 : 0);
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function currentPage() {
    const box = $('vPages'), mid = box.scrollTop + box.clientHeight / 3;
    let best = 0;
    for (const p of V.pages) if (p.el.offsetTop - box.offsetTop <= mid) best = p.index;
    return best;
  }
  function markCurrent() {
    const i = currentPage();
    if (document.activeElement !== $('vPageIn')) $('vPageIn').value = i + 1;
    document.querySelectorAll('.vthumb').forEach((t) => t.classList.toggle('on', +t.dataset.i === i));
    const on = document.querySelector('.vthumb.on');
    if (on) { const b = $('vThumbs'); if (on.offsetTop < b.scrollTop || on.offsetTop > b.scrollTop + b.clientHeight - 60) b.scrollTop = on.offsetTop - 40; }
  }
  $('vPages').addEventListener('scroll', () => requestAnimationFrame(markCurrent));
  $('vPageIn').addEventListener('change', (e) => goTo(+e.target.value - 1));

  function setZoom(z, fit = false) {
    const box = $('vPages');
    const ratio = box.scrollTop / Math.max(1, box.scrollHeight);
    V.fit = fit;
    V.zoom = Math.max(0.25, Math.min(4, z));
    layout();
    box.scrollTop = ratio * box.scrollHeight;
  }
  $('vZoomIn').addEventListener('click', () => setZoom(V.zoom * 1.2));
  $('vZoomOut').addEventListener('click', () => setZoom(V.zoom / 1.2));
  $('vFit').addEventListener('click', () => setZoom(fitZoom(), true));
  window.addEventListener('resize', () => { if (V.doc && V.fit && !$('viewer').hidden) setZoom(fitZoom(), true); });
  $('vPages').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(V.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });

  /* ---------- Calque d'annotations ---------- */

  const toView = (p, x, y) => p.vp.convertToViewportPoint(x, y);
  const toPdf = (p, x, y) => p.vp.convertToPdfPoint(x, y);
  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.append(n);
    return n;
  }
  function rectOf(p, [x1, y1, x2, y2]) {
    const a = toView(p, x1, y1), b = toView(p, x2, y2);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  }

  function drawOverlay(p) {
    const svg = p.svg;
    svg.replaceChildren();
    const s = scale();
    (annOf()[p.index] || []).forEach((a, i) => {
      let n;
      if (a.type === 'highlight') {
        const r = rectOf(p, a.rect);
        n = el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: a.color, 'fill-opacity': 0.4, style: 'mix-blend-mode:multiply' }, svg);
      } else if (a.type === 'ink') {
        n = el('g', {}, svg);
        a.strokes.forEach((st) => el('polyline', { points: st.map(([x, y]) => toView(p, x, y).join(',')).join(' '), fill: 'none', stroke: a.color, 'stroke-width': a.width * s, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, n));
        // Zone de prise plus large que le trait, pour sélectionner facilement
        const pts = a.strokes.flat().map(([x, y]) => toView(p, x, y));
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        el('rect', { x: Math.min(...xs) - 4, y: Math.min(...ys) - 4, width: Math.max(...xs) - Math.min(...xs) + 8, height: Math.max(...ys) - Math.min(...ys) + 8, fill: 'transparent' }, n);
      } else if (a.type === 'text') {
        const [x, y] = toView(p, a.x, a.y);
        n = el('text', { x, y, fill: a.color, 'font-size': a.size * s, 'font-family': 'Helvetica, Arial, sans-serif' }, svg);
        a.text.split('\n').forEach((line, k) => {
          const t = el('tspan', { x, dy: k === 0 ? a.size * s * 0.85 : a.size * s * 1.2 }, n);
          t.textContent = line || ' ';
        });
      } else if (a.type === 'note') {
        const [x, y] = toView(p, a.x, a.y);
        const k = 22 * s / 1.6;
        n = el('g', { transform: `translate(${x},${y})` }, svg);
        el('path', { d: `M0 0h${k}v${k * 0.75}h-${k * 0.55}l-${k * 0.25} ${k * 0.25}v-${k * 0.25}H0z`, fill: a.color || '#f5d34a', stroke: '#8a6d00', 'stroke-width': 1 }, n);
        el('title', {}, n).textContent = a.text;
      } else if (a.type === 'image') {
        const r = rectOf(p, [a.x, a.y, a.x + a.w, a.y + a.h]);
        n = el('image', { x: r.x, y: r.y, width: r.w, height: r.h, href: a.src, preserveAspectRatio: 'none' }, svg);
      }
      if (n) {
        n.classList.add('ann');
        n.dataset.i = i;
        if (V.sel && V.sel.page === p.index && V.sel.i === i) n.classList.add('sel');
      }
    });
    // Résultats de recherche et champ de formulaire en cours
    V.hits.forEach((h, k) => {
      if (h.page !== p.index) return;
      const r = rectOf(p, h.rect);
      el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 2, class: `hit${k === V.hit ? ' cur' : ''}` }, svg);
    });
    // Aperçu des champs remplis dans Mue (le PDF d'origine garde ses anciennes valeurs jusqu'à l'enregistrement)
    const F = V.fields.get(V.file);
    if (F) {
      for (const f of F.list) {
        if (f.page !== p.index || !(f.name in F.values) || !f.rect) continue;
        const v = F.values[f.name], r = rectOf(p, f.rect);
        el('rect', { x: r.x + 1, y: r.y + 1, width: r.w - 2, height: r.h - 2, fill: '#fff' }, svg);
        const t = el('text', { x: r.x + 3, y: r.y + r.h * 0.72, 'font-size': Math.min(r.h * 0.62, 12 * s), fill: '#1d1f1a', 'font-family': 'Helvetica, Arial, sans-serif' }, svg);
        t.textContent = f.type === 'checkbox' ? (v ? '✓' : '') : String(v || '');
      }
    }
    if (V.fieldHl && V.fieldHl.page === p.index) {
      const r = rectOf(p, V.fieldHl.rect);
      el('rect', { x: r.x - 3, y: r.y - 3, width: r.w + 6, height: r.h + 6, rx: 4, class: 'field-hl' }, svg);
    }
  }
  const redraw = (i) => { const p = V.pages[i]; if (p) drawOverlay(p); };
  const redrawAll = () => V.pages.forEach(drawOverlay);

  /* ---------- Outils ---------- */

  function bindPage(p) {
    let drag = null;
    const pt = (e) => { const r = p.svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    p.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || document.querySelector('textarea.ann-edit')) return;
      const [vx, vy] = pt(e);
      const [px, py] = toPdf(p, vx, vy);
      const color = V.colors[V.tool];
      if (V.tool === 'select') {
        const target = e.target.closest('.ann');
        V.sel = target ? { page: p.index, i: +target.dataset.i } : null;
        redrawAll();
        renderTools();
        if (target) { snapshot(); drag = { kind: 'move', last: [px, py] }; p.svg.setPointerCapture(e.pointerId); }
        return;
      }
      if (V.tool === 'highlight') { drag = { kind: 'hl', start: [px, py], el: el('rect', { fill: color, 'fill-opacity': 0.4 }, p.svg), v0: [vx, vy] }; }
      else if (V.tool === 'ink') {
        snapshot();
        const a = { type: 'ink', strokes: [[[px, py]]], width: V.sizes.ink, color };
        listOf(p.index).push(a);
        drag = { kind: 'ink', a, lastV: [vx, vy] };
      } else if (V.tool === 'text') { e.preventDefault(); editText(p, { type: 'text', x: px, y: py, text: '', size: V.sizes.text, color }, null); return; }
      else if (V.tool === 'note') { e.preventDefault(); editText(p, { type: 'note', x: px, y: py, text: '', color: '#f5d34a' }, null); return; }
      else if (V.tool === 'sign') {
        if (!V.signature) { openPad(); return; }
        snapshot();
        const w = 150, h = w * V.signature.h / V.signature.w;
        listOf(p.index).push({ type: 'image', src: V.signature.src, x: px - w / 2, y: py - h / 2, w, h });
        V.sel = { page: p.index, i: listOf(p.index).length - 1 };
        setTool('select');
        redraw(p.index);
        return;
      }
      p.svg.setPointerCapture(e.pointerId);
    });

    p.svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [vx, vy] = pt(e);
      const [px, py] = toPdf(p, vx, vy);
      if (drag.kind === 'move') {
        const a = listOf(p.index)[V.sel.i];
        moveAnn(a, px - drag.last[0], py - drag.last[1]);
        drag.last = [px, py];
        drag.moved = true;
        redraw(p.index);
      } else if (drag.kind === 'hl') {
        const [x0, y0] = drag.v0;
        Object.entries({ x: Math.min(x0, vx), y: Math.min(y0, vy), width: Math.abs(vx - x0), height: Math.abs(vy - y0) }).forEach(([k, v]) => drag.el.setAttribute(k, v));
        drag.end = [px, py];
        drag.big = Math.abs(vx - x0) > 3 && Math.abs(vy - y0) > 3;
      } else if (drag.kind === 'ink') {
        if (Math.hypot(vx - drag.lastV[0], vy - drag.lastV[1]) < 1.5) return;
        drag.a.strokes[0].push([px, py]);
        drag.lastV = [vx, vy];
        redraw(p.index);
      }
    });

    const end = () => {
      if (!drag) return;
      if (drag.kind === 'hl' && drag.big) {
        snapshot();
        listOf(p.index).push({ type: 'highlight', rect: [...drag.start, ...drag.end], color: V.colors.highlight });
      }
      if (drag.kind === 'move' && !drag.moved) V.history.get(V.file).pop(); // simple clic : rien à annuler
      drag = null;
      redraw(p.index);
      changed();
    };
    p.svg.addEventListener('pointerup', end);
    p.svg.addEventListener('pointercancel', end);

    p.svg.addEventListener('dblclick', (e) => {
      if (V.tool !== 'select') return;
      const target = e.target.closest('.ann');
      if (!target) return;
      const a = listOf(p.index)[+target.dataset.i];
      if (a.type === 'text' || a.type === 'note') editText(p, a, +target.dataset.i);
    });
  }

  function moveAnn(a, dx, dy) {
    if (a.type === 'highlight') a.rect = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
    else if (a.type === 'ink') a.strokes = a.strokes.map((st) => st.map(([x, y]) => [x + dx, y + dy]));
    else { a.x += dx; a.y += dy; }
  }

  // Zone de saisie posée sur la page pour un texte ou une note
  function editText(p, a, index) {
    const [x, y] = toView(p, a.x, a.y);
    const ta = document.createElement('textarea');
    ta.className = 'ann-edit';
    ta.value = a.text;
    ta.placeholder = a.type === 'note' ? 'Texte de la note' : 'Texte';
    Object.assign(ta.style, { left: `${x}px`, top: `${y}px`, fontSize: `${a.type === 'text' ? a.size * scale() : 13}px`, color: a.type === 'text' ? a.color : '#1d1f1a' });
    if (a.type === 'note') { ta.style.width = '220px'; ta.style.height = '90px'; ta.style.fontFamily = 'inherit'; }
    p.el.append(ta);
    setTimeout(() => ta.focus(), 0);
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const text = ta.value.replace(/\s+$/, '');
      ta.remove();
      snapshot();
      const list = listOf(p.index);
      if (index == null) { if (text) { list.push({ ...a, text }); V.sel = { page: p.index, i: list.length - 1 }; } else V.history.get(V.file).pop(); }
      else if (text) list[index].text = text;
      else { list.splice(index, 1); V.sel = null; }
      redraw(p.index);
      changed();
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { ta.value = index == null ? '' : a.text; ta.blur(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.blur();
      e.stopPropagation();
    });
  }

  function setTool(t) {
    V.tool = t;
    V.pages.forEach((p) => p.svg.setAttribute('class', `tool-${t}`));
    if (t !== 'select') { V.sel = null; redrawAll(); }
    if (t === 'sign' && !V.signature) openPad();
    renderTools();
  }
  $('vTools').addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (b) setTool(b.dataset.t); });

  $('vColors').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    const a = selected();
    if (a && a.type !== 'image') { snapshot(); a.color = b.dataset.v; redraw(V.sel.page); changed(); }
    else V.colors[V.tool] = b.dataset.v;
    renderTools();
  });
  $('vSize').addEventListener('input', (e) => {
    const v = +e.target.value;
    const a = selected();
    if (a && a.type === 'text') { a.size = v; redraw(V.sel.page); }
    else if (a && a.type === 'ink') { a.width = v; redraw(V.sel.page); }
    else if (a && a.type === 'image') { const r = a.h / a.w; const w = v * 10; a.y += a.h - w * r; a.w = w; a.h = w * r; redraw(V.sel.page); }
    else if (V.tool === 'ink') V.sizes.ink = v;
    else V.sizes.text = v;
    renderTools();
  });
  $('vSize').addEventListener('change', () => { if (selected()) changed(); });

  const selected = () => (V.sel ? (annOf()[V.sel.page] || [])[V.sel.i] : null);
  function deleteSelected() {
    if (!V.sel) return;
    snapshot();
    annOf()[V.sel.page].splice(V.sel.i, 1);
    const pg = V.sel.page;
    V.sel = null;
    redraw(pg);
    changed();
  }
  $('vDelete').addEventListener('click', deleteSelected);
  function undo() {
    const h = V.history.get(V.file);
    if (!h || !h.length) return;
    V.ann.set(V.file, JSON.parse(h.pop()));
    V.sel = null;
    redrawAll();
    changed();
  }
  $('vUndo').addEventListener('click', undo);
  window.addEventListener('keydown', (e) => {
    if (document.body.dataset.space !== 'pdf' || core.S.tab !== 'read' || $('viewer').hidden) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && V.sel) { e.preventDefault(); deleteSelected(); }
    if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); }
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('vSearch').focus(); $('vSearch').select(); }
    if (e.key === 'Escape' && V.sel) { V.sel = null; redrawAll(); renderTools(); }
  });

  function renderTools() {
    document.querySelectorAll('#vTools button').forEach((b) => b.classList.toggle('on', b.dataset.t === V.tool));
    const a = selected();
    const kind = a ? a.type : V.tool;
    $('vToolHint').textContent = HINTS[V.tool];
    const color = a && a.color ? a.color : V.colors[V.tool];
    $('vColorF').hidden = kind === 'image' || kind === 'sign' || (V.tool === 'select' && !a);
    document.querySelectorAll('#vColors button').forEach((b) => b.classList.toggle('on', b.dataset.v === color));
    const sizeKind = kind === 'text' ? 'text' : kind === 'ink' ? 'ink' : kind === 'image' ? 'image' : null;
    $('vSizeF').hidden = !sizeKind;
    if (sizeKind) {
      const [label, min, max, val, unit] = sizeKind === 'text' ? ['Taille du texte', 6, 48, a ? a.size : V.sizes.text, ' pt']
        : sizeKind === 'ink' ? ['Épaisseur', 1, 12, a ? a.width : V.sizes.ink, ' pt']
          : ['Largeur', 4, 40, Math.round(a.w / 10), ''];
      $('vSizeLabel').textContent = label;
      Object.assign($('vSize'), { min, max });
      if (document.activeElement !== $('vSize')) $('vSize').value = val;
      $('vSize').style.setProperty('--fill', `${((val - min) / (max - min)) * 100}%`);
      $('vSizeV').textContent = sizeKind === 'image' ? `${Math.round(a.w * 0.3528)} mm` : `${val}${unit}`;
    }
    $('vDelete').hidden = !a;
    $('vSigF').hidden = V.tool !== 'sign';
    $('vSigPrev').innerHTML = V.signature ? `<img src="${V.signature.src}" alt="Ma signature">` : 'Aucune signature';
    $('vSigEdit').textContent = V.signature ? 'Modifier ma signature' : 'Créer ma signature';
    $('vProtect').checked = V.protect;
    $('vPassF').hidden = !V.protect;
    $('vFlatten').checked = V.flatten;
  }

  function changed() {
    renderTools();
    core.status('');
  }

  /* ---------- Recherche ---------- */

  // Minuscules sans accents, caractère par caractère pour garder les positions
  const fold = (s) => [...s].map((c) => c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()[0] || c).join('');
  async function textOf(p) {
    const key = `${V.file}|${p.index}`;
    if (!V.text.has(key)) V.text.set(key, (await p.page.getTextContent()).items.filter((it) => it.str));
    return V.text.get(key);
  }
  async function search() {
    const q = fold($('vSearch').value.trim());
    V.hits = []; V.hit = -1;
    if (q.length >= 2) {
      for (const p of V.pages) {
        for (const it of await textOf(p)) {
          const s = fold(it.str);
          let k = s.indexOf(q);
          while (k >= 0) {
            const t = it.transform, h = it.height || Math.hypot(t[2], t[3]);
            const x = t[4] + (it.width * k) / s.length, w = (it.width * q.length) / s.length;
            V.hits.push({ page: p.index, rect: [x, t[5] - h * 0.22, x + w, t[5] + h * 0.88] });
            k = s.indexOf(q, k + q.length);
          }
        }
      }
    }
    $('vHits').textContent = q.length < 2 ? '' : V.hits.length ? `1 / ${V.hits.length}` : 'aucun résultat';
    if (V.hits.length) showHit(0); else redrawAll();
  }
  function showHit(k) {
    if (!V.hits.length) return;
    V.hit = (k + V.hits.length) % V.hits.length;
    $('vHits').textContent = `${V.hit + 1} / ${V.hits.length}`;
    redrawAll();
    const h = V.hits[V.hit], p = V.pages[h.page];
    goTo(h.page, rectOf(p, h.rect).y);
  }
  $('vSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (V.hits.length && $('vSearch').dataset.q === $('vSearch').value) showHit(V.hit + (e.shiftKey ? -1 : 1));
    else { $('vSearch').dataset.q = $('vSearch').value; search(); }
  });
  $('vSearch').addEventListener('search', () => { if (!$('vSearch').value) { V.hits = []; $('vHits').textContent = ''; redrawAll(); } });
  $('vNext').addEventListener('click', () => showHit(V.hit + 1));
  $('vPrev').addEventListener('click', () => showHit(V.hit - 1));

  /* ---------- Formulaires ---------- */

  async function loadFields() {
    const file = V.file;
    if (!V.fields.has(file)) {
      const r = await api.pdfFields(file);
      V.fields.set(file, { list: r.ok ? r.fields : [], values: {} });
    }
    if (file !== V.file) return;
    const { list, values } = V.fields.get(file);
    $('vFieldsF').hidden = !list.length;
    $('vFields').innerHTML = list.map((f, k) => {
      const v = f.name in values ? values[f.name] : f.value;
      const label = esc(f.name.replace(/[_.]+/g, ' '));
      const dis = f.readOnly ? ' disabled' : '';
      if (f.type === 'checkbox') return `<label class="chk"><span>${label}</span><input type="checkbox" data-k="${k}"${v ? ' checked' : ''}${dis}><i></i></label>`;
      if (f.type === 'choice' || f.type === 'radio') {
        return `<label class="field"><span>${label}</span><select data-k="${k}"${dis}><option value=""></option>${f.options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      }
      return `<label class="field"><span>${label}</span><input type="text" data-k="${k}" value="${esc(String(v || ''))}"${dis}></label>`;
    }).join('');
  }
  const fieldAt = (e) => { const n = e.target.closest('[data-k]'); return n ? [n, V.fields.get(V.file).list[+n.dataset.k]] : []; };
  $('vFields').addEventListener('input', (e) => {
    const [n, f] = fieldAt(e);
    if (!f) return;
    V.fields.get(V.file).values[f.name] = n.type === 'checkbox' ? n.checked : n.value;
    if (f.page >= 0) redraw(f.page);
    changed();
  });
  $('vFields').addEventListener('focusin', (e) => {
    const [, f] = fieldAt(e);
    if (!f || f.page == null || f.page < 0) return;
    V.fieldHl = { page: f.page, rect: f.rect };
    redrawAll();
    goTo(f.page, rectOf(V.pages[f.page], f.rect).y);
  });
  $('vFields').addEventListener('focusout', () => { V.fieldHl = null; redrawAll(); });
  $('vFlatten').addEventListener('change', (e) => { V.flatten = e.target.checked; });

  /* ---------- Protection ---------- */

  $('vProtect').addEventListener('change', (e) => { V.protect = e.target.checked; renderTools(); if (V.protect) setTimeout(() => $('vPass').focus(), 0); });
  $('vPass').addEventListener('input', (e) => { V.password = e.target.value; });

  /* ---------- Signature ---------- */

  const pad = $('sigCanvas');
  const pctx = pad.getContext('2d');
  let padMode = 'draw', padDirty = false;
  function clearPad() {
    pctx.clearRect(0, 0, pad.width, pad.height);
    padDirty = false;
    if (padMode === 'type') drawTyped();
  }
  function drawTyped() {
    pctx.clearRect(0, 0, pad.width, pad.height);
    const t = $('sigText').value.trim();
    if (!t) return;
    let size = 110;
    pctx.font = `italic ${size}px Gloock, Georgia, serif`;
    while (pctx.measureText(t).width > pad.width * 0.85 && size > 30) { size -= 4; pctx.font = `italic ${size}px Gloock, Georgia, serif`; }
    pctx.fillStyle = '#1d3a8a';
    pctx.textAlign = 'center';
    pctx.fillText(t, pad.width / 2, pad.height * 0.7);
    padDirty = true;
  }
  function openPad() {
    $('sigSheet').hidden = false;
    clearPad();
  }
  (() => {
    let last = null;
    const at = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
    pad.addEventListener('pointerdown', (e) => { if (padMode !== 'draw') return; last = at(e); try { pad.setPointerCapture(e.pointerId); } catch {} });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const p = at(e);
      pctx.strokeStyle = '#1d3a8a';
      pctx.lineWidth = 5;
      pctx.lineCap = 'round';
      pctx.lineJoin = 'round';
      pctx.beginPath();
      pctx.moveTo(...last);
      pctx.lineTo(...p);
      pctx.stroke();
      last = p;
      padDirty = true;
    });
    pad.addEventListener('pointerup', () => { last = null; });
  })();
  $('sigMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    padMode = b.dataset.v;
    $('sigMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('sigTypeF').hidden = padMode !== 'type';
    clearPad();
    if (padMode === 'type') $('sigText').focus();
  });
  $('sigText').addEventListener('input', drawTyped);
  $('sigClear').addEventListener('click', () => { if (padMode === 'type') $('sigText').value = ''; clearPad(); });
  $('sigCancel').addEventListener('click', () => { $('sigSheet').hidden = true; if (!V.signature && V.tool === 'sign') setTool('select'); });
  $('sigSave').addEventListener('click', () => {
    if (!padDirty) { $('sigSheet').hidden = true; return; }
    // On rogne autour du tracé
    const { data, width, height } = pctx.getImageData(0, 0, pad.width, pad.height);
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 <= x0) return;
    const m = 8, w = x1 - x0 + 2 * m, h = y1 - y0 + 2 * m;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(pad, x0 - m, y0 - m, w, h, 0, 0, w, h);
    V.signature = { src: c.toDataURL('image/png'), w, h };
    writeJSON('mue.signature', V.signature);
    $('sigSheet').hidden = true;
    renderTools();
  });
  $('vSigEdit').addEventListener('click', openPad);

  /* ---------- Enregistrement ---------- */

  async function save(output) {
    if (!V.file) return;
    if (V.protect && !V.password) { core.status('Choisis un mot de passe, ou décoche la protection.'); $('vPass').focus(); return; }
    const f = V.fields.get(V.file) || { values: {} };
    const annotations = {};
    for (const [k, list] of Object.entries(annOf())) if (list.length) annotations[k] = list;
    const edits = Object.keys(annotations).length || Object.keys(f.values).length;
    const suffix = edits ? (Object.values(annotations).flat().some((a) => a.type === 'image') ? '-signe' : '-annote') : V.protect ? '-protege' : '-copie';
    core.status('Enregistrement…');
    const r = await api.pdfSaveEdited(V.file, { annotations, fields: f.values, flatten: V.flatten, password: V.protect ? V.password : '', suffix, output });
    if (r.ok) {
      core.S.last = r.output;
      core.status(`${basename(r.output)}, ${fmtSize(r.size)}${V.protect ? ', protégé' : ''}`);
    } else core.status(r.error);
  }

  window.pdfViewer = { refresh, save, current: () => V.file, hasEdits };
  renderTools();
  refresh();
})();
