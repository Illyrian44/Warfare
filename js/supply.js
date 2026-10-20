import { CELL, KM, TERRAIN_INFO, HOURS_PER_SECOND, SUPPLY } from './config.js?v=61';
import { MinHeap } from './map.js?v=61';

// Nachschub wie in HOI4, vereinfacht: Depot (Stadt) -> Route über eigenes Gebiet -> Kompanie.
//
// Ablauf je Lieferung:
//   1. Jede Kompanie verbraucht ihren Vorrat (u.supply, 0..1), im Gefecht schneller.
//   2. Sie fordert Verbrauch plus Auffüllen bei ihrem Depot an. Wie viel ankommt, hängt
//      von der Fahrzeit der LKW ab (u.supplyEff: voll bis fullHours, nichts ab noneHours).
//   3. Alle Depots, die über eigenes Gebiet verbunden sind, bilden einen Pool (wie die
//      Eisenbahn in HOI4, die Nachschub aus dem ganzen Land zum Frontknoten bringt).
//      Reicht die Lieferleistung eines Pools nicht, wird der Mangel gleichmäßig auf alle
//      seine Kompanien verteilt. Ein Kessel mit eigener Stadt bildet einen eigenen Pool.
//   4. deliver() bringt die Menge an. Heute sofort; mit SUPPLY.convoys würde dispatch()
//      stattdessen eine Kolonne auf route() losschicken, die nach der Fahrzeit liefert.
//      Bedarf, Netz, Verteilung und Vorrat bleiben dafür unverändert.
export class SupplyNetwork {
  constructor(game) {
    this.game = game;
    const n = game.map.w * game.map.h;
    // Je Seite: Fahrzeit in Stunden, liefernde Stadt und Vorgänger-Zelle (für Routen).
    // Float64: mit Float32 würden gerundete Zeiten als Verbesserung gelten und Felder
    // immer wieder neu besucht
    this.nets = [null, 1, 2].map((p) => p && {
      hours: new Float64Array(n).fill(Infinity), depot: new Int16Array(n).fill(-1),
      parent: new Int32Array(n).fill(-1), danger: new Uint8Array(n), pool: new Int32Array(n),
    });
    this.netTimer = [0, 0, SUPPLY.interval / 2]; // Seiten versetzt rechnen
    this.tickTimer = 0;
    this.convoys = []; // vorbereitet für LKW-Kolonnen
    for (let p = 1; p <= 2; p++) this.compute(p);
  }

  step(dt) {
    for (let p = 1; p <= 2; p++) {
      this.netTimer[p] -= dt;
      if (this.netTimer[p] <= 0) { this.netTimer[p] = SUPPLY.interval; this.compute(p); }
    }
    this.tickTimer += dt;
    if (this.tickTimer >= SUPPLY.tick) {
      this.distribute(this.tickTimer * HOURS_PER_SECOND);
      this.tickTimer = 0;
    }
  }

