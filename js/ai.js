import { DIFFICULTY, SUPPLY, KM } from './config.js?v=87';
import { unitStrength } from './game.js?v=87';
import { mulberry32 } from './rng.js?v=87';
import { FrontManager, projectOnChains, sliceChains, chainLength } from './fronts.js?v=87';
import { DIVISION, strength, unitsOf, centerOf } from './orbat.js?v=87';

const THREAT_RADIUS = 170;
const TARGET_RADIUS = 240;
const ORGANIZE_EVERY = 5;   // Sekunden zwischen zwei Gliederungsdurchgängen
const DIV_MIN = 6;          // neue Front-Divisionen: mindestens so viele Kompanien
const DIV_SIZE = 10;        // und höchstens so viele
const DIV_LEAVE = 400;      // so weit entfernte Kompanien verlassen ihre Division
const GAP_RESPLIT = 80;     // so viel ungedeckte Grenze löst eine neue Aufteilung aus
const PUSH_DEPTH = 80;      // begrenzter Vorstoß: so weit (8 km) ins Feindgebiet
const PUSH_RATIO = 1.3;     // und nur mit so viel Überlegenheit vor Ort

export class AI {
  constructor(game, player, difficulty = 'medium') {
    this.game = game;
    this.me = player;
    this.cfg = DIFFICULTY[difficulty];
    this.timer = 1;
    this.rng = mulberry32((game.map.seed * 31 + player) >>> 0);
    game.prodMult[player] = this.cfg.prodMult;
    this.currentTarget = null;
    this.penalty = new Map();
    this.pathCache = new Map();
    this.fronts = new FrontManager(game, player);
    this.nextFrontAttack = 30;
    this.nextOrganize = 0;
    this.needSplit = false;
  }

  update(dt) {
    this.fronts.update(dt);
    this.fronts.events.length = 0;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.cfg.interval * (0.8 + this.rng() * 0.4);
    this.pathCache.clear();
    this.budget = 3; // A*-Suchen je Denkschritt
    this.think();
  }

  // Ausbildung über das Baumenü: freie Plätze der eigenen Städte füllen (große zuerst),
  // solange die Kasse reicht und die Armee unter ihrem Richtwert liegt
  build(myCities, myUnits) {
    const g = this.game, prod = g.production;
    let total = myUnits.length + prod.ordersOf(this.me).length;
    const cities = myCities.slice().sort((a, b) => g.citySize(b) - g.citySize(a));
    for (const c of cities) {
      while (total < g.capacity(this.me) && prod.orders.filter((o) => o.city === c.id).length < prod.citySlots(c)) {
        const type = this.rng() < this.cfg.heavyRatio && prod.canTrain(c, 'heavy') ? 'heavy' : 'light';
        if (!prod.order(this.me, c.id, type)) return;
        total++;
      }
    }
    this.construct(cities);
  }

  // Städte ausbauen, wenn Geld übrig ist: zuerst eine Fabrik (Panzer), dann je nach Engpass
  // Wohnviertel (Manpower), Kaserne (Ausbildungsplätze) oder weitere Fabriken (Geld)
  construct(cities) {
    const g = this.game, prod = g.production, e = g.eco[this.me];
    if (e.money < 250 || cities.some((c) => c.construction)) return;
    const tryBuild = (c, key) => {
      const next = prod.nextBuilding(c, key);
      return next && e.money >= next.cost.money + 120 && prod.construct(this.me, c.id, key);
    };
    const big = cities[0];
    if (!big) return;
    if (!cities.some((c) => c.buildings.factory) && tryBuild(big, 'factory')) return;
    const busy = prod.ordersOf(this.me).length >= cities.reduce((s, c) => s + prod.citySlots(c), 0);
    const order = e.manpower < 400 ? ['housing', 'barracks', 'factory'] : busy ? ['barracks', 'factory', 'housing'] : ['factory', 'housing', 'barracks'];
    for (const key of order) {
      const c = cities.find((x) => prod.nextBuilding(x, key));
      if (c && tryBuild(c, key)) return;
    }
  }

