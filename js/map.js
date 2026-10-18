import { CELL, T, TERRAIN_INFO, MAP_SIZES, ROAD_SPEED, BRIDGE_SPEED } from './config.js?v=24';
import { mulberry32, makeNoise, fbm } from './rng.js?v=24';

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function classify(h, f) {
  if (h < 0.3) return T.DEEP;
  if (h < 0.36) return T.WATER;
  if (h >= 0.8) return T.MOUNTAIN;
  if (h >= 0.67) return T.HILL;
  if (f > 0.6) return T.FOREST;
  return T.PLAINS;
}

export class GameMap {
  constructor(w, h, height, forest, seed, sizeKey) {
    this.w = w;
    this.h = h;
    this.height = height;
    this.forest = forest;
    this.seed = seed;
    this.sizeKey = sizeKey;
    this.worldW = w * CELL;
    this.worldH = h * CELL;
    this.cells = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) this.cells[i] = classify(height[i], forest[i]);
    this.cities = [];
    this.roads = new Uint8Array(w * h); // 1 = Straße bzw. Brücke
    this.roadLines = [];                // Straßenverläufe in Weltkoordinaten (zum Zeichnen)
  }

  // Bewegungstempo einer Zelle, Straßen eingerechnet
  cellSpeed(i) {
    const t = this.cells[i];
    if (this.roads[i] && TERRAIN_INFO[t].passable) return t === T.WATER ? BRIDGE_SPEED : ROAD_SPEED;
    return TERRAIN_INFO[t].speed;
  }

  speedAt(wx, wy) {
    const t = this.terrainAt(wx, wy);
    if (!TERRAIN_INFO[t].passable) return 0;
    if (this.roads[this.cellIndex(wx, wy)]) return t === T.WATER ? BRIDGE_SPEED : ROAD_SPEED;
    return TERRAIN_INFO[t].speed;
  }

  // Bilineare Interpolation; Zellmittelpunkte liegen bei (i + 0.5) * CELL
  sample(arr, wx, wy) {
    const { w, h } = this;
    let cx = wx / CELL - 0.5, cy = wy / CELL - 0.5;
    if (cx < 0) cx = 0; else if (cx > w - 1) cx = w - 1;
    if (cy < 0) cy = 0; else if (cy > h - 1) cy = h - 1;
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = cx - x0, fy = cy - y0;
    const a = arr[y0 * w + x0], b = arr[y0 * w + x1];
    const c = arr[y1 * w + x0], d = arr[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  terrainAt(wx, wy) {
    if (wx < 0 || wy < 0 || wx >= this.worldW || wy >= this.worldH) return T.DEEP;
    return classify(this.sample(this.height, wx, wy), this.sample(this.forest, wx, wy));
  }

  passableAt(wx, wy) {
    return TERRAIN_INFO[this.terrainAt(wx, wy)].passable;
  }

  cellIndex(wx, wy) {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor(wx / CELL)));
    const cy = Math.min(this.h - 1, Math.max(0, Math.floor(wy / CELL)));
    return cy * this.w + cx;
  }

  cellPassable(i) {
    return TERRAIN_INFO[this.cells[i]].passable;
  }

  // A* auf dem Zellgitter, Kosten = Weglänge / Geländetempo. Liefert Weltpunkte.
  // opts.cost(i): Zusatzkosten je Zelle (z. B. Feindgebiet), opts.safe(x, y): Abkürzungen nur über sichere Punkte
  findPath(sx, sy, tx, ty, opts = null) {
    const { w, h } = this;
    const start = this.cellIndex(sx, sy);
    let goal = this.cellIndex(tx, ty);
    if (!this.cellPassable(goal)) {
      goal = this.nearestPassable(goal, 8);
      if (goal < 0) return null;
      tx = (goal % w + 0.5) * CELL;
      ty = (Math.floor(goal / w) + 0.5) * CELL;
    }
    if (start === goal) return [{ x: tx, y: ty }];
    const n = w * h;
    const g = new Float32Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const gx = goal % w, gy = Math.floor(goal / w);
    const heur = (i) => {
      const dx = Math.abs(i % w - gx), dy = Math.abs(Math.floor(i / w) - gy);
      // Untere Schranke: so schnell wie auf der Straße, sonst übersieht A* Straßenumwege
      return (Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy)) / ROAD_SPEED;
    };
    g[start] = 0;
    heap.push(start, heur(start));
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      if (cur === goal) { found = true; break; }
      closed[cur] = 1;
      const cx = cur % w, cy = Math.floor(cur / w);
      const curSpeed = this.cellSpeed(cur) || 0.5;
      for (const [dx, dy, len] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (closed[ni] || !this.cellPassable(ni)) continue;
        if (dx && dy && (!this.cellPassable(cy * w + nx) || !this.cellPassable(ny * w + cx))) continue;
        const sp = (this.cellSpeed(ni) + curSpeed) / 2;
        const ng = g[cur] + len / sp + (opts && opts.cost ? len * opts.cost(ni) : 0);
        if (ng < g[ni]) {
          g[ni] = ng;
          parent[ni] = cur;
          heap.push(ni, ng + heur(ni));
        }
      }
    }
    if (!found) return null;
    const cellsPath = [];
    for (let c = goal; c !== -1; c = parent[c]) cellsPath.push(c);
    cellsPath.reverse();
    const pts = cellsPath.map((c) => ({ x: (c % w + 0.5) * CELL, y: (Math.floor(c / w) + 0.5) * CELL }));
    pts[pts.length - 1] = { x: tx, y: ty };
    return this.smoothPath({ x: sx, y: sy }, pts, opts && opts.safe);
  }

  // Wegpunkte überspringen, solange die direkte Linie auf gleich gutem Gelände bleibt
  smoothPath(from, pts, safe = null) {
    const out = [];
    let anchor = from;
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.clearLine(anchor, pts[j], safe)) j--;
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return out;
  }

  clearLine(a, b, safe = null) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    const steps = Math.ceil(d / 4);
    const s0 = this.speedAt(a.x, a.y) || 1, s1 = this.speedAt(b.x, b.y) || 1;
    // Liegen beide Enden auf einer Straße, muss auch die Abkürzung auf der Straße bleiben
    const minSpeed = s0 > 1 && s1 > 1 ? Math.min(s0, s1) : Math.min(s0, s1, 0.8);
    for (let s = 1; s < steps; s++) {
      if (this.speedAt(a.x + dx * s / steps, a.y + dy * s / steps) < minSpeed) return false;
      if (safe && !safe(a.x + dx * s / steps, a.y + dy * s / steps)) return false;
    }
    return true;
  }

  nearestPassable(idx, maxR) {
    const { w, h } = this;
    const cx = idx % w, cy = Math.floor(idx / w);
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = Infinity;
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (!this.cellPassable(i)) continue;
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
}

