import { TERRAIN_INFO, CELL, UNIT_TYPES } from './config.js?v=52';
import { DIVISION, formationOf, unitsOf } from './orbat.js?v=52';

const REFRESH = 1.5;        // Sekunden zwischen Neuberechnungen
const HOLD_OFFSET = 20;     // Grenzfront: so weit hinter der Grenze stehen
const ROTATE_AT = 0.35;     // Verwundete ziehen sich darunter zurück
const ROTATE_AT_ATTACK = 0.2; // während eines Angriffs erst später
const RETURN_AT = 0.9;      // und kehren ab hier zurück
const CODENAMES = ['ADLER', 'FALKE', 'WOLF', 'LUCHS', 'BÄR', 'HABICHT', 'KRANICH', 'ELCH', 'DACHS', 'MARDER', 'BUSSARD', 'STIER'];
const PATH_BUDGET = 4;      // A*-Suchen pro Neuberechnung
const DANGER_RADIUS = 45;   // so viel Abstand halten Verschiebungen zu Feinden

// Fronten wie in Hearts of Iron: Jede Front gehört zu genau einer Division. Deren
// Kompanien verteilen sich gleichmäßig auf der Linie und halten sie selbstständig.
export class FrontManager {
  constructor(game, owner) {
    this.game = game;
    this.owner = owner;
    this.fronts = [];
    this.timer = owner === 1 ? 0 : REFRESH / 2; // Spieler versetzt rechnen
    this.nextId = 1;
    this.events = [];
    this.codename = owner === 1 ? 0 : 7;
    // Löst sich eine Division auf, verschwindet ihre Front sofort
    game.orbat[owner].onDissolve.push((div) => { if (this.fronts.includes(div.front)) this.remove(div.front); });
  }

  // Front einer Division anlegen oder ihre bestehende Front neu ausrichten
  // (eine Division hat höchstens eine Front)
  assign(div, kind, line) {
    let f = this.fronts.includes(div.front) ? div.front : null;
    if (!f) {
      f = { id: this.nextId++, owner: this.owner, division: div, units: [], chains: [], rotate: true };
      div.front = f;
      this.fronts.push(f);
    }
    f.kind = kind;
    f.line = line;
    f.attack = null;
    f.plan = null;
    this.rejoin(f);
    this.refresh(f, true);
    return f;
  }

  remove(f) {
    for (const u of f.units) if (u.front === f) { u.front = null; u.frontGoal = null; u.rotating = false; }
    if (f.division.front === f) f.division.front = null;
    this.fronts = this.fronts.filter((o) => o !== f);
  }

  // Kompanie verlässt die Front ihrer Division, z. B. bei einem manuellen Befehl.
  // Sie bleibt in der Division und kehrt mit „Alle an die Front“ zurück.
  release(u) {
    const f = u.front;
    if (!f) return;
    f.units = f.units.filter((o) => o !== u);
    u.front = null; u.frontGoal = null; u.rotating = false;
    u.offFront = f;
  }

  // Alle Kompanien der Division zurück an die Front
  rejoin(f) {
    for (const u of unitsOf(f.division)) if (u.offFront === f) u.offFront = null;
    this.sync(f);
    this.schedule(f);
  }

  // Kompanien, die gerade nicht an der Front stehen, weil sie einen eigenen Befehl haben
  detached(f) {
    return unitsOf(f.division).filter((u) => u.offFront === f && this.game.units.includes(u)).length;
  }

  // Einheiten der Front = lebende Kompanien der Division (ohne abgezogene)
  // Liefert true, wenn sich die Besetzung geändert hat
  sync(f) {
    const g = this.game;
    const want = unitsOf(f.division).filter((u) => g.units.includes(u) && u.offFront !== f);
    let changed = want.length !== f.units.length;
    for (const u of f.units) {
      if (u.front === f && !want.includes(u)) { u.front = null; u.frontGoal = null; u.rotating = false; changed = true; }
    }
    for (const u of want) {
      if (u.front !== f) {
        if (u.front) this.release(u); // aus einer anderen Front dieser Seite herausnehmen
        u.offFront = null;
        u.front = f;
        u.frontGoal = null;
        changed = true;
      }
    }
    f.units = want;
    return changed;
  }

