#!/usr/bin/env node
// Baut die echten Karten (maps/*.json) aus offenen Geodaten. Läuft einmalig beim Entwickeln,
// nicht im Spiel:
//   node scripts/build-maps.mjs <Ordner mit Natural-Earth-GeoJSON und Kachel-Zwischenspeicher>
// Quellen:
//   - Natural Earth (gemeinfrei): Seen, Flüsse, Orte, Straßen – GeoJSON aus
//     github.com/nvkelso/natural-earth-vector (ne_10m_lakes, ne_10m_lakes_europe,
//     ne_10m_rivers_lake_centerlines, ne_10m_rivers_europe, ne_10m_populated_places_simple,
//     ne_10m_roads, ne_50m_admin_0_countries)
//   - Höhen: Terrain Tiles (Mapzen/Tilezen, AWS Open Data), Kodierung „terrarium“
// Ergebnis je Region: Raster aus Höhe und Wald (je 1 Byte), Flüsse, Straßen, „Ausland“ (Land
// außerhalb der Region und unerreichbare Inseln: sichtbar, aber nicht spielbar), Städte mit Namen.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const REGIONS = {
  balkan: {
    name: 'Balkan', lon: [13.3, 29.8], lat: [39.5, 46.8], km: 6, cities: 28, minKm: 75, riverRank: 7, roadRank: 5,
    countries: ['SVN', 'HRV', 'BIH', 'SRB', 'MNE', 'KOS', 'ALB', 'MKD', 'GRC', 'BGR', 'ROU', 'MDA', 'HUN'],
  },
  mitteleuropa: {
    name: 'Mitteleuropa', lon: [4.4, 19.6], lat: [46.4, 55.2], km: 6, cities: 28, minKm: 75, riverRank: 7, roadRank: 5,
    countries: ['DEU', 'POL', 'CZE', 'SVK', 'AUT', 'HUN', 'NLD', 'BEL', 'LUX', 'CHE', 'LIE', 'DNK'],
  },
};
// Deutsche Namen, wo sie üblich sind
const GERMAN = {
  Vienna: 'Wien', Munich: 'München', Prague: 'Prag', Warsaw: 'Warschau', Cologne: 'Köln', Bucharest: 'Bukarest',
  Belgrade: 'Belgrad', Hanover: 'Hannover', 'Liège': 'Lüttich', Luxembourg: 'Luxemburg', Trieste: 'Triest',
  Athens: 'Athen', Copenhagen: 'Kopenhagen', Brussels: 'Brüssel', 'The Hague': 'Den Haag', Nuremberg: 'Nürnberg',
  Zurich: 'Zürich', Geneva: 'Genf', Krakow: 'Krakau', 'Kraków': 'Krakau', Antwerp: 'Antwerpen', Ghent: 'Gent',
  Brunswick: 'Braunschweig', Aachen: 'Aachen', Gdansk: 'Danzig', 'Gdańsk': 'Danzig', 'Wrocław': 'Breslau',
  Szczecin: 'Stettin', 'Poznań': 'Posen', Thessaloniki: 'Thessaloniki', Chisinau: 'Chișinău', Sofia: 'Sofia',
};
const ZOOM = 7;           // Kachelstufe der Höhendaten (~1,2 km je Pixel bei 45° N)
const SUB = 3;            // Stichproben je Feld und Richtung
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const dir = process.argv[2];
if (!dir) { console.error('Aufruf: node scripts/build-maps.mjs <Datenordner>'); process.exit(1); }
const outDir = new URL('../maps/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });
const geo = (f) => JSON.parse(fs.readFileSync(path.join(dir, f + '.geojson'), 'utf8')).features;

// ---------- PNG lesen (8 Bit RGB/RGBA, wie die Terrain Tiles) ----------
function decodePng(buf) {
  let p = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8) throw new Error('nur 8 Bit'); }
    else if (kind === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error('PNG-Farbtyp ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

// ---------- Höhen aus den Kacheln ----------
const tileX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const tileY = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;

async function loadTiles(r) {
  const x0 = Math.floor(tileX(r.lon[0], ZOOM)), x1 = Math.floor(tileX(r.lon[1], ZOOM));
  const y0 = Math.floor(tileY(r.lat[1], ZOOM)), y1 = Math.floor(tileY(r.lat[0], ZOOM));
  const cache = path.join(dir, 'tiles');
  fs.mkdirSync(cache, { recursive: true });
  const tiles = new Map();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const f = path.join(cache, `${ZOOM}-${x}-${y}.png`);
      if (!fs.existsSync(f)) {
        // curl statt fetch: nutzt den eingestellten Proxy
        execFileSync('curl', ['-sSf', '--retry', '3', '-o', f, TILE_URL(ZOOM, x, y)]);
      }
      tiles.set(`${x},${y}`, decodePng(fs.readFileSync(f)));
    }
  }
  return (lon, lat) => {
    const fx = tileX(lon, ZOOM), fy = tileY(lat, ZOOM);
    const t = tiles.get(`${Math.floor(fx)},${Math.floor(fy)}`);
    if (!t) return -100;
    const px = Math.min(t.w - 1, Math.floor((fx % 1) * t.w)), py = Math.min(t.h - 1, Math.floor((fy % 1) * t.h));
    const o = (py * t.w + px) * t.bpp;
    return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768;
  };
}

