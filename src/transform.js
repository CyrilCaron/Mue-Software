// Géométrie partagée par le moteur et l'interface : rotation, redressement, recadrage.

// Plus grand rectangle de mêmes proportions que l'image (w × h) qui tient encore
// entièrement dans l'image tournée de `deg` degrés. Renvoie le facteur d'échelle k.
function innerScale(w, h, deg) {
  const t = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}

// Inclinaison dominante d'une image en niveaux de gris, d'après l'orientation des contours.
// On cherche les lignes presque horizontales ou verticales (horizon, murs, cadres) et on
// renvoie l'angle à appliquer pour les rendre droites, ou 0 si rien de net ne ressort.
function detectTilt(gray, w, h, maxDeg = 20) {
  const BINS_PER_DEG = 10;
  const size = maxDeg * 2 * BINS_PER_DEG + 1;
  const hist = new Float64Array(size);
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      const mag = Math.hypot(gx, gy);
      if (mag < 80) continue;
      total += mag;
      // Direction du contour (perpendiculaire au gradient), ramenée autour de 0° modulo 90°
      let a = (Math.atan2(gy, gx) * 180) / Math.PI + 90;
      a = ((a % 90) + 90) % 90;
      if (a > 45) a -= 90;
      if (Math.abs(a) > maxDeg) continue;
      hist[Math.round((a + maxDeg) * BINS_PER_DEG)] += mag;
    }
  }
  if (!total) return 0;
  // Lissage sur ±0,5° pour un pic stable
  const smooth = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    let s = 0;
    for (let j = -5; j <= 5; j++) if (i + j >= 0 && i + j < size) s += hist[i + j] * (6 - Math.abs(j));
    smooth[i] = s;
  }
  let best = 0;
  for (let i = 1; i < size; i++) if (smooth[i] > smooth[best]) best = i;
  // Affinage : moyenne pondérée de l'histogramme brut autour du pic
  let sw = 0, sa = 0;
  for (let i = Math.max(0, best - 8); i <= Math.min(size - 1, best + 8); i++) { sw += hist[i]; sa += hist[i] * i; }
  const angle = (sw ? sa / sw : best) / BINS_PER_DEG - maxDeg;
  // Pic trop faible : l'image n'a pas de lignes franches, on ne touche à rien
  const mean = smooth.reduce((s, v) => s + v, 0) / size;
  if (smooth[best] < mean * 2.5 || Math.abs(angle) < 0.05) return 0;
  return Math.round(-angle * 10) / 10;
}

module.exports = { innerScale, detectTilt };