  syncAll() {
    for (const f of [...this.fronts]) {
      if (f.division.dissolved) this.remove(f);
      else if (this.sync(f)) this.schedule(f);
    }
  }

  // Angriff wie in Hearts of Iron: erst Ziel-Linie planen, dann auf Befehl vorstoßen
  planAttack(f, line) {
    // Phasenlinien tragen wie bei der NATO einen Decknamen
    const name = CODENAMES[this.codename++ % CODENAMES.length];
    f.plan = { line, name };
  }

  cancelPlan(f) {
    f.plan = null;
  }

  startAttack(f) {
    if (!f.plan) return;
    f.kind = 'line';
    f.line = f.plan.line;
    f.attack = { line: f.plan.line, name: f.plan.name, started: this.game.time };
    f.plan = null;
    this.refresh(f, true);
  }

  // Neuberechnung im nächsten Frame statt sofort, damit sich die Rechenlast verteilt
  schedule(f) {
    f.force = true;
    this.timer = Math.min(this.timer, 0.05);
  }

  // Gefahrenkarte: Feindgebiet kostet mehr, die Nähe feindlicher Einheiten sehr viel mehr.
  // Wird höchstens alle 0,5 s neu berechnet.
  safeRouting() {
    const g = this.game;
    if (this.routing && g.time - this.routing.time < 0.5) return this.routing.opts;
    const { w, h } = g.map;
    const danger = this.danger || (this.danger = new Uint8Array(w * h));
    danger.fill(0);
    const cr = DANGER_RADIUS / CELL;
    for (const o of g.units) {
      if (o.owner === this.owner) continue;
      const cx = o.x / CELL, cy = o.y / CELL;
      const x0 = Math.max(0, Math.floor(cx - cr)), x1 = Math.min(w - 1, Math.ceil(cx + cr));
      const y0 = Math.max(0, Math.floor(cy - cr)), y1 = Math.min(h - 1, Math.ceil(cy + cr));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= cr * cr) danger[y * w + x] = 1;
        }
      }
    }
    const tr = g.territory, me = this.owner;
    const opts = {
      cost: (i) => (danger[i] ? 8 : 0) + (tr[i] !== me ? 3 : 0),
      safe: (x, y) => {
        const i = g.map.cellIndex(x, y);
        return !danger[i] && tr[i] === me;
      },
    };
    this.routing = { time: g.time, opts };
    return opts;
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
    if (f.division.dissolved) { this.remove(f); return; }
    this.sync(f);

    f.chains = f.kind === 'border' ? this.borderChains() : [withNormals(f.line, (p, n) => this.facing(p, n))];
    f.length = 0;
    for (const c of f.chains) f.length += chainLength(c);

    // Rotation: Verwundete zur nächsten Stadt, geheilte zurück an die Front
    const active = [];
    for (const u of f.units) {
      const frac = u.hp / u.maxHp;
      const limit = f.attack ? ROTATE_AT_ATTACK : ROTATE_AT;
      // Im Gefecht erst bei schweren Verlusten herauslösen
      // Bei Feindkontakt wird nicht rotiert: die Front hält. Verwundete gehen nur
      // zum Heilen, wenn kein Feind in der Nähe ist.
      if (f.rotate && !u.rotating && frac < limit && !u.target && !this.enemyNear(u, 160)) {
        const c = this.nearestCity(u);
        if (c) {
          u.rotating = true;
          u.frontGoal = null;
          u.path = g.map.findPath(u.x, u.y, c.x, c.y, this.safeRouting()) || [];
          continue;
        }
      }
      if (u.rotating && (frac >= RETURN_AT || !f.rotate)) u.rotating = false;
      if (!u.rotating) active.push(u);
    }

    // Divisionsabschnitte: jede Division bekommt einen zusammenhängenden Abschnitt der
    // Front, Länge nach ihrer Stärke. Kompanien bleiben in ihrem Abschnitt.
    const { slots, ordered } = this.sectionSlots(f, active);
    if (!slots.length) return;
    let budget = PATH_BUDGET;
    let pending = false;
    const shared = new Map(); // Wege für nebeneinander stehende Einheiten mit ähnlichem Ziel teilen
    for (let k = 0; k < slots.length && k < ordered.length; k++) {
      const s = slots[k];
      const u = ordered[k];
      const goalMoved = !u.frontGoal || Math.hypot(u.frontGoal.x - s.x, u.frontGoal.y - s.y) > 20;
      if (!goalMoved && u.path.length) continue; // schon unterwegs: Budget den Wartenden lassen
      if (!goalMoved && Math.hypot(u.x - s.x, u.y - s.y) < 10) continue;
      if (u.target) continue; // im Gefecht die Stellung halten, keine neuen Marschbefehle
      if (u.swapUntil > g.time) continue; // Platztausch innerhalb der Division läuft
      if (u.hqOrder > g.time) continue;   // Befehl des Divisions-HQ hat Vorrang
      // Mit Feind in der Nähe nicht zurückweichen, nur weil sich die Grenze verschoben hat
      // (kleine Verschiebungen ignorieren, bei echtem Durchbruch geordnet zurück)
      // Feindkontakt: Stellung halten wie in HOI4. Nur wer bereits an der Front steht
      // und nicht abgeschnitten im Feindgebiet ist, bleibt; Lücken füllen andere auf.
      // Seitliche Verschiebung in den eigenen Divisionsabschnitt ist erlaubt (hinter der
      // Linie), nur ein Rückzug weg vom Feind wird unterbunden.
      const back = s.nx === undefined ? 0 : -((s.x - u.x) * s.nx + (s.y - u.y) * s.ny);
      if (!f.attack && u.frontGoal && Math.hypot(u.x - u.frontGoal.x, u.y - u.frontGoal.y) < 80 &&
          back > 15 && this.enemyNear(u, 160) && !this.cutOff(u)) {
        if (u.path.length && this.pathLeadsBack(u)) u.path = [];
        continue;
      }
      // Verschiebungen laufen hinter der eigenen Linie, nicht durch Feindgebiet;
      // nur ein Angriff darf direkt hinein
      const opts = f.attack ? null : this.safeRouting();
      if (g.map.clearLine(u, s, opts && opts.safe)) {
        u.path = [{ x: s.x, y: s.y }];
      } else {
        const key = (u.x / 30 | 0) + ',' + (u.y / 30 | 0) + '>' + (s.x / 30 | 0) + ',' + (s.y / 30 | 0);
        let base = shared.get(key);
        if (base === undefined) {
          if (budget <= 0) { pending = true; continue; }
          budget--;
          base = g.map.findPath(u.x, u.y, s.x, s.y, opts) || [];
          shared.set(key, base);
        }
        u.path = base.map((q) => ({ x: q.x, y: q.y }));
        if (u.path.length) u.path[u.path.length - 1] = { x: s.x, y: s.y };
      }
      u.frontGoal = { x: s.x, y: s.y };
      u.stuck = 0;
    }

    // Noch Wege offen: gleich im nächsten Frame weiterrechnen statt bis zur
    // nächsten regulären Neuberechnung zu warten
    if (pending) {
      f.force = true;
      this.timer = Math.min(this.timer, 0.03);
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

  // Abgeschnitten: die Einheit steht auf Feindgebiet und hat kein eigenes Gebiet in der Nähe
  cutOff(u) {
    const g = this.game;
    const tr = g.territory;
    if (tr[g.map.cellIndex(u.x, u.y)] === this.owner) return false;
    for (const [dx, dy] of [[40, 0], [-40, 0], [0, 40], [0, -40]]) {
      if (tr[g.map.cellIndex(u.x + dx, u.y + dy)] === this.owner) return false;
    }
    return true;
  }

  // Führt der aktuelle Weg vom nächsten Feind weg?
  pathLeadsBack(u) {
    let e = null, bd = Infinity;
    for (const o of this.game.units) {
      if (o.owner === this.owner) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < bd) { bd = d; e = o; }
    }
    if (!e) return false;
    const p = u.path[u.path.length - 1];
    return (p.x - u.x) * (e.x - u.x) + (p.y - u.y) * (e.y - u.y) < 0;
  }

  enemyNear(u, r) {
    for (const o of this.game.units) {
      if (o.owner !== this.owner && Math.abs(o.x - u.x) < r && Math.abs(o.y - u.y) < r && Math.hypot(o.x - u.x, o.y - u.y) < r) return true;
    }
    return false;
  }

  sectionSlots(f, active) {
    const total = f.length || 0;
    if (!active.length || total < 1) return { slots: distribute(f.chains, active.length), ordered: active };
    // Lage jeder Kompanie auf der Linie: bevorzugt ihr bisheriger Platz (stabile Reihenfolge)
    const posOf = (u) => projectOnChains(f.chains, u.frontGoal && u.front === f ? u.frontGoal : u);
    const groups = new Map();
    for (const u of active) {
      const d = formationOf(u, DIVISION) || null;
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push({ u, t: posOf(u) });
    }
    const divs = [...groups.entries()].map(([div, list]) => {
      list.sort((a, b) => a.t - b.t);
      const strength = list.reduce((s, o) => s + UNIT_TYPES[o.u.type].strength * (0.4 + 0.6 * o.u.hp / o.u.maxHp), 0);
      // Bekannte Divisionen behalten ihre Reihenfolge (Mitte ihres bisherigen Abschnitts),
      // neue reihen sich nach ihrer Lage ein
      const old = (f.sections || []).find((x) => x.div === div);
      const mean = old ? (old.from + old.to) / 2 : list.reduce((s, o) => s + o.t, 0) / list.length;
      return { div, list, strength, mean };
    }).sort((a, b) => a.mean - b.mean);
    // Anteile langsam angleichen, damit Abschnitte bei kleinen Verlusten nicht springen
    const prev = f.shares || new Map();
    const rawSum = divs.reduce((s, d) => s + d.strength, 0) || 1;
    for (const d of divs) {
      const target = d.strength / rawSum;
      const old = prev.get(d.div);
      d.strength = old === undefined ? target : old * 0.85 + target * 0.15;
    }
    f.shares = new Map(divs.map((d) => [d.div, d.strength]));
    const sum = divs.reduce((s, d) => s + d.strength, 0) || 1;
    const slots = [], ordered = [];
    f.sections = [];
    let start = 0;
    for (const d of divs) {
      const len = total * d.strength / sum;
      const n = d.list.length;
      for (let k = 0; k < n; k++) {
        const pt = pointAt(f.chains, start + (k + 0.5) * len / n);
        if (!pt) continue;
        slots.push(pt);
        ordered.push(d.list[k].u);
      }
      f.sections.push({ div: d.div, from: start, to: start + len });
      start += len;
    }
    return { slots, ordered };
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
  borderChains() {
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

    // Feste Richtung und Reihenfolge, damit die Einheiten bei jeder Neuberechnung
    // ihre Plätze behalten (sonst kehrt sich die Linie um und alle tauschen quer)
    const key = (i) => { const x = i % w, y = (i / w) | 0; return x * 0.3 + y; };
    for (const c of chains) if (key(c[0]) > key(c[c.length - 1])) c.reverse();
    chains.sort((a, b) => key(a[0]) - key(b[0]));
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
        let px = bx - n.x * HOLD_OFFSET, py = by - n.y * HOLD_OFFSET;
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

// Bogenlänge des nächstgelegenen Punkts auf den (aneinandergehängten) Teillinien
export function projectOnChains(chains, p) {
  let best = Infinity, bestT = 0, acc = 0;
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      const d = (p.x - a.x - dx * t) ** 2 + (p.y - a.y - dy * t) ** 2;
      const seg = Math.sqrt(l2);
      if (d < best) { best = d; bestT = acc + seg * t; }
      acc += seg;
    }
  }
  return bestT;
}

export function chainLength(c) {
  let L = 0;
  for (let i = 1; i < c.length; i++) L += Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
  return L;
}

// Punkt bei Bogenlänge t über alle Teillinien
export function pointAt(chains, t) {
  let acc = 0;
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (t <= acc + seg) {
        const k = seg ? (t - acc) / seg : 0;
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, nx: a.nx, ny: a.ny };
      }
      acc += seg;
    }
  }
  const c = chains[chains.length - 1];
  return c && c.length ? { ...c[c.length - 1] } : null;
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
        slots.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: a.nx, ny: a.ny });
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