// ---------- Geometrie ----------
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
const linesOf = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);

// Douglas-Peucker für die Zeichenlinien
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let best = -1, bd = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
    if (d > bd) { bd = d; best = i; }
  }
  if (bd <= eps) return [a, b];
  return simplify(pts.slice(0, best + 1), eps).slice(0, -1).concat(simplify(pts.slice(best), eps));
}

// ---------- Rauschen für Wälder ----------
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
const fbm = (x, y, s) => valueNoise(x, y, s) * 0.55 + valueNoise(x * 2.1, y * 2.1, s + 1) * 0.3 + valueNoise(x * 4.3, y * 4.3, s + 2) * 0.15;

// ---------- Höhe in die Spielskala (0..1, siehe classify in js/map.js) ----------
// Wasser < 0,36 (tief < 0,30), Hügel ab 0,67, unpassierbares Gebirge ab 0,80, Schnee ab 0,88
function landHeight(m) {
  const pts = [[0, 0.38], [250, 0.5], [700, 0.67], [1650, 0.8], [2300, 0.9], [3200, 1]];
  if (m <= 0) return 0.38;
  for (let i = 1; i < pts.length; i++) {
    const [a, ha] = pts[i - 1], [b, hb] = pts[i];
    if (m <= b) return ha + (hb - ha) * (m - a) / (b - a);
  }
  return 1;
}