class MinHeap {
  constructor() { this.items = []; this.prio = []; }
  get size() { return this.items.length; }
  push(item, p) {
    const a = this.items, q = this.prio;
    let i = a.length;
    a.push(item); q.push(p);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (q[par] <= p) break;
      a[i] = a[par]; q[i] = q[par];
      i = par;
    }
    a[i] = item; q[i] = p;
  }
  pop() {
    const a = this.items, q = this.prio;
    const top = a[0];
    const lastI = a.pop(), lastP = q.pop();
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mp = lastP;
        if (l < n && q[l] < mp) { m = l; mp = q[l]; }
        if (r < n && q[r] < mp) { m = r; mp = q[r]; }
        if (m === i) break;
        a[i] = a[m]; q[i] = q[m];
        i = m;
      }
      a[i] = lastI; q[i] = lastP;
    }
    return top;
  }
}

// Erzeugt eine punktsymmetrische Insel, damit beide Seiten fair starten.
export function generateMap(seed, sizeKey = 'medium') {
  const cfg = MAP_SIZES[sizeKey];
  for (let attempt = 0; attempt < 40; attempt++) {
    const map = tryGenerate((seed + attempt * 7919) >>> 0, cfg, sizeKey);
    if (map) { map.seed = seed; return map; }
  }
  throw new Error('Kartengenerierung fehlgeschlagen');
}