  // Netz einer Seite: Dijkstra von allen eigenen Städten über eigenes Gebiet, Kosten =
  // LKW-Fahrzeit in Stunden. Feindgebiet sperrt, Feindnähe bremst; Suche endet bei noneHours.
  compute(p) {
    const g = this.game, map = g.map;
    const { w, h } = map;
    const net = this.nets[p];
    const { hours, depot, parent, danger } = net;
    hours.fill(Infinity);
    depot.fill(-1);
    parent.fill(-1);
    danger.fill(0);
    const r = SUPPLY.enemyKm * KM / CELL;
    for (const e of g.units) {
      if (e.owner === p) continue;
      const cx = e.x / CELL, cy = e.y / CELL;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) danger[y * w + x] = 1;
        }
      }
    }
    const heap = new MinHeap();
    for (const c of g.cities) {
      if (c.owner !== p) continue;
      const i = map.cellIndex(c.x, c.y);
      hours[i] = 0;
      depot[i] = c.id;
      heap.push(i, 0);
    }
    const kmPerCell = CELL / KM;
    const speed = (i) => {
      if (map.roads[i] && TERRAIN_INFO[map.cells[i]].passable) return SUPPLY.roadKmh;
      return SUPPLY.truckKmh[map.cells[i]];
    };
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    const tr = g.territory;
    while (heap.size) {
      const prio = heap.prio[0];
      const cur = heap.pop();
      const hc = hours[cur];
      if (prio > hc) continue; // veralteter Eintrag, Feld schon günstiger erreicht
      const cx = cur % w, cy = (cur / w) | 0;
      const sc = speed(cur) || 1;
      for (const [dx, dy, len] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (tr[ni] !== p) continue;
        const sn = speed(ni);
        if (!sn) continue;
        if (dx && dy && (!speed(cy * w + nx) || !speed(ny * w + cx))) continue;
        let step = len * kmPerCell / ((sn + sc) / 2);
        if (danger[ni]) step *= SUPPLY.enemySlow;
        const nh = hc + step;
        if (nh >= hours[ni] || nh > SUPPLY.noneHours) continue;
        hours[ni] = nh;
        depot[ni] = depot[cur];
        parent[ni] = cur;
        heap.push(ni, nh);
      }
    }
    this.pools(p);
    net.time = g.time;
  }

  // Zusammenhängende Teile des eigenen Gebiets (für LKW befahrbar) nummerieren;
  // Depots im selben Teil teilen sich ihre Lieferleistung
  pools(p) {
    const g = this.game, map = g.map, { w, h } = map;
    const pool = this.nets[p].pool;
    const tr = g.territory;
    pool.fill(-1);
    let id = 0;
    for (const c of g.cities) {
      if (c.owner !== p) continue;
      const s = map.cellIndex(c.x, c.y);
      if (pool[s] >= 0) continue;
      pool[s] = id;
      const stack = [s];
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j < 0 || j >= w * h || pool[j] >= 0 || tr[j] !== p || !SUPPLY.truckKmh[map.cells[j]]) continue;
          pool[j] = id;
          stack.push(j);
        }
      }
      id++;
    }
  }

  // Bestes erreichbares Feld für eine Position (Kompanien am Rand des eigenen Gebiets
  // oder kurz im Feindgebiet nutzen das nächste versorgte Feld): Index oder -1
  cellFor(p, x, y) {
    const map = this.game.map, { w, h } = map;
    const hours = this.nets[p].hours;
    const i = map.cellIndex(x, y);
    if (hours[i] < Infinity) return i;
    const cx = i % w, cy = (i / w) | 0;
    let best = -1, bh = Infinity;
    for (let r = 1; r <= SUPPLY.reach && best < 0; r++) {
      for (let yy = cy - r; yy <= cy + r; yy++) {
        for (let xx = cx - r; xx <= cx + r; xx++) {
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (hours[j] < bh) { bh = hours[j]; best = j; }
        }
      }
    }
    return best;
  }

  // Lieferquote nach Fahrzeit: 1 bis fullHours, linear bis 0 bei noneHours
  efficiency(hours) {
    if (hours <= SUPPLY.fullHours) return 1;
    if (hours >= SUPPLY.noneHours) return 0;
    return 1 - (hours - SUPPLY.fullHours) / (SUPPLY.noneHours - SUPPLY.fullHours);
  }

  // Verbrauch, Anforderung, Verteilung je Depot und Lieferung (dh in Spielstunden)
  distribute(dh) {
    const g = this.game;
    for (const c of g.cities) c.supplyLoad = 0;
    const requests = new Map(); // Depot (Stadt-ID) -> [{ u, amount }]
    for (const u of g.units) {
      const use = SUPPLY.usePerHour * (u.target ? SUPPLY.combatUse : 1) * dh;
      u.supply = Math.max(0, u.supply - use);
      const net = this.nets[u.owner];
      const i = this.cellFor(u.owner, u.x, u.y);
      u.supplyHours = i >= 0 ? net.hours[i] : Infinity;
      u.supplyEff = i >= 0 ? this.efficiency(net.hours[i]) : 0;
      u.depot = i >= 0 ? net.depot[i] : -1;
      if (u.depot < 0 || !u.supplyEff) continue;
      const want = Math.min(1 - u.supply, use + SUPPLY.refillPerHour * dh) * u.supplyEff;
      if (want <= 0) continue;
      if (!requests.has(u.depot)) requests.set(u.depot, []);
      requests.get(u.depot).push({ u, amount: want });
    }
    // Anforderungen je Pool sammeln (Seite + Nummer des zusammenhängenden Gebiets)
    const poolOf = (c) => (c.owner ? c.owner + ':' + this.nets[c.owner].pool[g.map.cellIndex(c.x, c.y)] : null);
    const pools = new Map(); // Pool -> { cities, list }
    for (const [cityId, list] of requests) {
      const city = g.cities[cityId];
      if (!city || city.owner !== list[0].u.owner) continue;
      const key = poolOf(city);
      if (!pools.has(key)) pools.set(key, { list: [] });
      for (const r of list) pools.get(key).list.push({ ...r, city });
    }
    const capacity = new Map();
    for (const c of g.cities) if (c.owner) capacity.set(poolOf(c), (capacity.get(poolOf(c)) || 0) + SUPPLY.depotPerHour);
    for (const [key, { list }] of pools) {
      const load = list.reduce((s, r) => s + r.amount * SUPPLY.demand[r.u.type], 0);
      const cap = (capacity.get(key) || 0) * dh;
      const ratio = load > 0 ? Math.min(1, cap / load) : 1;
      for (const c of g.cities) if (poolOf(c) === key) c.supplyLoad = load / cap; // Auslastung des Pools
      for (const r of list) this.dispatch(r.city, r.u, r.amount * ratio);
    }
  }

  // Lieferung losschicken. Heute kommt sie sofort an; mit LKW-Kolonnen (SUPPLY.convoys)
  // würde hier eine Kolonne mit Ladung entlang route() starten und erst nach der Fahrzeit
  // deliver() aufrufen.
  dispatch(city, u, amount) {
    this.deliver(u, amount);
  }

  deliver(u, amount) {
    u.supply = Math.min(1, u.supply + amount);
  }

  // Nachschubweg vom Depot bis zur Position (Weltpunkte), z. B. zum Anzeigen oder später
  // für Kolonnen; leer, wenn die Position abgeschnitten ist
  route(p, x, y) {
    const map = this.game.map, { w } = map;
    const parent = this.nets[p].parent;
    let i = this.cellFor(p, x, y);
    const out = [];
    for (let guard = 0; i >= 0 && guard < 10000; guard++) {
      out.push({ x: (i % w + 0.5) * CELL, y: (((i / w) | 0) + 0.5) * CELL });
      i = parent[i];
    }
    return out.reverse();
  }
}
