import {
  CELL, T, TERRAIN_INFO, UNIT_TYPES, ATTACK_RANGE, ENEMY_GAP, ENGAGED_SPEED, SURROUND_BONUS,
  CITY_CAPTURE_RADIUS, CAPTURE_TIME, UNITS_PER_CITY, SUPPLY_FULL, SUPPLY_NONE,
  UNIT_VISION, CITY_VISION, UNIT_BORDER, CITY_BORDER, DIVISION_ROTATE,
} from './config.js?v=33';
import { mulberry32 } from './rng.js?v=33';
import { OrderOfBattle, DIVISION, unitsOf } from './orbat.js?v=33';
import { HQManager } from './hq.js?v=33';

export class Game {
  constructor(map, opts = {}) {
    this.map = map;
    this.opts = opts;
    this.rng = mulberry32((map.seed ^ 0x5bd1e995) >>> 0);
    this.units = [];
    this.cities = map.cities.map((c, i) => ({
      id: i, x: c.x, y: c.y, owner: c.owner, prodType: 'light',
      timer: this.rng() * 4, capOwner: 0, capProgress: 0,
    }));
    const n = map.w * map.h;
    this.territory = new Uint8Array(n);
    this.vision = [null, new Uint8Array(n), new Uint8Array(n)];
    this.prodMult = [1, 1, 1];
    this.time = 0;
    this.nextId = 1;
    this.events = [];
    this.winner = 0;
    this.terrTimer = 0;
    this.visTimer = 0;
    this.starveTimer = 0;
    this.divisions = [];
    this.divTimer = 0;
    this.territoryVersion = 0;
    this.visionVersion = 0;
    this.stats = [null, { lost: 0, built: 0, captured: 0 }, { lost: 0, built: 0, captured: 0 }];

    // Jede Seite startet mit einer Armee: je eigene Stadt eine Division
    this.orbat = [null, new OrderOfBattle(1), new OrderOfBattle(2)];
    for (let p = 1; p <= 2; p++) {
      const own = this.cities.filter((c) => c.owner === p).sort((a, b) => a.y - b.y);
      this.orbat[p].createStart(this, own);
    }
    this.partitionTerritory();
    this.hq = new HQManager(this);
    this.hq.place();
    this.updateVision();
  }