function tryGenerate(seed, cfg, sizeKey) {
  const { w, h } = cfg;
  const rng = mulberry32(seed);
  const noise = makeNoise(rng);
  const fnoise = makeNoise(rng);
  const raw = new Float32Array(w * h);
  const rawF = new Float32Array(w * h);
  const freq = 1 / 20;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w * 2 - 1, ny = (y + 0.5) / h * 2 - 1;
      let e = fbm(noise, x * freq, y * freq, 5);
      e = (e - 0.5) * 2.0 + 0.5;
      const edge = Math.max(Math.abs(nx), Math.abs(ny)) * 0.55 + Math.hypot(nx, ny) * 0.45;
      const fall = smoothstep(0.68, 1.04, edge);
      raw[y * w + x] = e + 0.1 - fall * 1.1;
      rawF[y * w + x] = fbm(fnoise, x / 9, y / 9, 3);
    }
  }
  const height = new Float32Array(w * h);
  const forest = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const m = w * h - 1 - i; // 180°-Drehung
    height[i] = (raw[i] + raw[m]) / 2;
    forest[i] = (rawF[i] + rawF[m]) / 2;
  }
  // Kontrast der Waldverteilung nach dem Mitteln wiederherstellen
  for (let i = 0; i < w * h; i++) forest[i] = (forest[i] - 0.5) * 1.6 + 0.5;

  const map = new GameMap(w, h, height, forest, seed, sizeKey);

  // Größte begehbare Zusammenhangskomponente bestimmen
  const comp = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let i = 0; i < w * h; i++) {
    if (comp[i] >= 0 || !map.cellPassable(i)) continue;
    const id = sizes.length;
    let count = 0;
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const c = stack.pop();
      count++;
      const cx = c % w, cy = Math.floor(c / w);
      const nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [x, y] of nb) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const ni = y * w + x;
        if (comp[ni] < 0 && map.cellPassable(ni)) { comp[ni] = id; stack.push(ni); }
      }
    }
    sizes.push(count);
  }
  if (!sizes.length) return null;
  const main = sizes.indexOf(Math.max(...sizes));
  if (sizes[main] < w * h * 0.38) return null;

  const landOk = (i) => comp[i] === main && comp[w * h - 1 - i] === main &&
    (map.cells[i] === T.PLAINS || map.cells[i] === T.FOREST || map.cells[i] === T.HILL);

  // Städte auf der linken Hälfte platzieren und spiegeln
  const minD = cfg.minDist;
  const left = [];
  for (let tries = 0; tries < 4000 && left.length < cfg.pairs; tries++) {
    const x = 5 + Math.floor(rng() * (w / 2 - 12));
    const y = 6 + Math.floor(rng() * (h - 12));
    const i = y * w + x;
    if (!landOk(i)) continue;
    // Umgebung sollte größtenteils begehbar sein
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!map.cellPassable((y + dy) * w + x + dx)) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const mx = w - 1 - x, my = h - 1 - y;
    if (Math.hypot(mx - x, my - y) < minD * 1.4) continue;
    if (left.some((c) => Math.hypot(c.cx - x, c.cy - y) < minD || Math.hypot(c.cx - mx, c.cy - my) < minD)) continue;
    left.push({ cx: x, cy: y });
  }
  if (left.length < cfg.pairs) return null;

  // Die Paare nahe der Mitte bleiben neutral
  const neutrals = Math.floor(cfg.pairs / 3);
  left.sort((a, b) => a.cx - b.cx);
  left.forEach((c, k) => {
    const neutral = k >= left.length - neutrals;
    map.cities.push({ x: (c.cx + 0.5) * CELL, y: (c.cy + 0.5) * CELL, owner: neutral ? 0 : 1 });
    map.cities.push({ x: (w - 1 - c.cx + 0.5) * CELL, y: (h - 1 - c.cy + 0.5) * CELL, owner: neutral ? 0 : 2 });
  });
  buildRoads(map);
  return map;
}

