import { CELL, T, TRADE } from './config.js?v=110';

// Handel wie bei OpenFront: Städte schicken regelmäßig Kolonnen über Land zu anderen Städten
// derselben Seite (später auch zu Verbündeten), Häfen schicken Schiffe zu anderen Häfen im
// selben Meer. Bei der Ankunft gibt es Geld, je nach Länge des Wegs und Größe der Städte.
// Kolonnen fahren nur durch eigenes (oder verbündetes) Gebiet; kommt ihnen ein Feind zu nahe
// oder wird ihr Weg zu Feindgebiet, sind sie verloren. Schiffe sind auf See sicher.
export class Trade {
  constructor(game) {
    this.game = game;
    this.convoys = [];
    this.landTimer = new Map(); // Stadt -> Sekunden bis zur nächsten Kolonne
    this.seaTimer = new Map();
    this.paths = new Map();     // Weg zwischen zwei Städten (Land: mit Zeitstempel)
    this.buildSea();
  }

  // Meere als Zusammenhangskomponenten des tiefen Wassers; je Küstenstadt ihr Meeresfeld
  buildSea() {
    const map = this.game.map, { w, h } = map;
    const comp = new Int32Array(w * h).fill(-1);
    let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (comp[s] >= 0 || map.cells[s] !== T.DEEP) continue;
      const stack = [s];
      comp[s] = id;
      while (stack.length) {
        const c = stack.pop(), x = c % w;
        for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w]) {
          if (n < 0 || n >= w * h || comp[n] >= 0 || map.cells[n] !== T.DEEP) continue;
          comp[n] = id;
          stack.push(n);
        }
      }
      id++;
    }
    this.seaComp = comp;
    this.seaCell = new Map();
    for (const c of this.game.cities) {
      if (!c.coastal) continue;
      const cx = Math.floor(c.x / CELL), cy = Math.floor(c.y / CELL);
      let best = -1, bd = Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h || comp[y * w + x] < 0) continue;
          if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = y * w + x; }
        }
      }
      if (best >= 0) this.seaCell.set(c.id, best);
    }
  }

  // Handelspartner: die eigene Seite und Verbündete
  partnerOk(a, b) {
    return a === b || (!!a && !!b && !this.game.hostile(a, b));
  }

  step(dt) {
    const g = this.game;
    for (const c of g.cities) {
      if (!c.owner) continue;
      // Kolonnen über Land
      const lt = (this.landTimer.get(c.id) ?? g.rng() * TRADE.landEvery) - dt;
      if (lt <= 0) {
        this.landTimer.set(c.id, TRADE.landEvery / g.citySize(c) * (0.8 + g.rng() * 0.4));
        this.sendLand(c);
      } else this.landTimer.set(c.id, lt);
      // Schiffe
      if (c.buildings.port && this.seaCell.has(c.id)) {
        const st = (this.seaTimer.get(c.id) ?? g.rng() * TRADE.seaEvery) - dt;
        if (st <= 0) {
          this.seaTimer.set(c.id, TRADE.seaEvery / c.buildings.port * (0.8 + g.rng() * 0.4));
          this.sendShip(c);
        } else this.seaTimer.set(c.id, st);
      }
    }
    this.move(dt);
  }

  // Ziel per Zufall unter den erreichbaren Partnern, größere und fernere Städte bevorzugt
  pick(c, list) {
    if (!list.length) return null;
    const g = this.game;
    const weight = (o) => g.citySize(o) * Math.min(1, Math.hypot(o.x - c.x, o.y - c.y) / (TRADE.landMax * CELL) + 0.3);
    const sum = list.reduce((s, o) => s + weight(o), 0);
    let r = g.rng() * sum;
    for (const o of list) { r -= weight(o); if (r <= 0) return o; }
    return list[list.length - 1];
  }

  sendLand(c) {
    const g = this.game;
    const max = TRADE.landMax * CELL;
    const list = g.cities.filter((o) => o !== c && o.owner && this.partnerOk(c.owner, o.owner) &&
      Math.hypot(o.x - c.x, o.y - c.y) < max);
    const to = this.pick(c, list);
    if (!to) return;
    const path = this.landPath(c, to);
    if (!path) return;
    const len = pathLength(c, path) / CELL;
    const value = (TRADE.landBase + len * TRADE.landPerCell) * (1 + 0.25 * (g.citySize(c) + g.citySize(to) - 2));
    this.convoys.push({ kind: 'land', owner: c.owner, from: c.id, to: to.id, path: path.slice(), x: c.x, y: c.y, value });
  }

  sendShip(c) {
    const g = this.game;
    const comp = this.seaComp[this.seaCell.get(c.id)];
    const list = g.cities.filter((o) => o !== c && o.owner && o.buildings.port && this.partnerOk(c.owner, o.owner) &&
      this.seaCell.has(o.id) && this.seaComp[this.seaCell.get(o.id)] === comp);
    const to = this.pick(c, list);
    if (!to) return;
    const path = this.seaPath(c, to);
    if (!path) return;
    const len = pathLength(c, path) / CELL;
    const value = (TRADE.seaBase + len * TRADE.seaPerCell) * (c.buildings.port + to.buildings.port) / 2;
    this.convoys.push({ kind: 'sea', owner: c.owner, from: c.id, to: to.id, path: path.slice(), x: c.x, y: c.y, value });
  }

  // Landweg über eigenes bzw. verbündetes Gebiet (Straßen bevorzugt); höchstens 15 s alt
  landPath(a, b) {
    const g = this.game, key = a.id + '>' + b.id;
    const cached = this.paths.get(key);
    let path = cached && g.time - cached.time < 15 ? cached.path : null;
    if (!cached || g.time - cached.time >= 15) {
      const tr = g.territory, owner = a.owner;
      path = g.map.findPath(a.x, a.y, b.x, b.y, { cost: (i) => (this.partnerOk(owner, tr[i]) ? 0 : 50) });
      this.paths.set(key, { time: g.time, path });
    }
    if (!path) return null;
    // Weg führt durch fremdes Land: kein Handel
    for (const p of path) if (!this.partnerOk(a.owner, g.territory[g.map.cellIndex(p.x, p.y)])) return null;
    return path;
  }

  // Seeweg: Breitensuche über das Meer (ändert sich nie, daher dauerhaft gemerkt)
  seaPath(a, b) {
    const key = 'S' + a.id + '>' + b.id;
    if (this.paths.has(key)) return this.paths.get(key).path;
    const map = this.game.map, { w, h } = map;
    const s = this.seaCell.get(a.id), t = this.seaCell.get(b.id);
    const prev = new Int32Array(w * h).fill(-2);
    prev[s] = -1;
    const queue = [s];
    for (let q = 0; q < queue.length && prev[t] === -2; q++) {
      const c = queue[q], x = c % w;
      for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w, x > 0 ? c - w - 1 : -1, x < w - 1 ? c - w + 1 : -1, x > 0 ? c + w - 1 : -1, x < w - 1 ? c + w + 1 : -1]) {
        if (n < 0 || n >= w * h || prev[n] !== -2 || this.seaComp[n] < 0) continue;
        prev[n] = c;
        queue.push(n);
      }
    }
    let path = null;
    if (prev[t] !== -2) {
      const cells = [];
      for (let c = t; c !== -1; c = prev[c]) cells.push(c);
      cells.reverse();
      path = cells.filter((_, k) => k % 3 === 0 || k === cells.length - 1)
        .map((c) => ({ x: (c % w + 0.5) * CELL, y: ((c / w | 0) + 0.5) * CELL }));
      path.push({ x: b.x, y: b.y });
    }
    this.paths.set(key, { time: 0, path });
    return path;
  }

  // Kolonnen auf Gebiet, das nicht (mehr) eigenes oder verbündetes ist, gehen verloren
  prune() {
    const g = this.game;
    this.convoys = this.convoys.filter((k) => {
      if (k.kind !== 'land' || this.partnerOk(k.owner, g.territory[g.map.cellIndex(k.x, k.y)])) return true;
      g.events.push({ type: 'convoyLost', owner: k.owner, x: k.x, y: k.y });
      return false;
    });
  }

  move(dt) {
    const g = this.game, map = g.map;
    const done = [];
    for (const k of this.convoys) {
      let step = (k.kind === 'sea' ? TRADE.shipSpeed : TRADE.truckSpeed * (map.speedAt(k.x, k.y) || 0.5)) * dt;
      while (step > 0 && k.path.length) {
        const p = k.path[0];
        const d = Math.hypot(p.x - k.x, p.y - k.y);
        if (d <= step) { k.x = p.x; k.y = p.y; k.path.shift(); step -= d; } else {
          k.x += (p.x - k.x) / d * step; k.y += (p.y - k.y) / d * step; step = 0;
        }
      }
      const dest = g.cities[k.to];
      if (k.kind === 'land') {
        // Überfall oder Weg abgeschnitten: die Kolonne ist verloren
        const tr = g.territory[map.cellIndex(k.x, k.y)];
        const near = g.unitGrid ? g.unitGrid.near(k, 1) : g.units; // Raster aus dem Kampfschritt
        const raided = near.some((u) => u.hp > 0 && g.hostile(u.owner, k.owner) && Math.abs(u.x - k.x) < TRADE.raid && Math.abs(u.y - k.y) < TRADE.raid);
        if (raided || !this.partnerOk(k.owner, tr)) {
          done.push(k);
          g.events.push({ type: 'convoyLost', owner: k.owner, x: k.x, y: k.y });
          continue;
        }
      }
      if (!k.path.length) {
        done.push(k);
        if (!dest.owner || !this.partnerOk(k.owner, dest.owner)) continue; // Ziel inzwischen fremd
        // Handel mit Verbündeten bringt beiden Seiten mehr
        const ally = dest.owner !== k.owner;
        this.pay(k.owner, k.value * (ally ? TRADE.allyBonus : 1));
        if (ally) this.pay(dest.owner, k.value * TRADE.allyBonus);
      }
    }
    if (done.length) this.convoys = this.convoys.filter((k) => !done.includes(k));
  }

  pay(p, v) {
    const e = this.game.eco[p];
    e.money += v;
    e.trade += v;
  }
}

function pathLength(from, path) {
  let L = 0, a = from;
  for (const p of path) { L += Math.hypot(p.x - a.x, p.y - a.y); a = p; }
  return L;
}
