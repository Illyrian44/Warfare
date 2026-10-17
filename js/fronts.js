import { TERRAIN_INFO } from './config.js?v=7';

const REFRESH = 1.5;        // Sekunden zwischen Neuberechnungen
const HOLD_OFFSET = 40;     // Grenzfront: so weit hinter der Grenze stehen
const ATTACK_OFFSET = 30;   // Grenzfront im Angriff: so weit in Feindesland drücken
const ROTATE_AT = 0.35;     // Verwundete ziehen sich darunter zurück
const RETURN_AT = 0.9;      // und kehren ab hier zurück
const PATH_BUDGET = 4;      // A*-Suchen pro Neuberechnung

// Fronten wie in Hearts of Iron: Einheiten werden einer Linie zugewiesen,
// verteilen sich gleichmäßig darauf und halten sie selbstständig.
export class FrontManager {
  constructor(game, owner) {
    this.game = game;
    this.owner = owner;
    this.fronts = [];
    this.timer = owner === 1 ? 0 : REFRESH / 2; // Spieler versetzt rechnen
    this.nextId = 1;
    this.events = [];
  }

  create(kind, line, units) {
    for (const u of units) this.release(u);
    const f = {
      id: this.nextId++, owner: this.owner, kind, line, units: [...units], chains: [],
      stance: 'hold', reinforce: true, rotate: true,
    };
    for (const u of f.units) u.front = f;
    this.fronts.push(f);
    this.refresh(f, true);
    return f;
  }

  remove(f) {
    for (const u of f.units) { u.front = null; u.frontGoal = null; u.rotating = false; }
    this.fronts = this.fronts.filter((o) => o !== f);
  }

  // Einheit verlässt ihre Front, z. B. bei einem manuellen Befehl
  release(u) {
    const f = u.front;
    if (!f) return;
    f.units = f.units.filter((o) => o !== u);
    u.front = null; u.frontGoal = null; u.rotating = false;
  }

  add(f, units) {
    for (const u of units) {
      if (u.front === f) continue;
      this.release(u);
      u.front = f;
      f.units.push(u);
    }
    this.schedule(f);
  }

  redraw(f, line) {
    f.line = line;
    this.refresh(f, true);
  }

  // Angriff wie in Hearts of Iron: erst Ziel-Linie planen, dann auf Befehl vorstoßen
  planAttack(f, line) {
    f.plan = { line };
  }

  cancelPlan(f) {
    f.plan = null;
  }

  startAttack(f) {
    if (!f.plan) return;
    f.kind = 'line';
    f.line = f.plan.line;
    f.attack = { line: f.plan.line, started: this.game.time };
    f.plan = null;
    f.stance = 'hold';
    this.refresh(f, true);
  }

  // Neuberechnung im nächsten Frame statt sofort, damit sich die Rechenlast verteilt
  schedule(f) {
    f.force = true;
    this.timer = Math.min(this.timer, 0.05);
  }

  onSpawn(u) {
    let best = null, bestScore = Infinity;
    for (const f of this.fronts) {
      if (!f.reinforce || !f.chains.length) continue;
      const score = (f.units.length + 1) / Math.max(1, f.length);
      if (score < bestScore) { bestScore = score; best = f; }
    }
    if (best) this.add(best, [u]);
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH;
    for (const f of [...this.fronts]) this.refresh(f, !!f.force);
  }