async function build(id) {
  const r = REGIONS[id];
  const lat0 = (r.lat[0] + r.lat[1]) / 2;
  const kmLon = 111.32 * Math.cos(lat0 * Math.PI / 180), kmLat = 110.57;
  const w = Math.round((r.lon[1] - r.lon[0]) * kmLon / r.km);
  const h = Math.round((r.lat[1] - r.lat[0]) * kmLat / r.km);
  const n = w * h;
  // Feldkoordinaten <-> Länge/Breite (Plattkarte, Breitengrad oben = Norden)
  const toLon = (x) => r.lon[0] + x / w * (r.lon[1] - r.lon[0]);
  const toLat = (y) => r.lat[1] - y / h * (r.lat[1] - r.lat[0]);
  const toX = (lon) => (lon - r.lon[0]) / (r.lon[1] - r.lon[0]) * w;
  const toY = (lat) => (r.lat[1] - lat) / (r.lat[1] - r.lat[0]) * h;
  const inside = ([lon, lat]) => lon >= r.lon[0] - 0.5 && lon <= r.lon[1] + 0.5 && lat >= r.lat[0] - 0.5 && lat <= r.lat[1] + 0.5;
  console.log(`${r.name}: ${w} × ${h} Felder à ${r.km} km`);

  const elev = await loadTiles(r);
  const mean = new Float32Array(n), peak = new Float32Array(n), landFrac = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, mx = -1e9, land = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const e = elev(toLon(x + (sx + 0.5) / SUB), toLat(y + (sy + 0.5) / SUB));
          if (e > 0) { land++; s += e; mx = Math.max(mx, e); }
        }
      }
      const i = y * w + x;
      landFrac[i] = land / (SUB * SUB);
      mean[i] = land ? s / land : 0;
      peak[i] = mx;
    }
  }

  // Länder der Region (Feldmittelpunkt in einem ihrer Umrisse); alles andere ist Ausland
  const inRegion = new Uint8Array(n);
  for (const f of geo('ne_50m_admin_0_countries')) {
    if (!r.countries.includes(f.properties.ADM0_A3)) continue;
    for (const poly of polygonsOf(f.geometry)) {
      const outer = poly[0];
      if (!outer.some(inside)) continue;
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const [lon, lat] of outer) { bx0 = Math.min(bx0, toX(lon)); bx1 = Math.max(bx1, toX(lon)); by0 = Math.min(by0, toY(lat)); by1 = Math.max(by1, toY(lat)); }
      for (let y = Math.max(0, Math.floor(by0)); y <= Math.min(h - 1, Math.ceil(by1)); y++) {
        for (let x = Math.max(0, Math.floor(bx0)); x <= Math.min(w - 1, Math.ceil(bx1)); x++) {
          if (inRing(toLon(x + 0.5), toLat(y + 0.5), outer)) inRegion[y * w + x] = 1;
        }
      }
    }
  }

  // Seen
  const water = new Uint8Array(n); // 1 = See, 2 = Fluss
  for (const f of [...geo('ne_10m_lakes'), ...geo('ne_10m_lakes_europe')]) {
    for (const poly of polygonsOf(f.geometry)) {
      const outer = poly[0];
      if (!outer.some(inside)) continue;
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const [lon, lat] of outer) { bx0 = Math.min(bx0, toX(lon)); bx1 = Math.max(bx1, toX(lon)); by0 = Math.min(by0, toY(lat)); by1 = Math.max(by1, toY(lat)); }
      for (let y = Math.max(0, Math.floor(by0)); y <= Math.min(h - 1, Math.ceil(by1)); y++) {
        for (let x = Math.max(0, Math.floor(bx0)); x <= Math.min(w - 1, Math.ceil(bx1)); x++) {
          const lon = toLon(x + 0.5), lat = toLat(y + 0.5);
          if (inRing(lon, lat, outer) && !poly.slice(1).some((hole) => inRing(lon, lat, hole))) water[y * w + x] = 1;
        }
      }
    }
  }

  // Flüsse: nur große (scalerank klein); Rasterung 4-zusammenhängend, damit kein Weg
  // diagonal durchschlüpft. Zum Zeichnen bleiben die Linien als Vektoren erhalten.
  const riverLines = [];
  const seenRiver = new Set();
  const markLine = (pts, fn) => {
    for (let k = 1; k < pts.length; k++) {
      let [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3) + 1;
      let px = -1, py = -1;
      for (let s = 0; s <= steps; s++) {
        const cx = Math.floor(x0 + (x1 - x0) * s / steps), cy = Math.floor(y0 + (y1 - y0) * s / steps);
        if (cx === px && cy === py) continue;
        if (px >= 0 && cx !== px && cy !== py) fn(cx, py); // Ecke füllen
        fn(cx, cy);
        px = cx; py = cy;
      }
    }
  };
  for (const f of [...geo('ne_10m_rivers_lake_centerlines'), ...geo('ne_10m_rivers_europe')]) {
    const p = f.properties;
    if (p.featurecla && !/River/i.test(p.featurecla)) continue;
    if ((p.scalerank ?? 9) > r.riverRank) continue;
    for (const line of linesOf(f.geometry)) {
      if (!line.some(inside)) continue;
      const pts = line.map(([lon, lat]) => [toX(lon), toY(lat)]);
      const key = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(';');
      if (seenRiver.has(key)) continue;
      seenRiver.add(key);
      markLine(pts, (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h && !water[y * w + x]) water[y * w + x] = 2; });
      riverLines.push(simplify(pts, 0.35).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]));
    }
  }

  // Meer: Abstand zur Küste für die Wassertiefe (in Feldern)
  const sea = new Uint8Array(n);
  for (let i = 0; i < n; i++) sea[i] = landFrac[i] < 0.5 ? 1 : 0;
  const coastDist = new Float32Array(n).fill(99);
  const queue = [];
  for (let i = 0; i < n; i++) if (!sea[i]) { coastDist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (coastDist[j] > coastDist[i] + 1) { coastDist[j] = coastDist[i] + 1; queue.push(j); }
    }
  }

  // Höhe (Spielskala) und Wald
  const height = new Uint8Array(n), forest = new Uint8Array(n);
  const seed = [...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0;
    let hv;
    if (sea[i]) hv = 0.3 - Math.min(coastDist[i], 5) * 0.03;  // tiefes Meer, an der Küste heller
    else if (water[i] === 1) hv = 0.33;                       // See (flach, begehbar wie bisher)
    else {
      // Gipfel zählen mit: Kämme werden zu Gebirge, breite Täler bleiben passierbar
      const m = mean[i] * 0.75 + Math.max(mean[i], peak[i]) * 0.25;
      hv = landHeight(m);
    }
    height[i] = Math.round(Math.max(0, Math.min(1, hv)) * 255);
    // Wald: Rauschen, bevorzugt im Mittelgebirge, selten in den Ebenen und im Hochgebirge
    const e = mean[i];
    const pref = e < 150 ? -0.12 : e < 400 ? 0 : e < 1400 ? 0.12 : -0.15;
    const fv = fbm(x / 7, y / 7, seed) + pref;
    forest[i] = Math.round(Math.max(0, Math.min(1, (fv - 0.5) * 1.8 + 0.5)) * 255);
  }
  const H = (i) => height[i] / 255;
  // Ausland: Land außerhalb der Region; dazu Landstücke, die vom größten zusammenhängenden
  // Gebiet getrennt sind (Inseln, abgeschnittene Zipfel)
  const off = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!sea[i] && !inRegion[i]) off[i] = 1;
  const passable = (i) => !off[i] && H(i) >= 0.3 && H(i) < 0.8;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0 || !passable(i) || sea[i]) continue;
    const id = sizes.length, stack = [i];
    comp[i] = id;
    let cnt = 0;
    while (stack.length) {
      const c = stack.pop(); cnt++;
      const x = c % w, y = (c / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (comp[j] < 0 && passable(j) && !sea[j]) { comp[j] = id; stack.push(j); }
      }
    }
    sizes.push(cnt);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  for (let i = 0; i < n; i++) if (!sea[i] && comp[i] !== main && passable(i)) off[i] = 1;

  // Straßen: Fern- und Hauptstraßen; Gebirgsfelder auf einer Straße werden zum Pass (Hügel)
  const road = new Uint8Array(n);
  const roadLines = [];
  for (const f of geo('ne_10m_roads')) {
    const p = f.properties;
    if (p.continent !== 'Europe' || !/Highway|Road/.test(p.type || '')) continue;
    if ((p.scalerank ?? 9) > r.roadRank) continue;
    for (const line of linesOf(f.geometry)) {
      if (!line.some(inside)) continue;
      const pts = line.map(([lon, lat]) => [toX(lon), toY(lat)]);
      let onMap = false;
      markLine(pts, (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const i = y * w + x;
        if (sea[i] || off[i]) return;
        if (H(i) >= 0.8) height[i] = Math.round(0.78 * 255); // Pass
        road[i] = 1;
        onMap = true;
      });
      if (onMap) roadLines.push(simplify(pts, 0.25).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]));
    }
  }

  // Städte: die größten Orte mit Mindestabstand, Hauptstädte zuerst
  const places = geo('ne_10m_populated_places_simple')
    .map((f) => f.properties)
    .filter((p) => p.longitude >= r.lon[0] + 0.15 && p.longitude <= r.lon[1] - 0.15 && p.latitude >= r.lat[0] + 0.15 && p.latitude <= r.lat[1] - 0.15)
    .filter((p) => r.countries.includes(p.adm0_a3))
    .map((p) => ({ name: GERMAN[p.name] || p.name, pop: p.pop_max || 0, cap: p.adm0cap ? 1 : 0, x: toX(p.longitude), y: toY(p.latitude) }))
    .sort((a, b) => (b.cap - a.cap) || (b.pop - a.pop));
  const minD = r.minKm / r.km;
  const cities = [];
  for (const c of places) {
    if (cities.length >= r.cities) break;
    let cx = Math.floor(c.x), cy = Math.floor(c.y);
    // auf begehbares Land rücken (Hafenstädte liegen oft auf einem Meeresfeld)
    if (!passable(cy * w + cx) || water[cy * w + cx] || comp[cy * w + cx] !== main) {
      let best = null, bd = Infinity;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const i = y * w + x;
        if (!passable(i) || water[i] || H(i) >= 0.67 || comp[i] !== main) continue;
        if (Math.hypot(dx, dy) < bd) { bd = Math.hypot(dx, dy); best = [x, y]; }
      }
      if (!best) continue;
      [cx, cy] = best;
    }
    if (cities.some((o) => Math.hypot(o.x - cx, o.y - cy) < minD)) continue;
    cities.push({ name: c.name, pop: c.pop, x: cx, y: cy });
  }

  const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  const rivers = new Uint8Array(n);
  for (let i = 0; i < n; i++) rivers[i] = water[i] === 2 && !sea[i] ? 1 : 0;
  const out = {
    id, name: r.name, kmPerCell: r.km, w, h, bounds: { lon: r.lon, lat: r.lat },
    height: b64(height), forest: b64(forest), rivers: b64(rivers), roads: b64(road), off: b64(off),
    riverLines, roadLines, cities,
    sources: 'Natural Earth (gemeinfrei); Höhen: Terrain Tiles von Mapzen/Tilezen (AWS Open Data)',
  };
  fs.writeFileSync(path.join(outDir, id + '.json'), JSON.stringify(out));
  const counts = [0, 0, 0, 0, 0, 0];
  let offCount = 0;
  for (let i = 0; i < n; i++) {
    if (off[i]) { offCount++; continue; }
    const v = H(i); counts[sea[i] ? 0 : water[i] ? 1 : v >= 0.8 ? 5 : v >= 0.67 ? 4 : forest[i] / 255 > 0.6 ? 3 : 2]++;
  }
  console.log(`  Meer ${counts[0]}, Wasser ${counts[1]}, Ebene ${counts[2]}, Wald ${counts[3]}, Hügel ${counts[4]}, Gebirge ${counts[5]}, Ausland ${offCount}; ` +
    `${cities.length} Städte, ${roadLines.length} Straßenzüge, ${riverLines.length} Flussläufe, ${(fs.statSync(path.join(outDir, id + '.json')).size / 1024).toFixed(0)} KB`);
}

for (const id of process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(REGIONS)) await build(id);
