import { DIFFICULTY } from './config.js?v=20';
import { unitStrength } from './game.js?v=20';
import { mulberry32 } from './rng.js?v=20';
import { FrontManager } from './fronts.js?v=20';

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
    this.fronts = new FrontManager(game, player);
    this.front = null;
    this.nextFrontAttack = 30;
    this.events = [];
  }

  update(dt) {
    this.fronts.update(dt);
    this.fronts.events.length = 0;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.cfg.interval * (0.8 + this.rng() * 0.4);
    this.pathCache.clear();
    this.budget = 5;
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
    if (u.swapUntil > this.game.time) return; // Platztausch innerhalb der Division läuft
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

    this.manageFront(myUnits, enemies);
    const free = new Set(myUnits.filter((u) => !u.front));

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

  // Grenzfront wie ein Spieler: ein Teil der Armee hält die Grenze, der Rest greift Städte an
  manageFront(myUnits, enemies) {
    if (this.front && !this.fronts.fronts.includes(this.front)) this.front = null;
    const want = myUnits.length >= 6 ? Math.round(myUnits.length * this.cfg.frontShare) : 0;
    if (!want) return;
    if (!this.front) {
      this.front = this.fronts.create('border', null, []);
      this.front.reinforce = false;
      this.front.rotate = this.cfg.rotate;
      if (!this.front.chains.length) {
        this.fronts.remove(this.front);
        this.front = null;
        return;
      }
    }
    const f = this.front;
    const have = f.units.length;
    if (have < want) {
      // Freie Einheiten, die der Grenze am nächsten stehen, an die Front schicken
      const pts = f.chains.flat();
      const dist = (u) => {
        let best = Infinity;
        for (let i = 0; i < pts.length; i += 3) best = Math.min(best, Math.hypot(pts[i].x - u.x, pts[i].y - u.y));
        return best;
      };
      const cands = myUnits
        .filter((u) => !u.front && !u.target && !(u.ai && (u.ai.role === 'retreat' || u.ai.role === 'attack')))
        .map((u) => ({ u, d: dist(u) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, want - have)
        .map((o) => o.u);
      if (cands.length) {
        for (const u of cands) u.ai = null;
        this.fronts.add(f, cands);
      }
    } else if (have > want + 2) {
      // Überschuss für Angriffe freigeben
      for (const u of f.units.slice(want)) { this.fronts.release(u); u.path = []; }
    }

    // Halten oder angreifen, je nach Kräfteverhältnis an der Front
    let mine = 0;
    for (const u of f.units) mine += unitStrength(u);
    let theirs = 0;
    for (const e of enemies) {
      if (f.units.some((u) => Math.hypot(u.x - e.x, u.y - e.y) < 180)) theirs += unitStrength(e);
    }
    const g = this.game;
    if (f.attack) {
      // Laufenden Angriff abbrechen, wenn das Kräfteverhältnis kippt
      if (mine < theirs * 0.9) this.backToBorder(f);
      return;
    }
    if (f.kind === 'line') {
      // Angriff beendet: wieder der (vorgerückten) Grenze folgen
      this.backToBorder(f);
      return;
    }
    if (g.time < this.nextFrontAttack || f.units.length < 4) return;
    if (mine > theirs * this.cfg.frontPush + 2) this.launchFrontAttack(f);
  }

  // Angriffspfeil wie der Spieler: Ziellinie quer hinter die nächste feindliche Stadt legen
  launchFrontAttack(f) {
    const g = this.game;
    const active = f.units.filter((u) => !u.rotating);
    if (!active.length) return;
    const cx = active.reduce((a, u) => a + u.x, 0) / active.length;
    const cy = active.reduce((a, u) => a + u.y, 0) / active.length;
    const targets = g.cities.filter((c) => c.owner !== this.me);
    if (!targets.length) return;
    let target = null, bd = Infinity;
    for (const c of targets) {
      const d = Math.hypot(c.x - cx, c.y - cy) + (c.owner === this.foe ? 0 : 80);
      if (d < bd) { bd = d; target = c; }
    }
    const dx = target.x - cx, dy = target.y - cy;
    const dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl;
    const mx = target.x + ux * 40, my = target.y + uy * 40;
    const half = Math.min(220, Math.max(90, active.length * 14));
    const line = [];
    for (let k = -2; k <= 2; k++) {
      line.push({ x: mx - uy * half * k / 2, y: my + ux * half * k / 2 });
    }
    this.fronts.planAttack(f, line);
    this.fronts.startAttack(f);
    this.nextFrontAttack = g.time + 20;
    this.events.push({ type: 'enemyAttack', front: f, target });
  }

  backToBorder(f) {
    f.kind = 'border';
    f.line = null;
    f.attack = null;
    f.plan = null;
    f.stance = 'hold';
    this.fronts.schedule(f);
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