  refresh(f, force) {
    const g = this.game;
    f.force = false;
    f.units = f.units.filter((u) => u.hp > 0 && g.units.includes(u));
    if (!f.units.length && !f.reinforce) { this.remove(f); return; }

    f.chains = f.kind === 'border' ? this.borderChains(f.stance) : [withNormals(f.line, (p, n) => this.facing(p, n))];
    f.length = 0;
    for (const c of f.chains) f.length += chainLength(c);

    // Rotation: Verwundete zur nächsten Stadt, geheilte zurück an die Front
    const active = [];
    for (const u of f.units) {
      const frac = u.hp / u.maxHp;
      if (f.rotate && !u.rotating && frac < ROTATE_AT && !u.target) {
        const c = this.nearestCity(u);
        if (c) {
          u.rotating = true;
          u.frontGoal = null;
          u.path = g.map.findPath(u.x, u.y, c.x, c.y) || [];
          continue;
        }
      }
      if (u.rotating && (frac >= RETURN_AT || !f.rotate)) u.rotating = false;
      if (!u.rotating) active.push(u);
    }

    const slots = distribute(f.chains, active.length);
    if (!slots.length) return;
    // Gierige Zuordnung: jeder Platz bekommt die nächste freie Einheit
    const free = new Set(active);
    let budget = PATH_BUDGET;
    for (const s of slots) {
      let best = null, bd = Infinity;
      for (const u of free) {
        const d = (u.x - s.x) ** 2 + (u.y - s.y) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
      if (!best) break;
      free.delete(best);
      const u = best;
      const goalMoved = !u.frontGoal || Math.hypot(u.frontGoal.x - s.x, u.frontGoal.y - s.y) > 20;
      if (!goalMoved && !force && u.path.length) continue;
      if (!goalMoved && Math.hypot(u.x - s.x, u.y - s.y) < 10) continue;
      if (u.target && Math.hypot(u.x - s.x, u.y - s.y) < 120) continue; // im Gefecht die Stellung halten
      if (g.map.clearLine(u, s)) {
        u.path = [{ x: s.x, y: s.y }];
      } else {
        if (budget <= 0) continue;
        budget--;
        u.path = g.map.findPath(u.x, u.y, s.x, s.y) || [];
      }
      u.frontGoal = { x: s.x, y: s.y };
      u.stuck = 0;
    }

    // Angriff abgeschlossen, sobald die meisten Einheiten ihre Plätze erreicht haben
    if (f.attack && active.length) {
      const arrived = active.filter((u) => u.frontGoal && Math.hypot(u.x - u.frontGoal.x, u.y - u.frontGoal.y) < 30).length;
      if (arrived >= active.length * 0.7) {
        f.attack = null;
        this.events.push({ type: 'attackDone', front: f });
      }
    }
  }

  nearestCity(u) {
    let best = null, bd = Infinity;
    for (const c of this.game.cities) {
      if (c.owner !== this.owner) continue;
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Richtung Feind: die Seite der Linie, auf der weniger eigenes Gebiet liegt
  facing(p, n) {
    const g = this.game;
    let a = 0, b = 0;
    for (const d of [25, 50, 80]) {
      if (g.territory[g.map.cellIndex(p.x + n.x * d, p.y + n.y * d)] !== this.owner) a++;
      if (g.territory[g.map.cellIndex(p.x - n.x * d, p.y - n.y * d)] !== this.owner) b++;
    }
    if (a !== b) return a > b ? 1 : -1;
    // Gleichstand (z. B. neutrales Land auf beiden Seiten): zur nächsten Feindstadt zeigen
    let best = null, bd = Infinity;
    for (const c of g.cities) {
      if (c.owner !== 3 - this.owner) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return 1;
    return (best.x - p.x) * n.x + (best.y - p.y) * n.y >= 0 ? 1 : -1;
  }

  // Grenzzellen zum Gegner (ohne Kontakt: zu fremdem Land) zu Linien verketten
  borderChains(stance) {
    const g = this.game;
    const map = g.map;
    const { w, h } = map;
    const tr = g.territory;
    const me = this.owner, foe = 3 - me;
    const passable = (i) => TERRAIN_INFO[map.cells[i]].passable;
    const collect = (test) => {
      const out = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (tr[i] !== me || !passable(i)) continue;
          if (test(i - 1) || test(i + 1) || test(i - w) || test(i + w)) out.push(i);
        }
      }
      return out;
    };
    let cells = collect((n) => tr[n] === foe);
    if (cells.length < 3) {
      // Noch kein Kontakt: Rand zum fremden Land, das mit dem Gegner verbunden ist und in seine Richtung zeigt
      const outside = new Uint8Array(w * h);
      const stack = [];
      for (let i = 0; i < w * h; i++) if (tr[i] === foe) { outside[i] = 1; stack.push(i); }
      for (const c of g.cities) {
        if (c.owner !== foe) continue;
        const i = map.cellIndex(c.x, c.y);
        if (!outside[i]) { outside[i] = 1; stack.push(i); }
      }
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (n < 0 || n >= w * h || outside[n] || tr[n] === me || !passable(n)) continue;
          outside[n] = 1;
          stack.push(n);
        }
      }
      const foeCities = g.cities.filter((c) => c.owner === foe);
      const frontier = collect((n) => outside[n] === 1);
      cells = frontier.filter((i) => {
        if (!foeCities.length) return true;
        const x = (i % w + 0.5) * map.worldW / w, y = ((i / w | 0) + 0.5) * map.worldH / h;
        let best = null, bd = Infinity;
        for (const c of foeCities) { const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = c; } }
        // Nach außen zeigende Nachbarn in Richtung Gegner?
        let ox = 0, oy = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (outside[i + dy * w + dx]) { ox += dx; oy += dy; }
        const ol = Math.hypot(ox, oy) || 1;
        return (ox * (best.x - x) + oy * (best.y - y)) / (ol * bd) > 0.25;
      });
      if (cells.length < 4) cells = frontier;
    }

