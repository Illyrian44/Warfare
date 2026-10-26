import { KM } from './config.js?v=108';

// Aufstellung am Zielpunkt: dicht in Reihen quer zur Marschrichtung (1,5 km Abstand),
// vordere Einheiten nach vorn, links bleibt links – so kreuzen sich die Wege kaum.
// keep: die Einheiten behalten ihre Abstände zueinander. Liefert [{ u, x, y }].
export function formationSlots(units, target, keep = false, gap = 1.5 * KM) {
  if (!units.length) return [];
  const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
  const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
  if (keep) return units.map((u) => ({ u, x: target.x + u.x - cx, y: target.y + u.y - cy }));
  const l = Math.hypot(target.x - cx, target.y - cy) || 1;
  const fx = (target.x - cx) / l, fy = (target.y - cy) / l; // Marschrichtung
  const lx = -fy, ly = fx;                                   // quer dazu
  const depth = (u) => (u.x - cx) * fx + (u.y - cy) * fy;
  const lat = (u) => (u.x - cx) * lx + (u.y - cy) * ly;
  const perRow = Math.max(1, Math.ceil(Math.sqrt(units.length * 2)));
  const rows = Math.ceil(units.length / perRow);
  const byDepth = units.slice().sort((a, b) => depth(b) - depth(a));
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = byDepth.slice(r * perRow, (r + 1) * perRow).sort((a, b) => lat(a) - lat(b));
    const d = ((rows - 1) / 2 - r) * gap;
    row.forEach((u, k) => {
      const s = (k - (row.length - 1) / 2) * gap;
      out.push({ u, x: target.x + fx * d + lx * s, y: target.y + fy * d + ly * s });
    });
  }
  return out;
}
