import {
  CELL, T, TERRAIN_INFO, UNIT_TYPES, ATTACK_RANGE, ENEMY_GAP, ENGAGED_SPEED, SURROUND_BONUS,
  CITY_CAPTURE_RADIUS, CAPTURE_TIME, UNITS_PER_CITY, SUPPLY_FULL, SUPPLY_NONE,
  UNIT_VISION, CITY_VISION, UNIT_BORDER, CITY_BORDER,
} from './config.js';
import { mulberry32 } from './rng.js';

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
    this.territoryVersion = 0;
    this.visionVersion = 0;
    this.stats = [null, { lost: 0, built: 0, captured: 0 }, { lost: 0, built: 0, captured: 0 }];

    for (const c of this.cities) {
      if (c.owner) {
        this.paint(c.owner, c.x, c.y, CITY_BORDER * 1.8);
        for (let k = 0; k < 2; k++) this.spawnUnit(c.owner, 'light', c);
      }
    }
    for (const c of this.cities) if (c.owner) this.paint(c.owner, c.x, c.y, CITY_BORDER);
    this.updateVision();
  }

  spawnUnit(owner, type, city) {
    const ut = UNIT_TYPES[type];
    let x = city.x, y = city.y;
    for (let tries = 0; tries < 20; tries++) {
      const a = this.rng() * Math.PI * 2, r = 14 + this.rng() * 12;
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

  paint(owner, x, y, radius) {
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
          if (d < min) {
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
    for (const u of U) this.moveUnit(u, dt);

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
      for (const u of this.units) this.paint(u.owner, u.x, u.y, UNIT_BORDER);
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
    let spd = ut.speed * (TERRAIN_INFO[terr].speed || 0.5);
    if (u.target) spd *= ENGAGED_SPEED;
    let mx = 0, my = 0;
    let wantMove = 0;
    if (u.path.length) {
      const p = u.path[0];
      const dx = p.x - u.x, dy = p.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d < (u.path.length > 1 ? 6 : 3)) {
        u.path.shift();
        u.stuck = 0;
      } else {
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