  visibleEnemies() {
    const g = this.game;
    return g.units.filter((u) => g.hostile(u.owner, this.me) && (this.cfg.seeAll || g.isVisible(this.me, u.x, u.y)));
  }

  strengthNear(list, x, y, r) {
    let s = 0;
    for (const u of list) if (Math.hypot(u.x - x, u.y - y) <= r) s += unitStrength(u);
    return s;
  }

  order(u, x, y, role, tag) {
    if (u.swapUntil > this.game.time || u.broken) return; // Platztausch läuft bzw. zerschlagen
    if (u.hqOrder > this.game.time) return;   // Befehl des Divisions-HQ hat Vorrang
    if (u.ai && u.ai.role === role && u.ai.tag === tag && u.path.length) return;
    const path = this.pathFor(u, x, y);
    if (!path) return; // Rechenbudget erschöpft, nächster Denkschritt
    u.path = path;
    u.ai = { role, tag };
  }

  think() {
    const g = this.game;
    const me = this.me;
    const myUnits = g.units.filter((u) => u.owner === me);
    const myCities = g.cities.filter((c) => c.owner === me);
    const enemies = this.visibleEnemies();

    this.build(myCities, myUnits);
    if (!myUnits.length) return;

    this.fronts.syncAll();
    if (g.time >= this.nextOrganize) {
      this.nextOrganize = g.time + ORGANIZE_EVERY;
      this.organize(myUnits);
    }
    this.manageAttacks(enemies);
    const free = new Set(myUnits.filter((u) => !u.front));

    // Angeschlagene, desorganisierte oder abgeschnittene Einheiten zurückziehen
    for (const u of myUnits) {
      if (u.front) continue; // Front-Einheiten heilen über die Rotation ihrer Front
      const frac = Math.min(u.hp / u.maxHp, u.org / u.maxOrg * 1.5);
      const cutOff = !u.supplyEff && u.supply < 0.5 && !u.target;
      if (u.ai && u.ai.role === 'retreat') {
        if ((frac > 0.85 && u.supplyEff > 0) || !myCities.length) u.ai = null;
        else { free.delete(u); continue; }
      }
      if ((frac < this.cfg.retreatAt || cutOff) && myCities.length) {
        const c = nearest(myCities, u);
        if (Math.hypot(c.x - u.x, c.y - u.y) > 50) {
          this.order(u, c.x + (this.rng() - 0.5) * 30, c.y + (this.rng() - 0.5) * 30, 'retreat', c.id);
          free.delete(u);
        }
      }
    }

    // Kämpfende Einheiten nicht wegschicken
    for (const u of free) if (u.target) free.delete(u);

    // Bedrohte Städte verteidigen; jeder Feind zählt nur für die nächste eigene Stadt
    const threatOf = new Map();
    for (const e of enemies) {
      const c = nearest(myCities, e);
      if (!c || Math.hypot(c.x - e.x, c.y - e.y) > THREAT_RADIUS) continue;
      threatOf.set(c, (threatOf.get(c) || 0) + unitStrength(e));
    }
    const threats = [...threatOf].sort((a, b) => b[1] - a[1]);
    // Eigene Fronttruppen zwischen Stadt und Feind decken die Stadt mit
    const frontNear = (c) => myUnits.reduce((a, u) => (u.front && !u.broken &&
      Math.hypot(u.x - c.x, u.y - c.y) < THREAT_RADIUS ? a + unitStrength(u) : a), 0);
    for (const [c, s] of threats) {
      let need = s * 1.2 - frontNear(c);
      for (const u of free) {
        if (u.ai && u.ai.role === 'defend' && u.ai.tag === c.id) need -= unitStrength(u);
      }
      const near = [...free]
        .filter((u) => !(u.ai && u.ai.role === 'defend'))
        .map((u) => ({ u, d: Math.hypot(u.x - c.x, u.y - c.y) }))
        .filter((o) => o.d < 600)
        .sort((a, b) => a.d - b.d);
      for (const { u } of near) {
        if (need <= 0) break;
        this.order(u, c.x + (this.rng() - 0.5) * 40, c.y + (this.rng() - 0.5) * 40, 'defend', c.id);
        need -= unitStrength(u);
      }
    }
    for (const u of [...free]) {
      if (!u.ai || u.ai.role !== 'defend') continue;
      if (threatOf.has(g.cities[u.ai.tag]) && g.cities[u.ai.tag].owner === me) free.delete(u);
      else u.ai = null;
    }

    // Angriffsziel wählen
    // Ziele: neutrale und feindliche Städte (keine verbündeten)
    const candidates = g.cities.filter((c) => c.owner !== me && (!c.owner || g.hostile(c.owner, me)));
    if (!candidates.length) {
      for (const u of free) {
        const e = nearest(g.units.filter((x) => g.hostile(x.owner, me)), u);
        if (e) this.order(u, e.x, e.y, 'hunt', e.id);
      }
      return;
    }
    const centers = myCities.length ? myCities : myUnits;
    let best = null, bestScore = Infinity, bestEst = 0;
    for (const c of candidates) {
      const d = Math.min(...centers.map((o) => Math.hypot(o.x - c.x, o.y - c.y)));
      let est = this.strengthNear(enemies, c.x, c.y, TARGET_RADIUS);
      if (c.owner && !this.cfg.seeAll && !g.isVisible(me, c.x, c.y)) est += 2;
      if (c.owner) est += 0.5;
      const sticky = this.currentTarget === c.id ? -2 : 0;
      const avoid = (this.penalty.get(c.id) || 0) > g.time ? 8 : 0;
      const score = d / 120 + est * 1.5 + sticky + avoid;
      if (score < bestScore) { bestScore = score; best = c; bestEst = est; }
    }
    this.currentTarget = best.id;

    const freeList = [...free];
    const sum = (list) => list.reduce((a, u) => a + unitStrength(u), 0);
    const need = bestEst * this.cfg.attackFactor + (best.owner === 0 ? 0.5 : 2);
    const maxed = myUnits.length >= g.capacity(me) - 1;
    const committed = freeList.filter((u) => u.ai && u.ai.role === 'attack' && u.ai.tag === best.id);
    const committedStrength = sum(committed);

    // Sammelpunkt vor der eigenen Stadt, die dem Ziel am nächsten liegt
    let sx = best.x, sy = best.y;
    if (myCities.length) {
      const stage = nearest(myCities, best);
      const dx = best.x - stage.x, dy = best.y - stage.y;
      const dl = Math.hypot(dx, dy) || 1;
      sx = stage.x + dx / dl * 45; sy = stage.y + dy / dl * 45;
    }
    const gathered = freeList.filter((u) => !committed.includes(u) && Math.hypot(u.x - sx, u.y - sy) < 170);

    if (committed.length && committedStrength < need * 0.35 && !maxed) {
      // Angriff gescheitert: Ziel eine Weile meiden, Reste zurückholen
      this.penalty.set(best.id, g.time + 60);
      this.currentTarget = null;
      for (const u of committed) this.order(u, sx, sy, 'stage', 'regroup');
      return;
    }

    const attack = (list) => {
      for (const u of list) {
        const ox = (this.rng() - 0.5) * 36, oy = (this.rng() - 0.5) * 36;
        this.order(u, best.x + ox, best.y + oy, 'attack', best.id);
      }
    };
    if (committed.length || sum(gathered) >= need || maxed) {
      attack(committed);
      if (committed.length || sum(gathered) >= need * 0.6 || maxed) attack(gathered);
    }
    for (const u of freeList) {
      if (u.ai && u.ai.role === 'attack' && u.ai.tag === best.id) continue;
      if (Math.hypot(u.x - sx, u.y - sy) < 60 && !u.path.length) continue;
      const ox = (this.rng() - 0.5) * 50, oy = (this.rng() - 0.5) * 50;
      this.order(u, sx + ox, sy + oy, 'stage', best.id);
    }
  }