    const set = new Set(cells);
    // Nachbarzahl einmal vorab bestimmen; Enden einer Linie haben wenige Nachbarn
    const degree = new Map();
    for (const i of set) {
      let d = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && set.has(i + dy * w + dx)) d++;
      degree.set(i, d);
    }
    const chains = [];
    while (set.size) {
      let start = -1, sd = Infinity;
      for (const i of set) { const d = degree.get(i); if (d < sd) { sd = d; start = i; if (d <= 1) break; } }
      const chain = [];
      let cur = start;
      set.delete(cur);
      while (cur >= 0) {
        chain.push(cur);
        const cx = cur % w, cy = (cur / w) | 0;
        let next = -1, nd = Infinity;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ni = (cy + dy) * w + cx + dx;
            if (!set.has(ni)) continue;
            const d = dx * dx + dy * dy;
            if (d < nd) { nd = d; next = ni; }
          }
        }
        if (next >= 0) set.delete(next);
        cur = next;
      }
      chains.push(chain);
    }
    mergeChains(chains, w, 6);
    const longest = Math.max(0, ...chains.map((c) => c.length));
    const kept = chains.filter((c) => c.length >= 4 && (c.length >= 8 || longest < 16));
    chains.length = 0;
    chains.push(...kept);

    const offset = stance === 'attack' ? ATTACK_OFFSET : -HOLD_OFFSET;
    return chains.map((chain) => {
      const pts = [];
      for (let k = 0; k < chain.length; k += 2) {
        const i = chain[k];
        const cx = i % w, cy = (i / w) | 0;
        // Nach außen zeigende Richtung aus der Umgebung schätzen
        let ox = 0, oy = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if (tr[y * w + x] !== me && passable(y * w + x)) { ox += dx; oy += dy; }
          }
        }
        const ol = Math.hypot(ox, oy) || 1;
        const n = { x: ox / ol, y: oy / ol };
        const bx = (cx + 0.5) * map.worldW / w, by = (cy + 0.5) * map.worldH / h;
        let px = bx + n.x * offset, py = by + n.y * offset;
        if (!map.passableAt(px, py)) { px = bx; py = by; }
        pts.push({ x: px, y: py, nx: n.x, ny: n.y, bx, by });
      }
      return smooth(smooth(pts));
    });
  }
}

// Teilstücke verbinden, deren Enden nah beieinander liegen
function mergeChains(chains, w, maxGap) {
  const pos = (i) => [i % w, (i / w) | 0];
  const gap = (a, b) => { const [ax, ay] = pos(a), [bx, by] = pos(b); return Math.hypot(ax - bx, ay - by); };
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = 0; j < chains.length; j++) {
        if (i === j) continue;
        const A = chains[i], B = chains[j];
        const options = [
          [gap(A[A.length - 1], B[0]), () => A.concat(B)],
          [gap(A[A.length - 1], B[B.length - 1]), () => A.concat(B.slice().reverse())],
          [gap(A[0], B[0]), () => A.slice().reverse().concat(B)],
        ];
        for (const [d, join] of options) {
          if (d > maxGap) continue;
          chains[i] = join();
          chains.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
}

function smooth(pts) {
  if (pts.length < 3) return pts;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    return { ...p, x: (a.x + p.x * 2 + b.x) / 4, y: (a.y + p.y * 2 + b.y) / 4 };
  });
}

function withNormals(line, facing) {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / l, y: dx / l };
    const s = facing(p, n);
    return { x: p.x, y: p.y, nx: n.x * s, ny: n.y * s, bx: p.x, by: p.y };
  });
}

export function chainLength(c) {
  let L = 0;
  for (let i = 1; i < c.length; i++) L += Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
  return L;
}

// n Plätze gleichmäßig über alle Teillinien verteilen
function distribute(chains, n) {
  if (!n || !chains.length) return [];
  const total = chains.reduce((a, c) => a + chainLength(c), 0);
  if (total < 1) {
    const p = chains[0][0];
    return Array.from({ length: n }, () => ({ x: p.x, y: p.y }));
  }
  const spacing = total / n;
  const slots = [];
  let target = spacing / 2;
  let acc = 0;
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      while (target <= acc + seg && slots.length < n) {
        const t = seg ? (target - acc) / seg : 0;
        slots.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        target += spacing;
      }
      acc += seg;
    }
  }
  while (slots.length < n) {
    const c = chains[chains.length - 1];
    slots.push({ ...c[c.length - 1] });
  }
  return slots;
}

export function frontBadge(f) {
  let best = null, bl = -1;
  for (const c of f.chains) {
    const l = chainLength(c);
    if (l > bl) { bl = l; best = c; }
  }
  if (!best || !best.length) return null;
  let half = bl / 2;
  for (let i = 1; i < best.length; i++) {
    const a = best[i - 1], b = best[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (half <= seg) {
      const t = seg ? half / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    half -= seg;
  }
  return best[0];
}
