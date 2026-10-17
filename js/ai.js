import { DIFFICULTY } from './config.js?v=3';
import { unitStrength } from './game.js?v=3';
import { mulberry32 } from './rng.js?v=3';

const THREAT_RADIUS = 170;
const TARGET_RADIUS = 240;

export class AI {
  constructor(game, player, difficulty = 'medium') {
    this.game = game;
    this.me = player;
    this.foe = 3 - player;
    this.cfg = DIFFICULTY[difficulty];
    this.timer = 1;
    this.rng = mulberry32((game.map.seed * 31 + player) >>> 0);
    game.prodMult[player] = this.cfg.prodMult;
    this.currentTarget = null;
    this.penalty = new Map();
    this.pathCache = new Map();
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.cfg.interval * (0.8 + this.rng() * 0.4);
    this.pathCache.clear();
    this.budget = 8;
    this.think();
  }

  visibleEnemies() {
    const g = this.game;
    return g.units.filter((u) => u.owner === this.foe && (this.cfg.seeAll || g.isVisible(this.me, u.x, u.y)));
  }

  strengthNear(list, x, y, r) {
    let s = 0;
    for (const u of list) if (Math.hypot(u.x - x, u.y - y) <= r) s += unitStrength(u);
    return s;
  }

  order(u, x, y, role, tag) {
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

    // Produktion festlegen
    for (const c of myCities) {
      if (c.timer < 1) c.prodType = this.rng() < this.cfg.heavyRatio ? 'heavy' : 'light';
    }
    if (!myUnits.length) return;

    const free = new Set(myUnits);

    // Angeschlagene Einheiten zurückziehen
    for (const u of myUnits) {
      const frac = u.hp / u.maxHp;
      if (u.ai && u.ai.role === 'retreat') {
        if (frac > 0.85 || !myCities.length) u.ai = null;
        else { free.delete(u); continue; }
      }
      if (frac < this.cfg.retreatAt && myCities.length) {
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
    for (const [c, s] of threats) {
      let need = s * 1.2;
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
    const candidates = g.cities.filter((c) => c.owner !== me);
    if (!candidates.length) {
      for (const u of free) {
        const e = nearest(g.units.filter((x) => x.owner === this.foe), u);
        if (e) this.order(u, e.x, e.y, 'hunt', e.id);
      }
      return;
    }
    const centers = myCities.length ? myCities : myUnits;
    let best = null, bestScore = Infinity, bestEst = 0;
    for (const c of candidates) {
      const d = Math.min(...centers.map((o) => Math.hypot(o.x - c.x, o.y - c.y)));
      let est = this.strengthNear(enemies, c.x, c.y, TARGET_RADIUS);
      if (c.owner === this.foe && !this.cfg.seeAll && !g.isVisible(me, c.x, c.y)) est += 2;
      if (c.owner === this.foe) est += 0.5;
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