  // Gliederung der KI: Front-Divisionen bilden und auffüllen, Versprengte austragen,
  // Kleinstdivisionen auflösen. Kompanien ohne Division sind die Reserve für Angriffe
  // auf Städte und die Verteidigung.
  organize(myUnits) {
    const g = this.game;
    const ob = g.orbat[this.me];
    let changed = false; // neu aufteilen nur, wenn Divisionen entstehen oder verschwinden
    // Versprengte verlassen ihre Division (nicht, wer gerade zum Heilen rotiert)
    for (const div of [...ob.all(DIVISION)]) {
      if (div.front && div.front.attack) continue;
      const c = centerOf(div);
      const far = c ? unitsOf(div).filter((u) => !u.rotating && Math.hypot(u.x - c.x, u.y - c.y) > DIV_LEAVE) : [];
      if (far.length) {
        ob.remove(far);
        if (div.dissolved) changed = true;
      }
    }
    // Kleinstdivisionen auflösen
    for (const div of [...ob.all(DIVISION)]) {
      if (strength(div) < 3 && !(div.front && div.front.attack)) { ob.disband(div); changed = true; }
    }
    // Front bis zum gewünschten Anteil der Armee auffüllen
    const want = myUnits.length >= 6 ? Math.round(myUnits.length * this.cfg.frontShare) : 0;
    const divs = ob.all(DIVISION);
    const have = divs.reduce((s, d) => s + strength(d), 0);
    const chains = this.fronts.border();
    if (have < want && chains.length) {
      const pts = chains.flat();
      const dist = (u) => {
        let best = Infinity;
        for (let i = 0; i < pts.length; i += 3) best = Math.min(best, Math.hypot(pts[i].x - u.x, pts[i].y - u.y));
        return best;
      };
      const recruits = myUnits
        .filter((u) => !u.regiment && !u.target && !(u.ai && (u.ai.role === 'attack' || u.ai.role === 'retreat')))
        .map((u) => ({ u, d: dist(u) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, want - have)
        .map((o) => o.u);
      // Erst nahe Divisionen mit freien Plätzen auffüllen, ...
      const rest = [];
      for (const u of recruits) {
        let best = null, bd = 300;
        for (const d of divs) {
          if (strength(d) >= DIV_SIZE || (d.front && d.front.attack)) continue;
          const c = centerOf(d);
          const dd = c ? Math.hypot(c.x - u.x, c.y - u.y) : Infinity;
          if (dd < bd) { bd = dd; best = d; }
        }
        if (best) { u.ai = null; ob.add(best, [u]); } else rest.push(u);
      }
      // ... die übrigen nach ihrer Lage an der Grenze zu neuen Divisionen zusammenfassen
      if (rest.length >= DIV_MIN) {
        rest.sort((a, b) => this.fronts.key(a) - this.fronts.key(b));
        const size = Math.ceil(rest.length / Math.ceil(rest.length / DIV_SIZE));
        for (let k = 0; k + 3 <= rest.length; k += size) {
          const group = rest.slice(k, k + size);
          for (const u of group) u.ai = null;
          ob.createDivision(group);
          changed = true;
        }
      }
    } else if (have > want + DIV_SIZE) {
      // Deutlich zu viele an der Front: die schwächste Division wird Reserve
      const idle = divs.filter((d) => !(d.front && d.front.attack));
      if (idle.length > 1) {
        ob.disband(idle.reduce((a, b) => (strength(b) < strength(a) ? b : a)));
        changed = true;
      }
    }
    // Alle Divisionen der KI bilden eine Armee (wie beim Spieler offen in der Größe)
    const loose = ob.all(DIVISION).filter((d) => !d.parent);
    if (loose.length) {
      if (ob.armies.length) ob.addToArmy(ob.armies[0], loose);
      else ob.createArmy(loose);
    }
    this.fronts.syncAll(); // Fronten sofort an die neue Gliederung anpassen
    const gap = this.fronts.uncovered().reduce((s, c) => s + chainLength(c), 0);
    if (changed || this.needSplit || gap > GAP_RESPLIT) this.splitFronts();
  }

  // Alle Divisionen teilen sich die Grenze wie beim Spieler. Während eines Angriffs wird
  // nicht neu aufgeteilt (das würde ihn abbrechen), sondern danach.
  splitFronts() {
    const ob = this.game.orbat[this.me];
    if (this.fronts.fronts.some((f) => f.attack)) { this.needSplit = true; return; }
    const holders = ob.all(DIVISION);
    this.needSplit = false;
    if (!holders.length) return;
    for (const d of holders) for (const u of unitsOf(d)) u.ai = null; // eigene Aufträge enden
    for (const f of this.fronts.splitBorder(holders)) f.rotate = this.cfg.rotate;
  }

  // Angriffe von der Front: die 1–2 Divisionen, die einer Stadt am nächsten sind, stoßen
  // vor, die übrigen halten ihre Abschnitte
  manageAttacks(enemies) {
    const g = this.game;
    const sum = (list) => list.reduce((a, u) => a + unitStrength(u), 0);
    const pressure = (units) => sum(enemies.filter((e) => units.some((u) => Math.hypot(u.x - e.x, u.y - e.y) < 180)));
    const mean = (units, fn) => (units.length ? units.reduce((s, u) => s + fn(u), 0) / units.length : 0);
    for (const f of [...this.fronts.fronts]) {
      // Laufenden Angriff abbrechen, wenn das Kräfteverhältnis kippt oder die Organisation
      // der Division zusammenbricht
      if (f.attack && (sum(f.units) < pressure(f.units) * 0.9 || mean(f.units, (u) => u.org / u.maxOrg) < 0.3)) {
        this.backToBorder(f);
      }
    }
    if (g.time < this.nextFrontAttack) return;
    // Angreifen nur mit gut organisierten, versorgten Divisionen
    const ready = this.fronts.fronts.filter((f) => !f.attack && f.kind !== 'line' &&
      f.units.filter((u) => !u.rotating && !u.broken).length >= 4 &&
      mean(f.units, (u) => u.org / u.maxOrg) >= 0.6 && mean(f.units, (u) => u.supply) >= 0.5);
    // Nur Ziele in Nachschubreichweite: heutige Fahrzeit an der Front plus Weg zum Ziel
    const reach = (c, p) => {
      const i = g.supply.cellFor(this.me, p.x, p.y);
      const base = i >= 0 ? g.supply.nets[this.me].hours[i] : Infinity;
      return base + Math.hypot(c.x - p.x, c.y - p.y) / KM / SUPPLY.truckKmh[2] <= SUPPLY.noneHours * 0.75;
    };
    const targets = g.cities.filter((c) => c.owner !== this.me && (!c.owner || g.hostile(c.owner, this.me)));
    if (!ready.length || !targets.length) return;
    const center = (f) => centerOf(f.division);
    let target = null, bd = Infinity;
    for (const c of targets) {
      for (const f of ready) {
        const p = center(f);
        if (!p || !reach(c, p)) continue;
        const d = Math.hypot(c.x - p.x, c.y - p.y) + (c.owner ? 0 : 80);
        if (d < bd) { bd = d; target = c; }
      }
    }
    if (!target) return;
    const attackers = ready
      .map((f) => ({ f, d: Math.hypot(target.x - center(f).x, target.y - center(f).y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .filter((o, k) => k === 0 || o.d < 500)
      .map((o) => o.f);
    const units = attackers.flatMap((f) => f.units.filter((u) => !u.rotating));
    const defenders = new Set(enemies.filter((e) => Math.hypot(e.x - target.x, e.y - target.y) < TARGET_RADIUS ||
      units.some((u) => Math.hypot(u.x - e.x, u.y - e.y) < 180)));
    // An der Obergrenze der Truppenzahl hilft Warten nicht mehr: dann genügt knappe
    // Überlegenheit (haltende Fronten nehmen kein Land ein, nur Angriffe bewegen die Grenze)
    const maxed = g.units.filter((u) => u.owner === this.me).length >= g.capacity(this.me) - 1;
    const push = maxed ? Math.min(this.cfg.frontPush, 1.1) : this.cfg.frontPush;
    if (sum(units) <= sum([...defenders]) * push + 2) {
      if (maxed) this.limitedPush(ready, enemies);
      return;
    }
    // Ziellinie quer hinter der Stadt, auf die Angreifer aufgeteilt
    const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
    const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
    const dl = Math.hypot(target.x - cx, target.y - cy) || 1;
    const ux = (target.x - cx) / dl, uy = (target.y - cy) / dl;
    const mx = target.x + ux * 40, my = target.y + uy * 40;
    const half = Math.min(220, Math.max(90, units.length * 14));
    const line = [];
    for (let k = -2; k <= 2; k++) line.push({ x: mx - uy * half * k / 2, y: my + ux * half * k / 2 });
    const total = chainLength(line);
    const order = attackers.map((f) => ({ f, t: projectOnChains([line], center(f)) })).sort((a, b) => a.t - b.t);
    order.forEach((o, k) => {
      const part = sliceChains([line], total * k / order.length, total * (k + 1) / order.length)[0] || line;
      this.fronts.planAttack(o.f, part.map((q) => ({ x: q.x, y: q.y })));
      this.fronts.startAttack(o.f);
    });
    this.nextFrontAttack = g.time + 20;
  }

  // Begrenzter Vorstoß ohne Stadt als Ziel: die Front mit dem besten Kräfteverhältnis
  // rückt gegen die Truppen direkt vor ihr ein Stück ins Feindgebiet vor. Löst das Patt,
  // wenn beide Seiten ihre Städte mit der ganzen Reserve decken.
  limitedPush(ready, enemies) {
    const sum = (list) => list.reduce((a, u) => a + unitStrength(u), 0);
    let best = null;
    for (const f of ready) {
      const units = f.units.filter((u) => !u.rotating && !u.broken);
      const pts = f.chains.flat().filter((p) => p.nx !== undefined);
      if (units.length < 4 || !pts.length) continue;
      let nx = pts.reduce((a, p) => a + p.nx, 0), ny = pts.reduce((a, p) => a + p.ny, 0);
      const nl = Math.hypot(nx, ny);
      if (nl < 1e-6) continue;
      nx /= nl; ny /= nl;
      const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
      const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
      const tx = cx + nx * PUSH_DEPTH, ty = cy + ny * PUSH_DEPTH;
      const foes = enemies.filter((e) => Math.hypot(e.x - tx, e.y - ty) < PUSH_DEPTH * 1.6);
      const ratio = sum(units) / (sum(foes) + 1);
      if (ratio > PUSH_RATIO && (!best || ratio > best.ratio)) best = { f, ratio, tx, ty, nx, ny, n: units.length };
    }
    if (!best) return;
    const half = Math.max(90, best.n * 12);
    const line = [];
    for (let k = -2; k <= 2; k++) line.push({ x: best.tx - best.ny * half * k / 2, y: best.ty + best.nx * half * k / 2 });
    this.fronts.planAttack(best.f, line);
    this.fronts.startAttack(best.f);
    this.nextFrontAttack = this.game.time + 30;
  }

  // Angriff abbrechen: die Division hält wieder ihren Grenzabschnitt (er bleibt ihr während
  // des Angriffs zugewiesen)
  backToBorder(f) {
    f.plan = null;
    this.fronts.stopAttack(f);
    this.nextFrontAttack = Math.max(this.nextFrontAttack, this.game.time + 15);
  }

  // Pfade innerhalb eines Denkschritts teilen, um A*-Aufrufe zu sparen
  pathFor(u, x, y) {
    const key = (u.x / 30 | 0) + ',' + (u.y / 30 | 0) + '>' + (x / 30 | 0) + ',' + (y / 30 | 0);
    if (!this.pathCache.has(key)) {
      if (this.budget <= 0) return null;
      this.budget--;
      this.pathCache.set(key, this.game.map.findPath(u.x, u.y, x, y));
    }
    const p = this.pathCache.get(key);
    return p ? p.map((q) => ({ x: q.x, y: q.y })) : [];
  }
}

function nearest(list, p) {
  let best = null, bd = Infinity;
  for (const o of list) {
    const d = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
