// Réduction de bruit par filtre guidé (He et al.), qui lisse les zones planes
// tout en gardant les contours. La luminance est traitée finement, la couleur
// plus fortement : c'est elle qui donne l'aspect « grains colorés » des photos de nuit.

// Moyenne sur une fenêtre carrée de rayon r, en O(n) grâce aux sommes glissantes.
function boxFilter(src, w, h, r, out, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum;
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  const norm = 1 / ((2 * r + 1) * (2 * r + 1));
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
}

// Filtre guidé : lisse p en suivant les contours du guide I. eps règle la force :
// plus il est grand, plus on lisse. Avec I = p, l'image se guide elle-même.
function guided(I, p, w, h, r, eps) {
  const n = w * h;
  const tmp = new Float32Array(n);
  const meanI = new Float32Array(n), meanP = new Float32Array(n);
  const corrII = new Float32Array(n), corrIP = new Float32Array(n);
  const prod = new Float32Array(n);
  boxFilter(I, w, h, r, meanI, tmp);
  boxFilter(p, w, h, r, meanP, tmp);
  for (let i = 0; i < n; i++) prod[i] = I[i] * I[i];
  boxFilter(prod, w, h, r, corrII, tmp);
  for (let i = 0; i < n; i++) prod[i] = I[i] * p[i];
  boxFilter(prod, w, h, r, corrIP, tmp);
  const a = corrII, b = corrIP; // réutilisés
  for (let i = 0; i < n; i++) {
    const varI = corrII[i] - meanI[i] * meanI[i];
    const cov = corrIP[i] - meanI[i] * meanP[i];
    const ai = cov / (varI + eps);
    a[i] = ai;
    b[i] = meanP[i] - ai * meanI[i];
  }
  boxFilter(a, w, h, r, meanI, tmp);
  boxFilter(b, w, h, r, meanP, tmp);
  const q = prod;
  for (let i = 0; i < n; i++) q[i] = meanI[i] * I[i] + meanP[i];
  return q;
}

/**
 * pixels : Buffer RGB ou RGBA 8 bits. Renvoie un Buffer de même forme.
 * strength, color, detail : 0 à 100.
 */
function denoiseRaw(pixels, w, h, channels, { strength = 50, color = 50, detail = 30 } = {}) {
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  const s = strength / 100, c = color / 100;
  const keep = (detail / 100) * 0.6; // part du grain fin réinjectée pour garder la texture
  // Luminance : deux passes douces valent mieux qu'une forte (moins d'effet « peinture »)
  let Yq = Y;
  if (s > 0) {
    const r = 1 + Math.round(2 * s), eps = (6 + 50 * s) ** 2;
    Yq = guided(Y, Y, w, h, r, eps);
    if (s > 0.4) Yq = guided(Yq, Yq, w, h, r, eps / 2);
  }
  // Couleur : guidée par la luminance nettoyée, pour ne pas baver sur les contours
  const cr = 2 + Math.round(6 * c), ce = (4 + 16 * c) ** 2;
  const Cbq = c > 0 ? guided(Yq, Cb, w, h, cr, ce) : Cb;
  const Crq = c > 0 ? guided(Yq, Cr, w, h, cr, ce) : Cr;

  const out = Buffer.alloc(pixels.length);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    const y = Yq[i] + keep * (Y[i] - Yq[i]);
    const cb = Cbq[i], crr = Crq[i];
    out[p] = clamp(y + 1.402 * crr);
    out[p + 1] = clamp(y - 0.344136 * cb - 0.714136 * crr);
    out[p + 2] = clamp(y + 1.772 * cb);
    if (channels === 4) out[p + 3] = pixels[p + 3];
  }
  return out;
}

module.exports = { denoiseRaw };
