// A mission area: a polygon on the ground (world x, z), drawn with straight lines on the maps. Missions define their
// own; leaving it is a mission failure (after a warning and a countdown), and so is an enemy formation getting out.

// a band along a heading: from `from` to `to` metres along it (from point O), `half` metres either side, clipped to the
// square [-lim, lim] (the real terrain data: what the map shows)
export function bandArea(O, headingDeg, from, to, half, lim) {
  const h = headingDeg * Math.PI / 180, f = [Math.sin(h), -Math.cos(h)], r = [Math.cos(h), Math.sin(h)];
  const P = (s, o) => [O[0] + f[0] * s + r[0] * o, O[1] + f[1] * s + r[1] * o];
  return clipSquare([P(from, -half), P(to, -half), P(to, half), P(from, half)], lim);
}

// Sutherland-Hodgman against the four sides of the square
function clipSquare(poly, L) {
  const sides = [[p => p[0] >= -L, (a, b) => cut(a, b, 0, -L)], [p => p[0] <= L, (a, b) => cut(a, b, 0, L)],
                 [p => p[1] >= -L, (a, b) => cut(a, b, 1, -L)], [p => p[1] <= L, (a, b) => cut(a, b, 1, L)]];
  for (const [inside, inter] of sides) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (inside(b)) { if (!inside(a)) out.push(inter(a, b)); out.push(b); }
      else if (inside(a)) out.push(inter(a, b));
    }
    poly = out;
  }
  return poly;
}
function cut(a, b, k, v) { const t = (v - a[k]) / (b[k] - a[k]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

// signed distance to the edge: + inside, - outside (metres)
export function edgeDistance(poly, x, z) {
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    const dx = xj - xi, dz = zj - zi, t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (xi + dx * t), z - (zi + dz * t)));
  }
  return inside ? best : -best;
}

// how far from (x, z) along the direction (dx, dz) (normalised) to the edge, or Infinity
export function distanceToEdge(poly, x, z, dx, dz) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i], ex = bx - ax, ez = bz - az;
    const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den, u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}
