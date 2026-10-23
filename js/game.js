import {
  CELL, T, TERRAIN_INFO, UNIT_TYPES, ATTACK_RANGE, ENEMY_GAP, ENGAGED_SPEED, SURROUND_BONUS,
  CITY_CAPTURE_RADIUS, CAPTURE_TIME, WIN_SHARE, START_UNITS, ECONOMY, UPGRADES, UNITS_PER_CITY, BUILDINGS, DIPLOMACY, GROWTH,
  UNIT_VISION, CITY_VISION, UNIT_BORDER, CITY_BORDER, DIVISION_ROTATE, SUPPLY, ORG, KM, HOURS_PER_SECOND,
} from './config.js?v=101';
import { mulberry32 } from './rng.js?v=101';
import { OrderOfBattle, DIVISION, unitsOf } from './orbat.js?v=101';
import { HQManager } from './hq.js?v=101';
import { SupplyNetwork } from './supply.js?v=101';
import { Trade } from './trade.js?v=101';
import { Production } from './production.js?v=101';

// Größte Reichweite zwischen zwei Kompanien (Angriff plus beide Radien)
const PAIR_REACH = ATTACK_RANGE + 2 * Math.max(...Object.values(UNIT_TYPES).map((t) => t.radius));

export class Game {
  // opts.players: Zahl der Seiten (2 bis 5; Seite 1 ist der Spieler)
  // opts.starts: Startstädte je Seite (Index in map.cities, fehlende werden verteilt)
  // opts.preview: nur die Karte mit neutralen Städten (zur Wahl der Startstadt)
  constructor(map, opts = {}) {
    this.map = map;
    this.rng = mulberry32((map.seed ^ 0x5bd1e995) >>> 0);
    const np = Math.max(2, Math.min(5, opts.players || 2));
    this.players = Array.from({ length: np }, (_, k) => k + 1);
    const slots = () => Array.from({ length: np + 1 }, () => null);
    this.units = [];
    // Alle Städte beginnen neutral, jede Seite startet mit einer Stadt
    this.cities = map.cities.map((c, i) => ({
      id: i, x: c.x, y: c.y, owner: 0, name: c.name || '',
      size: ECONOMY.sizeOf(c.pop || 0), capitalOf: 0, capOwner: 0, capProgress: 0,
      buildings: Object.fromEntries(Object.keys(BUILDINGS).map((k) => [k, 0])), construction: null,
      coastal: false,
    }));
    const n = map.w * map.h;
    // Küstenstädte (Meer in höchstens 2 Feldern Abstand) können einen Hafen bauen
    for (const c of this.cities) {
      const cx = Math.floor(c.x / CELL), cy = Math.floor(c.y / CELL);
      for (let dy = -2; dy <= 2 && !c.coastal; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < map.w && y < map.h && map.cells[y * map.w + x] === T.DEEP && !map.off[y * map.w + x]) { c.coastal = true; break; }
        }
      }
    }
    this.territory = new Uint8Array(n);
    this.vision = slots().map((_, p) => (p ? new Uint8Array(n) : null));
    this.prodMult = slots().map(() => 1);
    this.time = 0;
    this.nextId = 1;
    this.events = [];
    this.winner = 0;
    this.out = new Set();     // ausgeschiedene Seiten
    this.offers = [];         // Bündnisangebote, die auf Antwort warten
    this.nextOffer = 1;
    this.betrayedAt = [];     // Zeitpunkt des letzten Bündnisbruchs je Seite
    this.allySince = new Map(); // Bündnis „a:b“ -> Beginn
    this.allyCooldown = new Map(); // ausgelaufenes Bündnis „a:b“ -> frühestens wieder ab
    this.growTimer = GROWTH.every;
    this.allies = new Set();  // Bündnisse als „a:b“ (kleinere Nummer zuerst), siehe setAllied
    this.enmity = new Uint8Array(64); // [a * 8 + b] = 1, wenn a und b verfeindet sind
    this.updateEnmity();
    this.terrTimer = 0;
    this.visTimer = 0;
    this.divisions = [];
    this.repathBudget = 2;
    this.divTimer = 0;
    this.territoryVersion = 0;
    this.visionVersion = 0;
    this.stats = slots().map((_, p) => (p ? { lost: 0, built: 0, captured: 0 } : null));
    this.landCells = 0;
    for (let i = 0; i < n; i++) if (map.isLand(i)) this.landCells++;
    this.share = slots().map(() => 0);
    // Kasse je Seite: Geld, Manpower und ihre Zuwächse je Sekunde (siehe updateEconomy)
    this.eco = slots().map((_, p) => (p
      ? { money: ECONOMY.startMoney, manpower: ECONOMY.startManpower, income: 0, mpRate: 0, mpCap: 1000, spent: 0, trade: 0, tradeRate: 0, tradeSeen: 0 }
      : null));
    this.ecoTimer = 0;

    // Start: je Seite eine Stadt mit etwas Land und wenigen Kompanien ohne Division
    this.orbat = slots().map((_, p) => (p ? new OrderOfBattle(p) : null));
    this.starts = opts.preview ? null : this.chooseStarts(opts.starts || []);
    for (const p of opts.preview ? [] : this.players) {
      const c = this.cities[this.starts[p]];
      c.owner = p;
      c.capitalOf = p;
      this.paint(p, c.x, c.y, CITY_BORDER);
      this.orbat[p].createStart(this, c, START_UNITS);
    }
    this.updateShares();
    this.updateEconomy(0);
    this.production = new Production(this);
    this.trade = new Trade(this);
    this.supply = new SupplyNetwork(this);
    this.hq = new HQManager(this);
    this.hq.place();
    this.updateVision();
    if (opts.preview) for (const p of this.players) this.vision[p].fill(1); // ganze Karte zeigen
  }

  // Startstädte: vorgegebene übernehmen, die übrigen Seiten so verteilen, dass jede neue
  // Stadt möglichst weit von den schon gewählten entfernt liegt
  chooseStarts(given) {
    const starts = [null];
    const taken = [];
    const free = (i) => i >= 0 && i < this.cities.length && !taken.includes(i);
    for (const p of this.players) {
      let i = given[p];
      if (!free(i)) {
        if (!taken.length) {
          // Erste Seite ohne Vorgabe: die Stadt am weitesten links oben (feste Wahl)
          i = this.cities.reduce((b, c) => (c.x + c.y < this.cities[b].x + this.cities[b].y ? c.id : b), 0);
        } else {
          let bd = -1;
          for (const c of this.cities) {
            if (taken.includes(c.id)) continue;
            const d = Math.min(...taken.map((t) => Math.hypot(this.cities[t].x - c.x, this.cities[t].y - c.y)));
            if (d > bd) { bd = d; i = c.id; }
          }
        }
      }
      starts[p] = i;
      taken.push(i);
    }
    return starts;
  }

  // Feindschaft: verschiedene Seiten ohne Bündnis (Neutrale zählen nicht). Als Tabelle, weil
  // sie im Kampf für jedes Paar von Kompanien gebraucht wird
  hostile(a, b) {
    return this.enmity[a * 8 + b] === 1;
  }

  setAllied(a, b, on) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (on) this.allies.add(key); else this.allies.delete(key);
    this.updateEnmity();
  }

  updateEnmity() {
    this.enmity.fill(0);
    for (const a of this.players) {
      for (const b of this.players) {
        if (a !== b && !this.allies.has(a < b ? `${a}:${b}` : `${b}:${a}`)) this.enmity[a * 8 + b] = 1;
      }
    }
  }

  alive(p) { return !this.out.has(p); }

  // --- Bündnisse -------------------------------------------------------------------
  // Verbündete kämpfen nicht gegeneinander, nehmen sich kein Land und handeln mit Bonus.
  // Angebote warten auf Antwort (offers); wer ein Bündnis bricht, gilt eine Weile als
  // Verräter (betrayedAt), dann lehnt die KI ab. Gewinnen kann nur eine Seite allein.
  allied(a, b) {
    return !!a && !!b && a !== b && !this.hostile(a, b);
  }

  alliesOf(p) {
    return this.players.filter((q) => this.allied(p, q));
  }

  isTraitor(p) {
    return this.time < (this.betrayedAt[p] ?? -1e9) + DIPLOMACY.traitorTime;
  }

  pairKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

  // Nach einem ausgelaufenen Bündnis eine Weile kein neues zwischen denselben Seiten
  canAlly(a, b) {
    return this.time >= (this.allyCooldown.get(this.pairKey(a, b)) ?? -1);
  }

  offerAlliance(from, to) {
    if (!this.alive(from) || !this.alive(to) || this.allied(from, to) || !this.canAlly(from, to)) return null;
    if (this.offers.some((o) => o.from === from && o.to === to)) return null;
    const offer = { id: this.nextOffer++, from, to, time: this.time };
    this.offers.push(offer);
    this.events.push({ type: 'allianceOffer', offer });
    return offer;
  }

  answerOffer(id, accept) {
    const o = this.offers.find((x) => x.id === id);
    if (!o) return;
    this.offers = this.offers.filter((x) => x !== o);
    if (accept && this.alive(o.from) && this.alive(o.to) && !this.allied(o.from, o.to)) {
      this.setAllied(o.from, o.to, true);
      this.allySince.set(this.pairKey(o.from, o.to), this.time);
      this.events.push({ type: 'allianceFormed', a: o.from, b: o.to });
    } else this.events.push({ type: 'allianceDeclined', from: o.from, to: o.to });
  }

  breakAlliance(by, other) {
    if (!this.allied(by, other)) return;
    this.allySince.delete(this.pairKey(by, other));
    this.setAllied(by, other, false);
    this.betrayedAt[by] = this.time;
    this.trade.prune(); // Kolonnen im Land des früheren Verbündeten sind verloren
    this.events.push({ type: 'allianceBroken', by, other });
  }

  // Wirtschaftliche Größe einer Stadt: die eigene Hauptstadt zählt immer als Großstadt
  citySize(c) {
    return c.capitalOf && c.capitalOf === c.owner ? 3 : c.size;
  }

  // Einkommen einmal je Sekunde neu berechnen, Geld und Manpower in jedem Schritt gutschreiben.
  // prodMult (Schwierigkeit der KI) wirkt auf beide Zuwächse
  updateEconomy(dt) {
    this.ecoTimer -= dt;
    if (this.ecoTimer <= 0) {
      this.ecoTimer = 1;
      for (const p of this.players) {
        const e = this.eco[p];
        let size = 0, money = 0, mp = 0;
        for (const c of this.cities) {
          if (c.owner !== p) continue;
          size += this.citySize(c);
          // Gebäude: Fabrik und Hafen bringen Geld, Wohnviertel Manpower
          money += c.buildings.factory * 0.6 + c.buildings.port * 0.4;
          mp += c.buildings.housing * 4;
        }
        const m = this.prodMult[p];
        e.income = (size * ECONOMY.cityMoney + money + this.share[p] * 100 * ECONOMY.landMoney) * m;
        e.mpRate = (size * ECONOMY.cityManpower + mp) * m;
        e.mpCap = Math.max(1000, e.mpRate * ECONOMY.manpowerCap);
        // Handelseinnahmen je Sekunde, geglättet über etwa eine Minute
        e.tradeRate = e.tradeRate * 0.97 + (e.trade - e.tradeSeen) * 0.03;
        e.tradeSeen = e.trade;
      }
    }
    for (const p of this.players) {
      const e = this.eco[p];
      if (!this.alive(p)) continue;
      e.money += e.income * dt;
      e.manpower = Math.min(e.mpCap, e.manpower + e.mpRate * dt);
    }
  }

  // Kosten bezahlen, wenn die Kasse reicht
  pay(p, cost) {
    const e = this.eco[p];
    if (e.money < cost.money || e.manpower < cost.manpower) return false;
    e.money -= cost.money;
    e.manpower -= cost.manpower;
    e.spent += cost.money;
    return true;
  }

  // Eigenes Gebiet wächst langsam in angrenzendes neutrales Land (siehe GROWTH)
  growIntoNeutral() {
    const map = this.map, { w, h } = map, tr = this.territory;
    const grow = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (tr[i] || !map.isLand(i)) continue;
        let owner = 0, n = 0, mixed = false;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          const o = tr[j];
          if (!o) continue;
          if (owner && o !== owner) { mixed = true; break; }
          owner = o; n++;
        }
        if (!mixed && n && this.rng() < (n >= 2 ? GROWTH.chance : GROWTH.edge)) grow.push(i, owner);
      }
    }
    for (let k = 0; k < grow.length; k += 2) tr[grow[k]] = grow[k + 1];
    if (grow.length) { this.territoryVersion++; this.updateShares(); }
  }

  // Anteil am Land je Seite (für Sieg und Anzeige)
  updateShares() {
    const cnt = this.share.map(() => 0);
    const tr = this.territory;
    for (let i = 0; i < tr.length; i++) if (tr[i]) cnt[tr[i]]++;
    for (const p of this.players) this.share[p] = cnt[p] / (this.landCells || 1);
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
      org: ORG.max[type], maxOrg: ORG.max[type], broken: false,
      path: [], target: null, td: 0, incoming: 0, angles: [], px: 0, py: 0,
      stuck: 0, ai: null, supply: 1, supplyEff: 1, supplyHours: 0, depot: -1,
    };
    this.units.push(u);
    return u;
  }

  // rivals: feindliche Einheiten in der Nähe; ein Feld bekommt nur, wer näher dran ist.
  // take = false: nur eigenes Land halten, weder neutrales noch feindliches einnehmen;
  // take = 'neutral': nur neutrales Land dazunehmen, kein feindliches
  paint(owner, x, y, radius, rivals = null, take = true) {
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
        if (!this.map.isLand(i)) continue;
        const cur = this.territory[i];
        // Verbündetes Land wird nie eingenommen, neutrales und feindliches nur mit take
        if (cur !== owner && (!take || (cur && (take === 'neutral' || !this.hostile(owner, cur))))) continue;
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
    for (const p of this.players) this.vision[p].fill(0);
    for (const u of this.units) {
      const t = this.map.cellTerrainAt(u.x, u.y);
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

  step(dt) {
    if (this.winner) return;
    this.time += dt;
    const U = this.units;
    const map = this.map;

    for (const u of U) {
      u.target = null; u.td = Infinity; u.incoming = 0; u.angles.length = 0; u.px = 0; u.py = 0;
    }

    // Paarweise: Abstoßung von Verbündeten, Zielwahl und Kontakt mit Feinden. Ein Raster
    // (Feldgröße = größte Reichweite) beschränkt den Vergleich auf benachbarte Kompanien
    const grid = this.bucketUnits(PAIR_REACH);
    this.unitGrid = grid; // auch für den Handel (Überfälle)
    for (let i = 0; i < U.length; i++) {
      const a = U[i];
      for (const b of grid.near(a, 1)) {
        if (b._k <= i) continue; // jedes Paar nur einmal
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const reach = ATTACK_RANGE + a.r + b.r;
        if (d2 > reach * reach) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, ny = dy / d;
        if (!this.hostile(a.owner, b.owner)) {
          if (a.owner !== b.owner) continue; // Verbündete gehen aneinander vorbei
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
      if (!t || u.broken) continue; // Zerschlagene kämpfen nicht
      const terr = map.cellTerrainAt(u.x, u.y);
      const ut = UNIT_TYPES[u.type];
      const mod = TERRAIN_INFO[terr].attack * ut.terrainAttack[terr];
      const hpFactor = 0.5 + 0.5 * (u.hp / u.maxHp); // Angeschlagene treffen schwächer
      // Ohne Munition und Nachschub sinkt die Kampfkraft (volle Kraft ab halbem Vorrat)
      const supplyFactor = SUPPLY.combatMin + (1 - SUPPLY.combatMin) * Math.min(1, u.supply * 2);
      t.incoming += ut.dps * (u.atk || 1) * mod * hpFactor * supplyFactor * dt;
      t.angles.push(Math.atan2(u.y - t.y, u.x - t.x));
    }
    for (const u of U) {
      if (u.angles.length >= 2 && surrounded(u.angles)) u.incoming *= SURROUND_BONUS;
    }
    // Festung: Verteidiger in und um ihre Stadt nehmen weniger Schaden
    for (const c of this.cities) {
      const lvl = c.owner ? c.buildings.fort : 0;
      if (!lvl) continue;
      const r = CITY_CAPTURE_RADIUS * 1.5;
      for (const u of U) {
        if (u.owner === c.owner && u.incoming && Math.abs(u.x - c.x) < r && Math.abs(u.y - c.y) < r) u.incoming *= 1 - 0.15 * lvl;
      }
    }

    // Versorgung und Gesundheit
    this.supply.step(dt);
    this.hq.update(dt);
    this.divTimer -= dt;
    if (this.divTimer <= 0) { this.divTimer = 0.5; this.updateDivisions(); this.rotateDivisions(); }
    // Heilen nur mit gut gefülltem Vorrat und nicht im Gefecht; ohne Nachschub Abnutzung.
    // Schaden trifft Lebenspunkte (hpShare) und stärker die Organisation.
    const hours = dt * HOURS_PER_SECOND;
    const broke = [];
    for (const u of U) {
      let regen = 0;
      if (u.supply < 0.15) regen = -3 * (0.15 - u.supply) / 0.15;
      else if (!u.target && u.supply > 0.5) {
        const own = this.territory[map.cellIndex(u.x, u.y)] === u.owner;
        regen = (own ? 4 : 1.5) * (u.supply - 0.5) / 0.5;
      }
      u.hp = Math.min(u.maxHp, u.hp + regen * dt - u.incoming * ORG.hpShare);
      this.updateOrg(u, hours);
      if (u.org <= 0 && !u.broken) broke.push(u);
      else if (u.broken && u.org >= ORG.returnAt * u.maxOrg) u.broken = false;
      // Folgt der Feind, zieht sich die Zerschlagene weiter zurück (höchstens alle 2 s)
      else if (u.broken && u.target && !u.path.length && this.time >= (u.nextRetreat || 0)) broke.push(u);
    }
    let retreats = 3; // Wegsuchen je Schritt begrenzen
    for (const u of broke) {
      if (!u.broken) this.breakUnit(u);
      else if (retreats-- > 0) this.retreat(u);
    }

    // Bewegung (höchstens 2 neue Wegsuchen für Festgefahrene je Schritt)
    this.repathBudget = 2;
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

    this.updateEconomy(dt);
    this.production.step(dt);
    this.updateCities(dt);

    this.terrTimer -= dt;
    if (this.terrTimer <= 0) {
      this.terrTimer = 0.25;
      // Städte halten ihren Kern und nehmen ringsum nur neutrales Land; feindliches Land
      // gewinnen allein Truppen zurück (sonst fiele Land hinter feindlichen Truppen an die Stadt)
      for (const c of this.cities) {
        if (!c.owner) continue;
        this.paint(c.owner, c.x, c.y, CITY_CAPTURE_RADIUS);
        this.paint(c.owner, c.x, c.y, CITY_BORDER, null, 'neutral');
      }
      // Grenze liegt zwischen gegnerischen Truppen, nicht hinter ihnen
      const reach = UNIT_BORDER * 2;
      const grid = this.bucketUnits(PAIR_REACH);
      const ring = Math.ceil(reach / PAIR_REACH);
      for (const u of this.units) {
        const rivals = grid.near(u, ring).filter((o) => this.hostile(o.owner, u.owner) &&
          Math.abs(o.x - u.x) < reach && Math.abs(o.y - u.y) < reach);
        this.paint(u.owner, u.x, u.y, UNIT_BORDER, rivals, takesLand(u));
      }
      this.territoryVersion++;
      this.updateShares();
    }
    this.growTimer -= dt;
    if (this.growTimer <= 0) { this.growTimer = GROWTH.every; this.growIntoNeutral(); }
    // Handel nach der Gebietsfärbung: Kolonnen auf frisch verlorenem Gebiet fallen sofort
    this.trade.step(dt);
    this.visTimer -= dt;
    if (this.visTimer <= 0) { this.visTimer = 0.2; this.updateVision(); }

    // Bündnisse laufen aus
    for (const [key, since] of this.allySince) {
      if (this.time - since < DIPLOMACY.duration) continue;
      const [a, b] = key.split(':').map(Number);
      this.allySince.delete(key);
      if (!this.allied(a, b)) continue;
      this.setAllied(a, b, false);
      this.allyCooldown.set(key, this.time + DIPLOMACY.cooldown);
      this.trade.prune();
      this.events.push({ type: 'allianceExpired', a, b });
    }
    // Unbeantwortete Bündnisangebote verfallen
    for (const o of this.offers) if (this.time - o.time > DIPLOMACY.offerTimeout) this.answerOffer(o.id, false);
    this.checkEnd();
  }

  // Ausgeschieden ist, wer weder Städte noch Kompanien hat. Gewonnen hat, wer WIN_SHARE des
  // Landes hält oder als Einziger übrig ist
  checkEnd() {
    for (const p of this.players) {
      if (this.out.has(p) || this.cities.some((c) => c.owner === p) || this.units.some((u) => u.owner === p)) continue;
      this.out.add(p);
      // Bündnisse und Angebote enden
      for (const q of this.players) if (this.allied(p, q)) this.setAllied(p, q, false);
      this.offers = this.offers.filter((o) => o.from !== p && o.to !== p);
      // Ihr übriges Land wird neutral
      const tr = this.territory;
      for (let i = 0; i < tr.length; i++) if (tr[i] === p) tr[i] = 0;
      this.territoryVersion++;
      this.updateShares();
      this.events.push({ type: 'eliminated', player: p });
    }
    const left = this.players.filter((p) => !this.out.has(p));
    let winner = left.length === 1 ? left[0] : 0;
    for (const p of left) if (this.share[p] >= WIN_SHARE) winner = p;
    if (winner) {
      this.winner = winner;
      this.events.push({ type: 'gameover', winner });
    }
  }

  // Kompanien in Rasterfelder der Größe size einsortieren (Index _k = Stelle in units).
  // near(u, r): alle Kompanien in den Feldern bis r Felder um u (u selbst eingeschlossen)
  bucketUnits(size) {
    const gw = Math.ceil(this.map.worldW / size) + 1, gh = Math.ceil(this.map.worldH / size) + 1;
    if (!this.buckets || this.buckets.size !== size) this.buckets = { size, cells: Array.from({ length: gw * gh }, () => []) };
    const cells = this.buckets.cells;
    for (const c of cells) c.length = 0;
    const at = (v, n) => Math.max(0, Math.min(n - 1, Math.floor(v / size)));
    this.units.forEach((u, k) => {
      u._k = k;
      cells[at(u.y, gh) * gw + at(u.x, gw)].push(u);
    });
    const out = [];
    return {
      near(u, r) {
        out.length = 0;
        const cx = at(u.x, gw), cy = at(u.y, gh);
        for (let y = Math.max(0, cy - r); y <= Math.min(gh - 1, cy + r); y++) {
          for (let x = Math.max(0, cx - r); x <= Math.min(gw - 1, cx + r); x++) {
            for (const o of cells[y * gw + x]) out.push(o);
          }
        }
        return out;
      },
    };
  }

  // Organisation: Verlust durch Schaden; außerhalb des Gefechts Erholung je nach
  // Nachschub (beim Marsch langsamer); ohne Nachschub sinkt sie und erreicht ihr Maximum nicht
  updateOrg(u, hours) {
    if (u.incoming > 0) u.org -= u.incoming * ORG.damage * u.maxOrg / u.maxHp;
    const fed = Math.min(1, u.supply * 2);
    const cap = u.maxOrg * (0.5 + 0.5 * fed);
    if (u.supply < 0.15 || u.org > cap) u.org -= ORG.starvePerHour * u.maxOrg * hours;
    else if (!u.target) u.org += ORG.recoverPerHour * u.maxOrg * fed * (u.path.length ? ORG.march : 1) * hours;
    u.org = Math.max(0, Math.min(u.maxOrg, u.org));
  }

  // Zerschlagen: die Kompanie bricht den Kampf ab und zieht sich vom Feind weg ins eigene
  // Gebiet zurück – auch von einer Front. Laufende Befehle (HQ, KI, Platztausch) enden.
  breakUnit(u) {
    u.broken = true;
    u.hqOrder = 0;
    u.swapUntil = 0;
    u.ai = null;
    this.retreat(u);
    this.events.push({ type: 'broken', unit: u });
  }

  // Rückzugsweg: vom Feind weg ins eigene Gebiet, sonst zur nächsten eigenen Stadt. Steht die
  // Kompanie schon in einer Stadt, weicht sie wie in HOI4 zur nächsten anderen aus und gibt
  // die belagerte Stadt auf; gibt es keine andere, ist sie eingeschlossen und bleibt
  retreat(u) {
    u.nextRetreat = this.time + 2;
    let dx = 0, dy = 0;
    for (const e of this.units) {
      if (!this.hostile(e.owner, u.owner) || Math.abs(e.x - u.x) > 150 || Math.abs(e.y - u.y) > 150) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y) || 1;
      dx += (u.x - e.x) / d; dy += (u.y - e.y) / d;
    }
    let city = null, cd = Infinity, fallback = null;
    for (const c of this.cities) {
      if (c.owner !== u.owner) continue;
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < 4 * KM) { fallback = c; continue; } // in dieser Stadt steht sie schon
      if (d < cd) { cd = d; city = c; }
    }
    city = city || fallback;
    if (!dx && !dy && city) { dx = city.x - u.x; dy = city.y - u.y; }
    const l = Math.hypot(dx, dy) || 1;
    let tx = u.x + dx / l * ORG.retreatKm * KM, ty = u.y + dy / l * ORG.retreatKm * KM;
    // Landet der Rückzug nicht im eigenen Gebiet, geht es zur nächsten eigenen Stadt
    const inCity = this.cities.some((c) => c.owner === u.owner && Math.hypot(c.x - u.x, c.y - u.y) < 4 * KM);
    if (city && (inCity || this.territory[this.map.cellIndex(tx, ty)] !== u.owner || !this.map.passableAt(tx, ty))) {
      tx = city.x; ty = city.y;
    }
    const opts = this.routingFor(u, true);
    u.path = this.map.findPath(u.x, u.y, tx, ty, opts) || (city && this.map.findPath(u.x, u.y, city.x, city.y, opts)) || [];
    u.stuck = 0;
  }

  // Wege hinter der eigenen Linie (siehe FrontManager.safeRouting) für haltende
  // Front-Kompanien und auf Wunsch (Rückzug) für alle; sonst der kürzeste Weg
  routingFor(u, always = false) {
    const fm = this.routers && this.routers[u.owner];
    if (!fm || !(always || (u.front && !u.front.attack))) return null;
    return fm.safeRouting();
  }

  moveUnit(u, dt) {
    const map = this.map;
    const ut = UNIT_TYPES[u.type];
    let spd = ut.speed * (map.speedAt(u.x, u.y) || 0.5);
    if (u.target && !u.broken) spd *= ENGAGED_SPEED; // Zerschlagene lösen sich vom Feind
    // Panzern geht bei knappem Vorrat der Treibstoff aus
    if (u.type === 'heavy' && u.supply < SUPPLY.fuelLow) {
      spd *= SUPPLY.fuelMinSpeed + (1 - SUPPLY.fuelMinSpeed) * u.supply / SUPPLY.fuelLow;
    }
    let mx = 0, my = 0;
    let wantMove = 0;
    if (u.path.length) {
      const p = u.path[0];
      const dx = p.x - u.x, dy = p.y - u.y;
      const d = Math.hypot(dx, dy);
      // Front-Einheiten im Gefecht weichen nicht zurück: kein Marsch vom Feind weg
      const retreating = u.front && !u.rotating && !u.broken && !(u.swapUntil > this.time) && u.target &&
        dx * (u.target.x - u.x) + dy * (u.target.y - u.y) < 0;
      // Bei Feindkontakt stehen bleiben statt den Gegner wegzuschieben
      const pressing = u.target && u.td <= u.r + u.target.r + ENEMY_GAP + 3 &&
        dx * (u.target.x - u.x) + dy * (u.target.y - u.y) > 0;
      if (d < (u.path.length > 1 ? 6 : 3)) {
        u.path.shift();
        u.stuck = 0;
        u.repathed = false;
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
    const free = !map.passableAt(u.x, u.y); // auf unbegehbarem Feld gelandet: frei bewegen
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
        // Festgefahren: einmal neuen Weg ab der aktuellen Stelle suchen, sonst Wegpunkt überspringen
        const goal = u.path[u.path.length - 1];
        if (!u.repathed && goal && this.repathBudget > 0) {
          this.repathBudget--;
          u.path = map.findPath(u.x, u.y, goal.x, goal.y, this.routingFor(u)) || [];
          u.repathed = true;
        } else {
          u.path.shift();
          u.repathed = false;
        }
        u.stuck = 0;
      }
    }
  }

  // Gefallene aus der Gliederung austragen und Divisionen für die Rotation sammeln
  updateDivisions() {
    const divs = [];
    for (const p of this.players) {
      this.orbat[p].prune();
      for (const f of this.orbat[p].all(DIVISION)) {
        divs.push({ owner: p, members: unitsOf(f), formation: f });
      }
    }
    this.divisions = divs;
    // Ausrüstung folgt der Division: wer hinzukommt, bekommt sie, wer geht, verliert sie
    for (const u of this.units) this.equip(u, u.regiment ? u.regiment.parent : null);
  }

  // Ausrüstung einer Division auf ihre Kompanien anwenden (Organisation, Kampfkraft)
  applyEquipment(div) {
    for (const u of unitsOf(div)) this.equip(u, div);
  }

  equip(u, div) {
    const tr = div && div.equip ? div.equip.training : 0, ar = div && div.equip ? div.equip.artillery : 0;
    const maxOrg = ORG.max[u.type] * (1 + UPGRADES.training.per * tr);
    if (u.maxOrg !== maxOrg) {
      u.org *= maxOrg / u.maxOrg; // Anteil bleibt gleich
      u.maxOrg = maxOrg;
    }
    u.atk = 1 + UPGRADES.artillery.per * ar;
  }

  // Rotation innerhalb der Division: eine angeschlagene Kompanie im Gefecht tauscht
  // den Platz mit einer frischen Kompanie derselben Division, die nicht kämpft
  rotateDivisions() {
    for (const div of this.divisions) {
      if (div.members.length < 2) continue;
      const busy = (u) => u.swapUntil > this.time || u.rotating || u.broken;
      // Abgekämpft: wenig Lebenspunkte oder kurz vor dem Zerschlagen
      const worn = (u) => Math.min(u.hp / u.maxHp, u.org / u.maxOrg);
      const wounded = div.members
        .filter((u) => u.target && !busy(u) && worn(u) < DIVISION_ROTATE)
        .sort((a, b) => worn(a) - worn(b));
      if (!wounded.length) continue;
      // Ablösung nur durch einsatzbereite, versorgte Kompanien
      const fresh = div.members.filter((u) => !u.target && !busy(u) && u.hp > u.maxHp * 0.6 &&
        u.org > u.maxOrg * 0.7 && u.supply > 0.4);
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
      }
    }
  }

  updateCities(dt) {
    const slots = () => this.share.map(() => 0);

    for (const c of this.cities) {
      const present = slots();
      for (const u of this.units) {
        if (Math.abs(u.x - c.x) > CITY_CAPTURE_RADIUS || Math.abs(u.y - c.y) > CITY_CAPTURE_RADIUS) continue;
        if (!u.broken && Math.hypot(u.x - c.x, u.y - c.y) <= CITY_CAPTURE_RADIUS) present[u.owner]++;
      }
      // Erobern kann nur eine einzige Seite, die mit dem Besitzer verfeindet ist (oder jede bei
      // neutralen Städten); sind mehrere da, ist die Stadt umkämpft
      const invaders = this.players.filter((p) => p !== c.owner && present[p] > 0 && (!c.owner || this.hostile(p, c.owner)));
      const defended = c.owner && present[c.owner] > 0;
      if (invaders.length === 1 && !defended) {
        const a = invaders[0];
        if (c.capOwner !== a) { c.capOwner = a; c.capProgress = 0; }
        c.capProgress += dt / (CAPTURE_TIME * (1 + 0.5 * c.buildings.fort)); // Festung hält länger
        if (c.capProgress >= 1) {
          const old = c.owner;
          c.owner = a; c.capOwner = 0; c.capProgress = 0;
          this.stats[a].captured++;
          // Land ringsum, aber nicht, was näher an feindlichen Truppen liegt
          const rivals = this.units.filter((u) => this.hostile(u.owner, a) &&
            Math.abs(u.x - c.x) < CITY_BORDER * 2 && Math.abs(u.y - c.y) < CITY_BORDER * 2);
          this.paint(a, c.x, c.y, CITY_BORDER, rivals);
          this.production.cityLost(c); // Aufträge der Stadt verfallen sofort
          this.events.push({ type: 'capture', city: c, owner: a, old });
        }
      } else if (c.capProgress > 0) {
        c.capProgress = Math.max(0, c.capProgress - dt / CAPTURE_TIME);
        if (c.capProgress === 0) c.capOwner = 0;
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

// Kampfwert für Kräftevergleiche (KI, HQs): Typ, Lebenspunkte, Organisation und Nachschub;
// zerschlagene Kompanien kämpfen nicht und zählen nicht
export function unitStrength(u) {
  if (u.broken) return 0;
  const supply = SUPPLY.combatMin + (1 - SUPPLY.combatMin) * Math.min(1, u.supply * 2);
  return UNIT_TYPES[u.type].strength * (0.4 + 0.6 * u.hp / u.maxHp) * (0.5 + 0.5 * u.org / u.maxOrg) * supply;
}

// Nimmt die Kompanie Feindgebiet ein? Nicht, wer eine Grenzfront nur hält (sonst schöbe
// jede haltende Front die Grenze und damit ihre eigenen Plätze immer weiter vor) und nicht,
// wer zerschlagen ist. Angriffe, eigene Befehle und frei gezeichnete Linien nehmen Land ein.
function takesLand(u) {
  if (u.broken) return false;
  const f = u.front;
  return !f || f.kind === 'line' || !!f.attack;
}