// Straßennetz: Städte werden nach dem Relative Neighborhood Graph verbunden
// (jede Stadt mit ihren natürlichen Nachbarn, keine überflüssigen Querverbindungen).
// Die Trassen meiden Hügel und Wald, führen nie über Gebirge und bündeln sich mit
// bestehenden Straßen. Gespiegelte Paare bekommen gespiegelte Straßen.
function buildRoads(map) {
  const { w, h, cities } = map;
  const n = w * h;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const edges = [];
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      const dij = d(cities[i], cities[j]);
      let blocked = false;
      for (let k = 0; k < cities.length && !blocked; k++) {
        if (k === i || k === j) continue;
        if (Math.max(d(cities[i], cities[k]), d(cities[j], cities[k])) < dij) blocked = true;
      }
      if (!blocked) edges.push([i, j, dij]);
    }
  }
  edges.sort((a, b) => a[2] - b[2]);
  const mirror = (k) => k ^ 1; // Städte liegen als Spiegelpaare hintereinander
  const done = new Set();
  const key = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  const stepCost = (i) => {
    const t = map.cells[i];
    if (t === T.DEEP || t === T.MOUNTAIN) return Infinity;
    if (map.roads[i]) return 0.35;
    return t === T.WATER ? 6 : t === T.HILL ? 3 : t === T.FOREST ? 1.8 : 1;
  };
  for (const [a, b] of edges) {
    if (done.has(key(a, b))) continue;
    done.add(key(a, b));
    done.add(key(mirror(a), mirror(b)));
    const route = routeRoad(map, map.cellIndex(cities[a].x, cities[a].y), map.cellIndex(cities[b].x, cities[b].y), stepCost);
    if (!route) continue;
    const mirrored = route.map((i) => n - 1 - i);
    for (const r of [route, mirrored]) {
      for (let k = 0; k < r.length; k++) {
        map.roads[r[k]] = 1;
        // Diagonale Schritte schließen, damit die Straße lückenlos befahrbar ist
        if (k > 0) {
          const p = r[k - 1], c = r[k];
          if (p % w !== c % w && ((p / w) | 0) !== ((c / w) | 0)) {
            const corner = ((p / w) | 0) * w + (c % w);
            if (TERRAIN_INFO[map.cells[corner]].passable) map.roads[corner] = 1;
          }
        }
      }
      for (let k = 1; k < r.length; k++) link(r[k - 1], r[k]);
    }
  }

  // Netz einmal zeichnen: Abschnitte von Kreuzung zu Kreuzung, damit gemeinsame
  // Trassen nicht doppelt und leicht versetzt erscheinen
  const center = (i) => ({ x: (i % w + 0.5) * CELL, y: (((i / w) | 0) + 0.5) * CELL });
  const used = new Set();
  const ekey = (a, b) => (a < b ? a * n + b : b * n + a);
  const walk = (start, next) => {
    const chain = [start, next];
    used.add(ekey(start, next));
    let prev = start, cur = next;
    while (adj.get(cur).size === 2) {
      let nxt = -1;
      for (const o of adj.get(cur)) if (o !== prev) nxt = o;
      if (nxt < 0 || used.has(ekey(cur, nxt))) break;
      used.add(ekey(cur, nxt));
      chain.push(nxt);
      prev = cur; cur = nxt;
    }
    map.roadLines.push(chaikin(chain.map(center), 2));
  };
  for (const [node, nb] of adj) {
    if (nb.size === 2) continue;
    for (const o of nb) if (!used.has(ekey(node, o))) walk(node, o);
  }
  for (const [node, nb] of adj) {
    for (const o of nb) if (!used.has(ekey(node, o))) walk(node, o); // reine Ringe
  }
}

function routeRoad(map, start, goal, stepCost) {
  const { w, h } = map;
  const n = w * h;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const gx = goal % w, gy = (goal / w) | 0;
  const heur = (i) => {
    const dx = Math.abs(i % w - gx), dy = Math.abs(((i / w) | 0) - gy);
    return (Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy)) * 0.35;
  };
  g[start] = 0;
  heap.push(start, heur(start));
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy, len] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const c = stepCost(ni);
      if (c === Infinity) continue;
      const ng = g[cur] + len * c;
      if (ng < g[ni]) { g[ni] = ng; parent[ni] = cur; heap.push(ni, ng + heur(ni)); }
    }
  }
  if (g[goal] === Infinity) return null;
  const out = [];
  for (let c = goal; c !== -1; c = parent[c]) out.push(c);
  return out.reverse();
}

// Ecken abrunden, damit Straßen geschwungen statt treppig aussehen
function chaikin(pts, iterations) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}
