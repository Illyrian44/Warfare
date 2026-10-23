import { CELL, T, TERRAIN_INFO, ROAD_SPEED, BRIDGE_SPEED } from './config.js?v=104';

// Echte Karten (maps/*.json, gebaut mit scripts/build-maps.mjs aus Natural Earth und
// offenen Höhendaten). Höhe in der Spielskala 0..1, siehe classify.
export const MAPS = [
  { id: 'balkan', name: 'Balkan' },
  { id: 'mitteleuropa', name: 'Mitteleuropa' },
];

// Karte aus den Kartendaten bauen. seed: Zufall für diese Partie (KI, Produktion)
export function mapFromData(data, seed) {
  const dec = (b64) => {
    const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const { w, h } = data;
  const height = Float32Array.from(dec(data.height), (v) => v / 255);
  const forest = Float32Array.from(dec(data.forest), (v) => v / 255);
  const map = new GameMap(w, h, height, forest, seed, data.id);
  map.name = data.name;
  map.kmPerCell = data.kmPerCell;
  map.off = dec(data.off);
  map.rivers = dec(data.rivers);
  map.roads = dec(data.roads);
  // Flüsse sind flaches Wasser (langsam, schwer anzugreifen), Brücken über Straßen
  for (let i = 0; i < w * h; i++) if (map.rivers[i] && map.cells[i] !== T.DEEP) map.cells[i] = T.WATER;
  const world = (line) => line.map(([x, y]) => ({ x: x * CELL, y: y * CELL }));
  map.roadLines = data.roadLines.map((l) => chaikin(world(l), 1));
  map.riverLines = data.riverLines.map((l) => chaikin(world(l), 2));
  map.cities = data.cities.map((c) => ({ x: (c.x + 0.5) * CELL, y: (c.y + 0.5) * CELL, owner: 0, name: c.name, pop: c.pop }));
  return map;
}

// Kartendaten im Browser laden
export async function loadMap(id, seed, version = '') {
  const res = await fetch(`maps/${id}.json${version ? '?v=' + version : ''}`);
  if (!res.ok) throw new Error(`Karte ${id}: ${res.status}`);
  return mapFromData(await res.json(), seed);
}

export function classify(h, f) {
  if (h < 0.3) return T.DEEP;
  if (h < 0.36) return T.WATER;
  if (h >= 0.8) return T.MOUNTAIN;
  if (h >= 0.67) return T.HILL;
  if (f > 0.6) return T.FOREST;
  return T.PLAINS;
}

const COST_EXPAND_MAX = 3000; // Felder, die eine Suche mit Zusatzkosten höchstens prüft
const HEUR_SPEED = 1.15;      // angenommenes Tempo für die Schätzung der Restkosten (Straße 1,6)

export class GameMap {
  constructor(w, h, height, forest, seed, id) {
    this.w = w;
    this.h = h;
    this.height = height;
    this.forest = forest;
    this.seed = seed;
    this.id = id;
    this.worldW = w * CELL;
    this.worldH = h * CELL;
    this.cells = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) this.cells[i] = classify(height[i], forest[i]);
    this.cities = [];
    this.roads = new Uint8Array(w * h); // 1 = Straße bzw. Brücke
    this.roadLines = [];                // Straßenverläufe in Weltkoordinaten (zum Zeichnen)
    this.riverLines = [];
    this.off = new Uint8Array(w * h);   // 1 = Ausland: sichtbar, aber nicht spielbar
    this.rivers = new Uint8Array(w * h);
  }

  // Spielbares Land (zählt für den Landanteil und kann besessen werden)
  isLand(i) {
    return this.cells[i] !== T.DEEP && !this.off[i];
  }

  // Bewegungstempo einer Zelle, Straßen eingerechnet
  cellSpeed(i) {
    if (this.off[i]) return 0;
    const t = this.cells[i];
    if (this.roads[i] && TERRAIN_INFO[t].passable) return t === T.WATER ? BRIDGE_SPEED : ROAD_SPEED;
    return TERRAIN_INFO[t].speed;
  }

  // Bewegung und Wegfindung nutzen dasselbe Zellraster (sonst blockieren an Bergrändern
  // weich interpolierte Höhen Wege, die A* für frei hält)
  speedAt(wx, wy) {
    if (wx < 0 || wy < 0 || wx >= this.worldW || wy >= this.worldH) return 0;
    return this.cellSpeed(this.cellIndex(wx, wy));
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

  // Gelände des Zellrasters, wie es Bewegung und Wegfindung verwenden
  cellTerrainAt(wx, wy) {
    if (wx < 0 || wy < 0 || wx >= this.worldW || wy >= this.worldH) return T.DEEP;
    return this.cells[this.cellIndex(wx, wy)];
  }

  passableAt(wx, wy) {
    if (wx < 0 || wy < 0 || wx >= this.worldW || wy >= this.worldH) return false;
    return this.cellPassable(this.cellIndex(wx, wy));
  }

  cellIndex(wx, wy) {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor(wx / CELL)));
    const cy = Math.min(this.h - 1, Math.max(0, Math.floor(wy / CELL)));
    return cy * this.w + cx;
  }

  cellPassable(i) {
    return !this.off[i] && TERRAIN_INFO[this.cells[i]].passable;
  }

  // Zusammenhängende Landmassen (einmal berechnet): zwischen verschiedenen Gebieten
  // gibt es keinen Weg, A* müsste sonst die ganze Landmasse absuchen
  regionOf(i) {
    if (!this.regions) {
      const { w, h } = this;
      const reg = new Int32Array(w * h).fill(-1);
      let id = 0;
      for (let s = 0; s < w * h; s++) {
        if (reg[s] >= 0 || !this.cellPassable(s)) continue;
        const stack = [s];
        reg[s] = id;
        while (stack.length) {
          const c = stack.pop();
          const cx = c % w;
          for (const n of [cx > 0 ? c - 1 : -1, cx < w - 1 ? c + 1 : -1, c - w, c + w]) {
            if (n < 0 || n >= w * h || reg[n] >= 0 || !this.cellPassable(n)) continue;
            reg[n] = id;
            stack.push(n);
          }
        }
        id++;
      }
      this.regions = reg;
    }
    return this.regions[i];
  }

  // A* auf dem Zellgitter, Kosten = Weglänge / Geländetempo. Liefert Weltpunkte.
  // opts.cost(i): Zusatzkosten je Zelle (z. B. Feindgebiet), opts.safe(x, y): Abkürzungen nur über sichere Punkte.
  // Mit Zusatzkosten ist die Schätzung zum Ziel schwach; wird die Suche zu groß (Ziel jenseits
  // von teurem Gelände), sucht sie stattdessen ohne Zusatzkosten (sonst ruckelt das Spiel);
  // mit opts.strict gibt es dann keinen Weg (null)
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
    if (this.cellPassable(start) && this.regionOf(start) !== this.regionOf(goal)) return null;
    // Arbeitsfelder wiederverwenden: ein Stempel markiert, was zu dieser Suche gehört
    // (spart je Suche ~225 KB neuen Speicher und damit Pausen der Speicherbereinigung)
    const n = w * h;
    if (!this.search) {
      this.search = { g: new Float32Array(n), parent: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n), stamp: 0, heap: new MinHeap() };
    }
    const { g, parent, seen, closed, heap } = this.search;
    const stamp = ++this.search.stamp;
    heap.clear();
    const gx = goal % w, gy = Math.floor(goal / w);
    const heur = (i) => {
      const dx = Math.abs(i % w - gx), dy = Math.abs(Math.floor(i / w) - gy);
      // Schätzung zwischen Straßen- und Geländetempo: findet Straßenumwege meist noch, sucht
      // auf den großen Karten aber nicht die halbe Karte ab (Wege höchstens wenig länger)
      return (Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy)) / HEUR_SPEED;
    };
    g[start] = 0;
    seen[start] = stamp;
    parent[start] = -1;
    heap.push(start, heur(start));
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    let found = false;
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === stamp) continue;
      if (cur === goal) { found = true; break; }
      closed[cur] = stamp;
      if (opts && opts.cost && ++expanded > COST_EXPAND_MAX) return opts.strict ? null : this.findPath(sx, sy, tx, ty, null);
      const cx = cur % w, cy = Math.floor(cur / w);
      const curSpeed = this.cellSpeed(cur) || 0.5;
      for (const [dx, dy, len] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (closed[ni] === stamp || !this.cellPassable(ni)) continue;
        if (dx && dy && (!this.cellPassable(cy * w + nx) || !this.cellPassable(ny * w + cx))) continue;
        const sp = (this.cellSpeed(ni) + curSpeed) / 2;
        const ng = g[cur] + len / sp + (opts && opts.cost ? len * opts.cost(ni) : 0);
        if (seen[ni] !== stamp || ng < g[ni]) {
          g[ni] = ng;
          seen[ni] = stamp;
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

  // Wegpunkte überspringen, solange die direkte Linie auf gleich gutem Gelände bleibt.
  // Den weitesten erreichbaren Punkt erst in wachsenden Sprüngen, dann durch Halbieren
  // suchen (statt jede Abkürzung vom Ende her zu prüfen)
  smoothPath(from, pts, safe = null) {
    const out = [];
    let anchor = from;
    let i = 0;
    while (i < pts.length) {
      let lo = i, hi = i + 1, step = 1;
      while (hi < pts.length && this.clearLine(anchor, pts[hi], safe)) { lo = hi; step *= 2; hi = lo + step; }
      hi = Math.min(hi, pts.length);
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.clearLine(anchor, pts[mid], safe)) lo = mid; else hi = mid;
      }
      out.push(pts[lo]);
      anchor = pts[lo];
      i = lo + 1;
    }
    return out;
  }

  clearLine(a, b, safe = null) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    const steps = Math.ceil(d / 2); // fein genug, um keine Bergzelle an der Ecke zu schneiden
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

export class MinHeap {
  constructor() { this.items = []; this.prio = []; }
  get size() { return this.items.length; }
  clear() { this.items.length = 0; this.prio.length = 0; }
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
