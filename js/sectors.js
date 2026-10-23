import { CELL } from './config.js?v=107';
import { mulberry32 } from './rng.js?v=107';

// Frontsektoren wie die Provinzen in Hearts of Iron: Die Karte wird beim Start einmal in
// feste Regionen von etwa km Kantenlänge zerlegt. Jede eigene Region an der Grenze ist ein
// Frontsektor, der genau einer Armee oder Division gehört (siehe FrontManager). Weil die
// Regionen fest liegen, bleibt die Zuteilung stabil, auch wenn sich die Grenze verschiebt.
// Regionen wachsen nur über begehbare Felder: Meer und Gebirge trennen sie.
export function buildSectors(map, km) {
  const { w, h } = map;
  const size = Math.max(2, Math.round(km / (map.kmPerCell || 6)));
  const n = w * h;
  const of = new Int32Array(n).fill(-1);
  const ok = (i) => map.cellPassable(i);
  const rng = mulberry32((map.seed * 7919 + size) >>> 0);
  const regions = [];
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const seed = (i) => {
    of[i] = regions.length;
    regions.push({ id: regions.length, n: 0, sx: 0, sy: 0, nb: [] });
    queue[tail++] = i;
  };

  // Keime auf einem leicht verrückten Gitter, je Masche einer
  for (let gy = 0; gy * size < h; gy++) {
    for (let gx = 0; gx * size < w; gx++) {
      const cx = Math.floor((gx + 0.5 + (rng() - 0.5) * 0.5) * size);
      const cy = Math.floor((gy + 0.5 + (rng() - 0.5) * 0.5) * size);
      let found = -1;
      for (let r = 0; r <= size / 2 && found < 0; r++) {
        for (let dy = -r; dy <= r && found < 0; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (ok(i) && of[i] < 0) { found = i; break; }
          }
        }
      }
      if (found >= 0) seed(found);
    }
  }

  // Gleichzeitig von allen Keimen aus wachsen (Breitensuche über begehbare Felder)
  const grow = (limit) => {
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const r = of[i];
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || of[j] >= 0 || !ok(j)) continue;
        if (limit && regions[r].n >= limit) continue;
        of[j] = r;
        regions[r].n++;
        queue[tail++] = j;
      }
    }
  };
  for (const r of regions) r.n = 1;
  grow(0);
  // Abgetrennte Stücke ohne Keim (kleine Inseln, Täler) bekommen eigene Regionen
  for (let i = 0; i < n; i++) {
    if (of[i] >= 0 || !ok(i)) continue;
    head = tail = 0;
    seed(i);
    regions[regions.length - 1].n = 1;
    grow(size * size * 2);
  }

  // Mittelpunkte und Nachbarn
  for (const r of regions) r.n = 0;
  const nb = regions.map(() => new Set());
  for (let i = 0; i < n; i++) {
    const r = of[i];
    if (r < 0) continue;
    const reg = regions[r];
    reg.n++;
    reg.sx += i % w;
    reg.sy += (i / w) | 0;
    const x = i % w;
    for (const j of [x < w - 1 ? i + 1 : -1, i + w < n ? i + w : -1]) {
      if (j < 0) continue;
      const q = of[j];
      if (q >= 0 && q !== r) { nb[r].add(q); nb[q].add(r); }
    }
  }
  for (const reg of regions) {
    reg.x = (reg.sx / reg.n + 0.5) * CELL;
    reg.y = (reg.sy / reg.n + 0.5) * CELL;
    reg.nb = [...nb[reg.id]];
    delete reg.sx; delete reg.sy;
  }
  return { km, size, of, regions };
}