  // Das ganze Land lückenlos aufteilen: jedes Feld gehört der Seite, deren Stadt es
  // auf dem Landweg am schnellsten erreicht. Gebirge und Wasser bremsen, so folgen
  // die Grenzen natürlichen Hindernissen.
  partitionTerritory() {
    const map = this.map;
    const { w, h } = map;
    const n = w * h;
    const dist = new Float64Array(n).fill(Infinity);
    const owner = new Uint8Array(n);
    const cost = (t) => (t === T.MOUNTAIN ? 4 : t === T.WATER ? 2 : t === T.HILL || t === T.FOREST ? 1.3 : 1);
    const heap = [];
    const push = (i, d) => {
      heap.push([d, i]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    for (const c of this.cities) {
      if (!c.owner) continue;
      const i = map.cellIndex(c.x, c.y);
      dist[i] = 0;
      owner[i] = c.owner;
      push(i, 0);
    }
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    while (heap.length) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy, len] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        const t = map.cells[ni];
        if (t === T.DEEP) continue;
        const nd = d + len * cost(t);
        if (nd < dist[ni]) {
          dist[ni] = nd;
          owner[ni] = owner[i];
          push(ni, nd);
        }
      }
    }
    // Abgetrennte Inseln: an die Seite mit der nächstgelegenen Stadt
    const owned = this.cities.filter((c) => c.owner);
    for (let i = 0; i < n; i++) {
      if (map.cells[i] === T.DEEP) continue;
      if (!owner[i] && owned.length) {
        const cx = (i % w + 0.5) * CELL, cy = (((i / w) | 0) + 0.5) * CELL;
        let best = owned[0], bd = Infinity;
        for (const c of owned) {
          const dd = Math.hypot(c.x - cx, c.y - cy);
          if (dd < bd) { bd = dd; best = c; }
        }
        owner[i] = best.owner;
      }
      this.territory[i] = owner[i];
    }
  }

  // slot: feste Aufstellung im Ring um die Stadt (für die Startarmee)
  spawnUnit(owner, type, city, slot = -1) {
    const ut = UNIT_TYPES[type];
    let x = city.x, y = city.y;
    for (let tries = 0; tries < 20; tries++) {
      const ring = slot >= 0 ? Math.floor(slot / 6) : 0;
      const a = slot >= 0 && tries === 0 ? (slot % 6) / 6 * Math.PI * 2 + ring * 0.5 : this.rng() * Math.PI * 2;
      const r = slot >= 0 ? 22 + ring * 15 + tries * 2 : 14 + this.rng() * 12;
      const px = city.x + Math.cos(a) * r, py = city.y + Math.sin(a) * r;
      if (this.map.passableAt(px, py)) { x = px; y = py; break; }
    }
    const u = {
      id: this.nextId++, owner, type, x, y, hp: ut.hp, maxHp: ut.hp, r: ut.radius,
      path: [], target: null, td: 0, incoming: 0, angles: [], px: 0, py: 0,
      stuck: 0, starving: false, regen: 0, ai: null,
    };
    this.units.push(u);
    return u;
  }

  // rivals: feindliche Einheiten in der Nähe; ein Feld bekommt nur, wer näher dran ist
  paint(owner, x, y, radius, rivals = null) {
    const { w, h } = this.map;
    const cr = radius / CELL;
    const cx = x / CELL, cy = y / CELL;
    const x0 = Math.max(0, Math.floor(cx - cr)), x1 = Math.min(w - 1, Math.ceil(cx + cr));
    const y0 = Math.max(0, Math.floor(cy - cr)), y1 = Math.min(h - 1, Math.ceil(cy + cr));
    const r2 = cr * cr;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
        if (dx * dx + dy * dy > r2) continue;
        const i = yy * w + xx;
        if (this.map.cells[i] === T.DEEP) continue;
        if (rivals && rivals.length) {
          const px = (xx + 0.5) * CELL, py = (yy + 0.5) * CELL;
          const own = (px - x) ** 2 + (py - y) ** 2;
          let closer = false;
          for (const r of rivals) if ((px - r.x) ** 2 + (py - r.y) ** 2 < own) { closer = true; break; }
          if (closer) continue;
        }
        this.territory[i] = owner;
      }
    }
  }

  markVision(arr, x, y, radius) {
    const { w, h } = this.map;
    const cr = radius / CELL;
    const cx = x / CELL, cy = y / CELL;
    const x0 = Math.max(0, Math.floor(cx - cr)), x1 = Math.min(w - 1, Math.ceil(cx + cr));
    const y0 = Math.max(0, Math.floor(cy - cr)), y1 = Math.min(h - 1, Math.ceil(cy + cr));
    const r2 = cr * cr;
    for (let yy = y0; yy <= y1; yy++) {
      const dy = yy + 0.5 - cy;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) arr[yy * w + xx] = 1;
      }
    }
  }

  updateVision() {
    for (let p = 1; p <= 2; p++) this.vision[p].fill(0);
    for (const u of this.units) {
      const t = this.map.terrainAt(u.x, u.y);
      this.markVision(this.vision[u.owner], u.x, u.y, UNIT_VISION * TERRAIN_INFO[t].vision);
    }
    for (const c of this.cities) if (c.owner) this.markVision(this.vision[c.owner], c.x, c.y, CITY_VISION);
    this.visionVersion++;
  }

  isVisible(player, x, y) {
    return this.vision[player][this.map.cellIndex(x, y)] === 1;
  }

  citiesOf(p) { return this.cities.filter((c) => c.owner === p); }
  unitsOf(p) { return this.units.filter((u) => u.owner === p); }
  capacity(p) { return this.citiesOf(p).length * UNITS_PER_CITY; }

  nearestOwnCityDist(u) {
    let best = Infinity;
    for (const c of this.cities) {
      if (c.owner !== u.owner) continue;
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < best) best = d;
    }
    return best;
  }

  step(dt) {
    if (this.winner) return;
    this.time += dt;
    const U = this.units;
    const map = this.map;

    for (const u of U) {
      u.target = null; u.td = Infinity; u.incoming = 0; u.angles.length = 0; u.px = 0; u.py = 0;
    }

    // Paarweise: Abstoßung von Verbündeten, Zielwahl und Kontakt mit Feinden
    for (let i = 0; i < U.length; i++) {
      const a = U[i];
      for (let j = i + 1; j < U.length; j++) {
        const b = U[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const reach = ATTACK_RANGE + a.r + b.r;
        if (d2 > reach * reach) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, ny = dy / d;
        if (a.owner === b.owner) {
          const min = a.r + b.r + 2;
          // Kompanien im Platztausch schleusen sich durch die eigenen Reihen
          const passing = (a.swapUntil > this.time && a.path.length) || (b.swapUntil > this.time && b.path.length);
          if (d < min && !passing) {
            const push = (min - d) * 0.5;
            a.px -= nx * push; a.py -= ny * push;
            b.px += nx * push; b.py += ny * push;
          }
        } else {
          if (d < a.td) { a.target = b; a.td = d; }
          if (d < b.td) { b.target = a; b.td = d; }
          const min = a.r + b.r + ENEMY_GAP;
          if (d < min) {
            const push = (min - d) * 0.5;
            a.px -= nx * push; a.py -= ny * push;
            b.px += nx * push; b.py += ny * push;
          }
        }
      }
    }

    // Schaden
    for (const u of U) {
      const t = u.target;
      if (!t) continue;
      const terr = map.terrainAt(u.x, u.y);
      const ut = UNIT_TYPES[u.type];
      const mod = TERRAIN_INFO[terr].attack * ut.terrainAttack[terr];
      const hpFactor = 0.5 + 0.5 * (u.hp / u.maxHp); // Angeschlagene treffen schwächer
      t.incoming += ut.dps * mod * hpFactor * dt;
      t.angles.push(Math.atan2(u.y - t.y, u.x - t.x));
    }
    for (const u of U) {
      if (u.angles.length >= 2 && surrounded(u.angles)) u.incoming *= SURROUND_BONUS;
      u.surrounded = u.angles.length >= 2 && surrounded(u.angles);
    }

    // Versorgung und Gesundheit
    this.starveTimer -= dt;
    if (this.starveTimer <= 0) { this.updateStarvation(); this.starveTimer = 0.5; }
    this.hq.update(dt);
    this.divTimer -= dt;
    if (this.divTimer <= 0) { this.divTimer = 0.5; this.updateDivisions(); this.rotateDivisions(); }
    for (const u of U) {
      let regen;
      if (u.starving) regen = -3;
      else if (u.target) regen = 0;
      else {
        const d = this.nearestOwnCityDist(u);
        const supply = d <= SUPPLY_FULL ? 1 : d >= SUPPLY_NONE ? 0 : 1 - (d - SUPPLY_FULL) / (SUPPLY_NONE - SUPPLY_FULL);
        const owner = this.territory[map.cellIndex(u.x, u.y)];
        if (owner === u.owner) regen = 0.5 + 3.5 * supply;
        else if (owner === 0) regen = 2 * supply - 0.5;
        else regen = supply > 0.6 ? 0 : -1;
      }
      u.regen = regen;
      u.hp = Math.min(u.maxHp, u.hp + regen * dt - u.incoming);
    }

    // Bewegung
    for (const u of U) {
      this.moveUnit(u, dt);
      if (u.swapUntil > this.time && !u.path.length) u.swapUntil = 0; // Platztausch abgeschlossen
    }

    // Tote entfernen
    const alive = [];
    for (const u of U) {
      if (u.hp > 0) alive.push(u);
      else {
        this.stats[u.owner].lost++;
        this.events.push({ type: 'death', unit: u });
      }
    }
    this.units = alive;

    this.updateCities(dt);

    this.terrTimer -= dt;
    if (this.terrTimer <= 0) {
      this.terrTimer = 0.25;
      for (const c of this.cities) if (c.owner) this.paint(c.owner, c.x, c.y, CITY_BORDER);
      // Grenze liegt zwischen gegnerischen Truppen, nicht hinter ihnen
      const reach = UNIT_BORDER * 2;
      for (const u of this.units) {
        const rivals = this.units.filter((o) => o.owner !== u.owner &&
          Math.abs(o.x - u.x) < reach && Math.abs(o.y - u.y) < reach);
        this.paint(u.owner, u.x, u.y, UNIT_BORDER, rivals);
      }
      this.territoryVersion++;
    }
    this.visTimer -= dt;
    if (this.visTimer <= 0) { this.visTimer = 0.2; this.updateVision(); }

    for (let p = 1; p <= 2; p++) {
      if (this.citiesOf(p).length === 0 && this.unitsOf(p).length === 0) {
        this.winner = 3 - p;
        this.events.push({ type: 'gameover', winner: this.winner });
      }
    }
  }

  moveUnit(u, dt) {
    const map = this.map;
    const ut = UNIT_TYPES[u.type];
    const terr = map.terrainAt(u.x, u.y);
    let spd = ut.speed * (map.speedAt(u.x, u.y) || 0.5);
    if (u.target) spd *= ENGAGED_SPEED;
    let mx = 0, my = 0;
    let wantMove = 0;
    if (u.path.length) {
      const p = u.path[0];
      const dx = p.x - u.x, dy = p.y - u.y;
      const d = Math.hypot(dx, dy);
      // Front-Einheiten im Gefecht weichen nicht zurück: kein Marsch vom Feind weg
      const retreating = u.front && !u.rotating && !(u.swapUntil > this.time) && u.target &&
        dx * (u.target.x - u.x) + dy * (u.target.y - u.y) < 0;
      // Bei Feindkontakt stehen bleiben statt den Gegner wegzuschieben
      const pressing = u.target && u.td <= u.r + u.target.r + ENEMY_GAP + 3 &&
        dx * (u.target.x - u.x) + dy * (u.target.y - u.y) > 0;
      if (d < (u.path.length > 1 ? 6 : 3)) {
        u.path.shift();
        u.stuck = 0;
      } else if (!retreating && !pressing) {
        const s = Math.min(spd * dt, d);
        mx = dx / d * s; my = dy / d * s;
        wantMove = s;
      }
    }
    const cap = 40 * dt;
    const plen = Math.hypot(u.px, u.py);
    if (plen > cap) { u.px *= cap / plen; u.py *= cap / plen; }
    mx += u.px; my += u.py;
    if (!mx && !my) return;
    const ox = u.x, oy = u.y;
    let nx = Math.min(map.worldW - 1, Math.max(1, u.x + mx));
    let ny = Math.min(map.worldH - 1, Math.max(1, u.y + my));
    const free = !TERRAIN_INFO[terr].passable; // auf unbegehbarem Feld gelandet: frei bewegen
    if (free || map.passableAt(nx, ny)) { u.x = nx; u.y = ny; }
    else if (map.passableAt(nx, u.y)) u.x = nx;
    else if (map.passableAt(u.x, ny)) u.y = ny;
    if (wantMove > 0) {
      const moved = Math.hypot(u.x - ox, u.y - oy);
      if (moved < wantMove * 0.25 && !u.target) u.stuck += dt;
      else u.stuck = Math.max(0, u.stuck - dt);
      const last = u.path[u.path.length - 1];
      if (u.path.length === 1 && last && Math.hypot(last.x - u.x, last.y - u.y) < 18 && u.stuck > 0.4) {
        u.path.length = 0; u.stuck = 0;
      } else if (u.stuck > 1.2) {
        u.path.shift(); u.stuck = 0;
      }
    }
  }

  // Divisionen aus der festen Gliederung
  updateDivisions() {
    const divs = [];
    for (let p = 1; p <= 2; p++) {
      for (const f of this.orbat[p].all(DIVISION)) {
        const members = unitsOf(f).filter((u) => this.units.includes(u));
        const div = { owner: p, members, formation: f };
        for (const u of members) u.division = div;
        divs.push(div);
      }
    }
    this.divisions = divs;
  }

  // Rotation innerhalb der Division: eine angeschlagene Kompanie im Gefecht tauscht
  // den Platz mit einer frischen Kompanie derselben Division, die nicht kämpft
  rotateDivisions() {
    for (const div of this.divisions) {
      if (div.members.length < 2) continue;
      const busy = (u) => u.swapUntil > this.time || u.rotating;
      const wounded = div.members
        .filter((u) => u.target && !busy(u) && u.hp < u.maxHp * DIVISION_ROTATE)
        .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
      if (!wounded.length) continue;
      const fresh = div.members.filter((u) => !u.target && !busy(u) && u.hp > u.maxHp * 0.6);
      for (const w of wounded) {
        let best = null, bd = Infinity;
        for (const f of fresh) {
          if (f.front !== w.front) continue;
          if (Math.hypot(f.x - w.x, f.y - w.y) > 80) continue; // nur Reserven in der Nähe
          const d = Math.hypot(f.x - w.x, f.y - w.y);
          if (d < bd) { bd = d; best = f; }
        }
        if (!best) continue;
        fresh.splice(fresh.indexOf(best), 1);
        const a = { x: w.x, y: w.y }, b = { x: best.x, y: best.y };
        // Versetzt aneinander vorbei: jede Kompanie nimmt ihre Seite der Strecke
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const side = 9;
        const ox = -dy / len * side, oy = dx / len * side;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        w.path = [{ x: mid.x + ox, y: mid.y + oy }, b];
        best.path = [{ x: mid.x - ox, y: mid.y - oy }, a];
        w.stuck = best.stuck = 0;
        w.swapUntil = best.swapUntil = this.time + 10;
        const goal = w.frontGoal;
        w.frontGoal = best.frontGoal;
        best.frontGoal = goal;
        this.events.push({ type: 'divisionSwap', out: w, in: best });
      }
    }
  }

  updateStarvation() {
    for (const u of this.units) u.starving = false;
    for (let p = 1; p <= 2; p++) {
      const own = this.unitsOf(p);
      const excess = own.length - this.capacity(p);
      if (excess <= 0) continue;
      own.sort((a, b) => this.nearestOwnCityDist(b) - this.nearestOwnCityDist(a));
      for (let k = 0; k < excess; k++) own[k].starving = true;
    }
  }

  updateCities(dt) {
    const unitCount = [0, 0, 0];
    for (const u of this.units) unitCount[u.owner]++;
    const cityCount = [0, 0, 0];
    for (const c of this.cities) cityCount[c.owner]++;

    for (const c of this.cities) {
      const present = [0, 0, 0];
      for (const u of this.units) {
        if (Math.abs(u.x - c.x) > CITY_CAPTURE_RADIUS || Math.abs(u.y - c.y) > CITY_CAPTURE_RADIUS) continue;
        if (Math.hypot(u.x - c.x, u.y - c.y) <= CITY_CAPTURE_RADIUS) present[u.owner]++;
      }
      const invaders = [1, 2].filter((p) => p !== c.owner && present[p] > 0);
      const defended = c.owner && present[c.owner] > 0;
      if (invaders.length === 1 && !defended) {
        const a = invaders[0];
        if (c.capOwner !== a) { c.capOwner = a; c.capProgress = 0; }
        c.capProgress += dt / CAPTURE_TIME;
        if (c.capProgress >= 1) {
          const old = c.owner;
          cityCount[old]--; cityCount[a]++;
          c.owner = a; c.capOwner = 0; c.capProgress = 0; c.timer = 0;
          this.stats[a].captured++;
          this.paint(a, c.x, c.y, CITY_BORDER);
          this.events.push({ type: 'capture', city: c, owner: a, old });
        }
      } else if (c.capProgress > 0) {
        c.capProgress = Math.max(0, c.capProgress - dt / CAPTURE_TIME);
        if (c.capProgress === 0) c.capOwner = 0;
      }

      if (c.owner) {
        const cap = cityCount[c.owner] * UNITS_PER_CITY;
        if (unitCount[c.owner] < cap) {
          // Je voller die Armee, desto langsamer die Produktion
          const fill = unitCount[c.owner] / cap;
          const rate = (fill < 0.5 ? 1 : 1 - (fill - 0.5) * 0.8) * this.prodMult[c.owner];
          c.timer += dt * rate;
          if (c.timer >= UNIT_TYPES[c.prodType].buildTime) {
            c.timer = 0;
            const u = this.spawnUnit(c.owner, c.prodType, c);
            this.orbat[c.owner].assign(u, this);
            unitCount[c.owner]++;
            this.stats[c.owner].built++;
            this.events.push({ type: 'spawn', unit: u, city: c });
          }
        }
      }
    }
  }
}

// Eingekesselt, wenn keine Lücke zwischen den Angriffswinkeln größer als 180° ist
function surrounded(angles) {
  const a = angles.slice().sort((x, y) => x - y);
  let maxGap = a[0] + Math.PI * 2 - a[a.length - 1];
  for (let i = 1; i < a.length; i++) maxGap = Math.max(maxGap, a[i] - a[i - 1]);
  return maxGap < Math.PI;
}

export function unitStrength(u) {
  return UNIT_TYPES[u.type].strength * (0.4 + 0.6 * u.hp / u.maxHp);
}
