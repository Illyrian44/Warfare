import { TERRAIN_INFO, CELL, UNIT_TYPES } from './config.js?v=102';
import { DIVISION, formationOf, unitsOf, centerOf } from './orbat.js?v=102';

const REFRESH = 1.5;        // Sekunden zwischen Neuberechnungen
const HOLD_OFFSET = 20;     // Grenzfront: so weit hinter der Grenze stehen
const ROTATE_AT = 0.35;     // Verwundete ziehen sich darunter zurück
const ROTATE_AT_ATTACK = 0.2; // während eines Angriffs erst später
const RETURN_AT = 0.9;      // und kehren ab hier zurück
const CODENAMES = ['ADLER', 'FALKE', 'WOLF', 'LUCHS', 'BÄR', 'HABICHT', 'KRANICH', 'ELCH', 'DACHS', 'MARDER', 'BUSSARD', 'STIER'];
const PATH_BUDGET = 2;      // A*-Suchen je Durchgang, für alle Fronten einer Seite zusammen
const DANGER_RADIUS = 45;   // so viel Abstand halten Verschiebungen zu Feinden
const SNAP_DIST = 60;       // so nah an der Grenze rastet eine gezeichnete Linie ein
const NEIGHBOR_DIST = 70;   // Fronten, deren Enden so nah beieinander liegen, sind Nachbarn
const MIN_SECTION = 30;     // kürzere Reste eines Grenzabschnitts zählen nicht
const TAU = Math.PI * 2;
const KEY_R = 200;          // Lagewert = Winkel um die Startstadt mal KEY_R (siehe key())
const SEAM = KEY_R * Math.PI; // größerer Sprung zwischen Nachbarpunkten: über die Nahtstelle

// Fronten wie in Hearts of Iron: Jede Front gehört zu genau einer Division. Deren
// Kompanien verteilen sich gleichmäßig auf der Linie und halten sie selbstständig.
// Arten: 'line' (frei gezeichnet), 'border' (ganze Grenze) und 'segment' (Grenzabschnitt
// zwischen zwei Ankerpunkten; null = bis zum Ende der Grenze). Abschnitte wandern mit
// der Grenze, benachbarte teilen sich ihre Ankerpunkte (siehe key()).
export class FrontManager {
  constructor(game, owner) {
    this.game = game;
    this.owner = owner;
    this.fronts = [];
    this.timer = REFRESH * ((owner - 1) % 4) / 4; // Seiten versetzt rechnen
    this.pathBudget = PATH_BUDGET;
    this.nextId = 1;
    this.events = [];
    this.codename = (owner - 1) * 5;
    // Löst sich eine Division auf, verschwindet ihre Front sofort
    game.orbat[owner].onDissolve.push((div) => { if (this.fronts.includes(div.front)) this.remove(div.front); });
    this.key({ x: 0, y: 0 }); // Pol und Naht aus der Startaufstellung festlegen (siehe key())
    // Wegfindung hinter der eigenen Linie auch für Spiel und HQs (Festgefahrene, Rückzug)
    (game.routers || (game.routers = {}))[owner] = this;
  }

  // Front einer Division anlegen oder ihre bestehende Front neu ausrichten
  // (eine Division hat höchstens eine Front). Grenzfronten und -abschnitte kürzen
  // ältere, mit denen sie sich überschneiden (außer beim Aufteilen, das selbst abgleicht).
  // keep: nur den Abschnitt verschieben – laufender Angriff, Plan und abgezogene
  // Kompanien bleiben (für Divisionen, die beim Neuaufteilen nur mitgenommen werden)
  assign(div, kind, line, anchors = null, claim = true, keep = false) {
    let f = this.fronts.includes(div.front) ? div.front : null;
    if (f && keep && kind !== 'line' && f.kind !== 'line') {
      f.kind = kind;
      f.line = null;
      f.anchors = kind === 'segment' ? this.orderAnchors(anchors) : null;
      this.prepare(f);
      if (claim) this.claim(f);
      this.updateNeighbors();
      return f;
    }
    if (!f) {
      f = { id: this.nextId++, owner: this.owner, division: div, units: [], chains: [], rotate: true, neighbors: [] };
      div.front = f;
      this.fronts.push(f);
    }
    f.kind = kind;
    f.line = line;
    f.anchors = kind === 'segment' ? this.orderAnchors(anchors) : null;
    f.attack = null;
    f.plan = null;
    this.rejoin(f);
    this.prepare(f);
    if (claim && kind !== 'line') this.claim(f);
    this.updateNeighbors();
    return f;
  }

  // Grenzlinien je festem Zeitfenster von 0,5 s einmal berechnen; alle Abschnitte teilen sie
  // sich. Feste Fenster statt „0,5 s nach der letzten Abfrage“: so ändert eine zusätzliche
  // Abfrage (Anzeige, Test) nichts am Spielverlauf
  border() {
    const slot = Math.floor(this.game.time / 0.5);
    if (!this.borderCache || this.borderCache.slot !== slot) {
      this.borderCache = { slot, chains: this.borderChains(), segs: null };
    }
    return this.borderCache.chains;
  }

  // Lagewert eines Punkts: sein Winkel um die eigene Startstadt (mal KEY_R). Grenzabschnitte
  // werden über diesen Wert abgegrenzt: der Wert eines Ankerpunkts bleibt fest, auch wenn die
  // Grenze zerfällt oder ihre Teilstücke die Reihenfolge wechseln. Benachbarte Abschnitte
  // teilen sich einen Ankerpunkt und damit genau einen Wert: keine Lücke, keine Überlappung.
  // Der Winkel statt einer festen Achse trägt auch Grenzen, die das eigene Land zu mehreren
  // Gegnern ringsum umschließen. Die Nahtstelle (Wert 0) liegt auf der vom Feind abgewandten
  // Seite; Pol und Naht entstehen einmal aus der Startaufstellung.
  key(p) {
    if (!this.pole) {
      const g = this.game;
      const home = g.starts ? g.cities[g.starts[this.owner]] : g.cities.find((c) => c.owner === this.owner);
      const c0 = home || { x: g.map.worldW / 2, y: g.map.worldH / 2 };
      const foes = g.cities.filter((c) => c.owner && c.owner !== this.owner);
      let cut = 0;
      if (foes.length) {
        const mx = foes.reduce((a, c) => a + c.x, 0) / foes.length, my = foes.reduce((a, c) => a + c.y, 0) / foes.length;
        cut = Math.atan2(c0.y - my, c0.x - mx);
      }
      this.pole = { x: c0.x, y: c0.y, cut };
    }
    let a = Math.atan2(p.y - this.pole.y, p.x - this.pole.x) - this.pole.cut;
    a = ((a % TAU) + TAU) % TAU;
    return a * KEY_R;
  }

  // Teilstücke der Grenze mit ihren Achsenwerten (zum Messen von Längen)
  borderSegs() {
    this.border();
    const bc = this.borderCache;
    if (!bc.segs) {
      bc.segs = [];
      bc.kmin = Infinity;
      bc.kmax = -Infinity;
      for (const c of bc.chains) {
        for (let i = 1; i < c.length; i++) {
          const ka = this.key(c[i - 1]), kb = this.key(c[i]);
          if (Math.abs(kb - ka) > SEAM) continue; // Stück über die Nahtstelle
          bc.segs.push({ a: c[i - 1], b: c[i], lo: Math.min(ka, kb), hi: Math.max(ka, kb), ka, kb,
            len: Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y) });
          bc.kmin = Math.min(bc.kmin, ka, kb);
          bc.kmax = Math.max(bc.kmax, ka, kb);
        }
      }
    }
    return bc;
  }

  // Grenzlänge mit Achsenwert unter k
  lenBelow(k) {
    let L = 0;
    for (const s of this.borderSegs().segs) {
      if (k >= s.hi) L += s.len;
      else if (k > s.lo) L += s.len * (k - s.lo) / (s.hi - s.lo);
    }
    return L;
  }

  // Achsenwert, unter dem die Grenzlänge L liegt
  keyAtLen(L) {
    const { kmin, kmax } = this.borderSegs();
    let lo = kmin, hi = kmax;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (this.lenBelow(mid) < L) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Ein Punkt der Grenze mit dem Achsenwert k (als neuer Ankerpunkt)
  anchorAt(k) {
    for (const s of this.borderSegs().segs) {
      if (k < s.lo || k > s.hi) continue;
      const t = s.kb === s.ka ? 0 : (k - s.ka) / (s.kb - s.ka);
      return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    }
    const a = k / KEY_R + this.pole.cut;
    return { x: this.pole.x + Math.cos(a) * KEY_R, y: this.pole.y + Math.sin(a) * KEY_R };
  }

  // Ankerpunkte entlang der Achse ordnen (vorderer zuerst)
  orderAnchors(anchors) {
    const [a, b] = anchors;
    if (!a || !b) return [a || null, b || null];
    return this.key(a) <= this.key(b) ? [a, b] : [b, a];
  }

  // Bereich einer Grenzfront als Achsenwerte, begrenzt auf die heutige Grenze
  // (null-Anker = bis zum Ende der Grenze)
  rangeOf(f) {
    const { kmin, kmax } = this.borderSegs();
    const [a, b] = f.kind === 'segment' && f.anchors ? f.anchors : [null, null];
    const k0 = a ? Math.min(kmax, Math.max(kmin, this.key(a))) : kmin;
    const k1 = b ? Math.min(kmax, Math.max(kmin, this.key(b))) : kmax;
    return [k0, Math.max(k0, k1)];
  }

  chainsFor(f) {
    if (f.kind === 'line') return [withNormals(f.line, (p, n) => this.facing(p, n))];
    const chains = this.border();
    if (f.kind === 'border') return chains;
    const [a, b] = f.anchors;
    return sliceByKey(chains, (p) => this.key(p), a ? this.key(a) : -Infinity, b ? this.key(b) : Infinity);
  }

  // Liegt eine gezeichnete Linie an der Grenze, wird sie zum Grenzabschnitt zwischen
  // ihren Endpunkten: liefert die Ankerpunkte, sonst null
  snapToBorder(line) {
    const chains = this.border();
    if (!chains.length || line.length < 2) return null;
    const step = Math.max(1, Math.floor(line.length / 12));
    let near = 0, n = 0;
    for (let i = 0; i < line.length; i += step) {
      n++;
      if (distToChains(chains, line[i]) < SNAP_DIST) near++;
    }
    if (near < n * 0.7) return null;
    const a = line[0], b = line[line.length - 1];
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }

  // Ein neuer Grenzabschnitt kürzt ältere, die sich mit ihm überschneiden; ganz
  // überdeckte verlieren ihre Front (die Division bleibt bestehen). Liegt der neue
  // Abschnitt mitten in einem alten, behält dieser die längere Seite; das kürzere Reststück
  // übernimmt der Nachbar, der dort angrenzt (er teilt sich den Ankerpunkt)
  claim(f) {
    if (!this.border().length) return;
    // Enden, die fast auf dem Ankerpunkt eines anderen Abschnitts liegen, übernehmen ihn
    if (f.kind === 'segment') {
      f.anchors = f.anchors.map((a) => {
        if (!a) return a;
        const la = this.lenBelow(this.key(a));
        for (const o of this.fronts) {
          if (o === f || o.kind !== 'segment') continue;
          for (const b of o.anchors) if (b && Math.abs(this.lenBelow(this.key(b)) - la) < MIN_SECTION) return b;
        }
        return a;
      });
    }
    const [a0, a1] = this.rangeOf(f);
    const [fa, fb] = f.kind === 'segment' ? f.anchors : [null, null];
    for (const o of [...this.fronts]) {
      if (o === f || o.kind === 'line') continue; // auch angreifende: sie behalten ihren Abschnitt
      const [b0, b1] = this.rangeOf(o);
      if (b1 <= a0 || b0 >= a1) continue; // keine Überschneidung
      // was links bzw. rechts vom neuen Abschnitt übrig bliebe (als Grenzlänge)
      const left = this.lenBelow(a0) - this.lenBelow(b0), right = this.lenBelow(b1) - this.lenBelow(a1);
      if (left < MIN_SECTION && right < MIN_SECTION) {
        this.events.push({ type: 'frontLost', division: o.division });
        this.remove(o);
        continue;
      }
      const [oa, ob] = o.kind === 'segment' ? o.anchors : [null, null];
      o.kind = 'segment';
      const keepLeft = left >= right;
      o.anchors = keepLeft ? [oa, fa] : [fb, ob];
      const lost = keepLeft ? ob : oa;   // Ankerpunkt am aufgegebenen Ende des alten Abschnitts
      const now = keepLeft ? fb : fa;    // dorthin rückt der Nachbar vor
      if (lost && (keepLeft ? right : left) > 1) {
        for (const n of this.fronts) {
          if (n === o || n === f || n.kind !== 'segment') continue;
          const i = n.anchors.indexOf(lost);
          if (i >= 0) { n.anchors[i] = now; this.prepare(n); }
        }
      }
      this.prepare(o);
    }
  }

  // Grenze oder Grenzabschnitt für Divisionen (Knopf „Grenze“ bzw. gezeichnete Linie an der
  // Grenze): Divisionen, deren Abschnitt ganz darin liegt, teilen ihn mit, statt ihre Front
  // zu verlieren. So kommt eine weitere Division zu den Divisionen an der Grenze dazu.
  shareBorder(divs, anchors = [null, null]) {
    if (!this.border().length) return [];
    const range = this.orderAnchors(anchors);
    const [k0, k1] = this.rangeOf({ kind: 'segment', anchors: range });
    const L0 = this.lenBelow(k0), L1 = this.lenBelow(k1);
    const inside = this.fronts.filter((f) => {
      if (f.kind === 'line' || divs.includes(f.division)) return false;
      const [b0, b1] = this.rangeOf(f);
      return this.lenBelow(b0) >= L0 - MIN_SECTION && this.lenBelow(b1) <= L1 + MIN_SECTION;
    }).map((f) => f.division);
    return this.splitBorder([...divs, ...inside], anchors, inside);
  }

  // Mehrere Divisionen teilen sich die Grenze (oder einen Abschnitt davon): aneinander-
  // liegende Abschnitte, Länge nach Stärke, Reihenfolge nach ihrer Lage an der Grenze.
  // keepDivs werden nur mitgenommen (siehe assign: keep)
  splitBorder(divs, anchors = [null, null], keepDivs = []) {
    if (!this.border().length) return [];
    const range = this.orderAnchors(anchors);
    const [k0, k1] = this.rangeOf({ kind: 'segment', anchors: range });
    const L0 = this.lenBelow(k0), L1 = this.lenBelow(k1);
    const order = this.byPosition(divs, (c) => this.key(c));
    const sum = order.reduce((s, o) => s + o.s, 0) || 1;
    const made = [];
    let acc = L0, prev = range[0];
    order.forEach((o, k) => {
      acc += (L1 - L0) * o.s / sum;
      const next = k === order.length - 1 ? range[1] : this.anchorAt(this.keyAtLen(acc));
      made.push(this.assign(o.d, 'segment', null, [prev, next], false, keepDivs.includes(o.d)));
      prev = next;
    });
    // Erst alle neuen Abschnitte setzen, dann ältere Fronten anderer Divisionen kürzen;
    // so verdrängen sich die aufgeteilten Divisionen nicht gegenseitig
    for (const f of made) this.claim(f);
    return made;
  }

  // Mehrere Divisionen teilen sich eine frei gezeichnete Linie
  splitLine(divs, line) {
    const chains = [line];
    const total = chainLength(line);
    const order = this.byPosition(divs, (c) => projectOnChains(chains, c));
    const sum = order.reduce((s, o) => s + o.s, 0) || 1;
    let acc = 0;
    return order.map((o) => {
      const from = acc;
      acc += total * o.s / sum;
      const part = sliceChains(chains, from, acc)[0] || line;
      return this.assign(o.d, 'line', part.map((q) => ({ x: q.x, y: q.y })));
    });
  }

  // Divisionen nach ihrer Lage (pos des Schwerpunkts) ordnen, mit ihrer Stärke
  byPosition(divs, pos) {
    return divs.map((d) => {
      const c = centerOf(d);
      const s = unitsOf(d).reduce((a, u) => a + UNIT_TYPES[u.type].strength * (0.4 + 0.6 * u.hp / u.maxHp), 0);
      return { d, t: c ? pos(c) : 0, s };
    }).sort((a, b) => a.t - b.t);
  }

  // Grenzstücke, die keine Grenzfront und kein Grenzabschnitt deckt (zum Anzeigen);
  // höchstens alle 0,5 s neu berechnet
  uncovered() {
    const g = this.game;
    const sig = this.fronts.map((f) => f.id + f.kind + (f.anchors ? f.anchors.map((a) => (a ? a.x : '-')).join() : '')).join('|');
    const slot = Math.floor(g.time / 0.5);
    if (this.gapCache && this.gapCache.slot === slot && this.gapCache.sig === sig) return this.gapCache.parts;
    const chains = this.border();
    const parts = [];
    if (chains.length) {
      const { kmin, kmax } = this.borderSegs();
      const key = (p) => this.key(p);
      const covered = this.fronts.filter((f) => f.kind !== 'line').map((f) => this.rangeOf(f)).sort((a, b) => a[0] - b[0]);
      let k = kmin;
      for (const [k0, k1] of covered) {
        if (this.lenBelow(k0) - this.lenBelow(k) > MIN_SECTION) parts.push(...sliceByKey(chains, key, k, k0));
        k = Math.max(k, k1);
      }
      if (this.lenBelow(kmax) - this.lenBelow(k) > MIN_SECTION) parts.push(...sliceByKey(chains, key, k, kmax));
    }
    this.gapCache = { slot, sig, parts };
    return parts;
  }

  // Nachbarn: Fronten dieser Seite, deren Enden nah an den eigenen Enden liegen
  updateNeighbors() {
    const ends = new Map();
    for (const f of this.fronts) {
      const c = f.chains.filter((x) => x.length);
      ends.set(f, c.length ? [c[0][0], c[c.length - 1][c[c.length - 1].length - 1]] : []);
    }
    for (const f of this.fronts) {
      const mine = ends.get(f);
      f.neighbors = this.fronts.filter((o) => o !== f &&
        mine.some((p) => ends.get(o).some((q) => Math.hypot(p.x - q.x, p.y - q.y) < NEIGHBOR_DIST)));
    }
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
    return unitsOf(f.division).filter((u) => u.offFront === f).length;
  }

  // Einheiten der Front = lebende Kompanien der Division (ohne abgezogene)
  // Liefert true, wenn sich die Besetzung geändert hat
  sync(f) {
    const g = this.game;
    const want = unitsOf(f.division).filter((u) => u.offFront !== f);
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

  // Angriff für mehrere Fronten (z. B. eine Armee): die Ziellinie wird nach Lage und Stärke
  // der Divisionen aufgeteilt, alle Teile tragen denselben Decknamen
  planAttackGroup(fronts, line) {
    if (fronts.length === 1) { this.planAttack(fronts[0], line); return; }
    const name = CODENAMES[this.codename++ % CODENAMES.length];
    const total = chainLength(line);
    const order = this.byPosition(fronts.map((f) => f.division), (c) => projectOnChains([line], c));
    const sum = order.reduce((s, o) => s + o.s, 0) || 1;
    let acc = 0;
    for (const o of order) {
      const from = acc;
      acc += total * o.s / sum;
      const part = sliceChains([line], from, acc)[0] || line;
      o.d.front.plan = { line: part.map((q) => ({ x: q.x, y: q.y })), name };
    }
  }

  // Den Grenzbereich, den diese Divisionen gemeinsam halten, neu unter ihnen aufteilen
  // (z. B. wenn eine Division zu ihrer Armee kommt). Nicht während eines Angriffs.
  regroup(divs) {
    const held = divs.map((d) => d.front).filter((f) => f && this.fronts.includes(f) && f.kind !== 'line');
    if (!held.length || held.some((f) => f.attack)) return [];
    const ranges = held.map((f) => ({ f, r: this.rangeOf(f) }));
    const lo = ranges.reduce((a, b) => (b.r[0] < a.r[0] ? b : a));
    const hi = ranges.reduce((a, b) => (b.r[1] > a.r[1] ? b : a));
    const end = (f, i) => (f.kind === 'segment' ? f.anchors[i] : null);
    const rotate = held[0].rotate;
    const made = this.splitBorder(divs, [end(lo.f, 0), end(hi.f, 1)], held.map((f) => f.division));
    for (const f of made) f.rotate = rotate;
    return made;
  }

  cancelPlan(f) {
    f.plan = null;
  }

  // Angriff als Auftrag an die Front: die Division bleibt ihrem Abschnitt (bzw. ihrer
  // Grenze) zugewiesen, ihre Kompanien rücken nur bis zur Ziellinie vor. Danach halten sie
  // wieder ihren Abschnitt, der mit der vorgerückten Grenze mitwandert. Nur eine frei
  // gezeichnete Front ('line') rückt selbst auf die Ziellinie vor.
  startAttack(f) {
    if (!f.plan) return;
    f.attack = { line: f.plan.line, name: f.plan.name, started: this.game.time };
    f.plan = null;
    for (const u of f.units) u.frontGoal = null;
    this.prepare(f);
  }

  // Angriff beenden (erreicht oder abgebrochen): zurück zum Halten des eigenen Abschnitts
  stopAttack(f, reached = false) {
    if (!f.attack) return;
    if (reached && f.kind === 'line') f.line = f.attack.line;
    f.attack = null;
    for (const u of f.units) u.frontGoal = null;
    this.schedule(f);
  }

  // Linie und Besetzung sofort, die Wege erst im nächsten Durchgang (verteilt die Rechenlast)
  prepare(f) {
    this.sync(f);
    f.chains = this.chainsFor(f);
    f.length = f.chains.reduce((s, c) => s + chainLength(c), 0);
    this.schedule(f);
  }

  // Neuberechnung im nächsten Frame statt sofort, damit sich die Rechenlast verteilt
  schedule(f) {
    f.force = true;
    this.timer = Math.min(this.timer, 0.05);
  }

  // Gefahrenkarte für Verschiebungen hinter der eigenen Linie: Feindgebiet ist so teuer,
  // dass es nur betreten wird, wenn es keinen anderen Weg gibt; die Nähe feindlicher
  // Einheiten kostet mäßig (kurze Wege an der eigenen Front entlang, weite dahinter).
  // Wird höchstens alle 0,5 s neu berechnet.
  safeRouting() {
    const g = this.game;
    const slot = Math.floor(g.time / 0.5);
    if (this.routing && this.routing.slot === slot) return this.routing.opts;
    const { w, h } = g.map;
    const danger = this.danger || (this.danger = new Uint8Array(w * h));
    danger.fill(0);
    const cr = DANGER_RADIUS / CELL;
    for (const o of g.units) {
      if (!g.hostile(o.owner, this.owner)) continue;
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
    // fremdes Land (feindlich oder verbündet) sehr teuer, neutrales etwas teurer als eigenes
    const opts = {
      cost: (i) => (danger[i] ? 4 : 0) + (tr[i] === me ? 0 : tr[i] ? 30 : 2),
      safe: (x, y) => {
        const i = g.map.cellIndex(x, y);
        return !danger[i] && (tr[i] === me || !tr[i]);
      },
    };
    this.routing = { slot, opts };
    return opts;
  }

  update(dt) {
    this.border(); // Grenzlinie zu festem Zeitpunkt im Durchgang auffrischen (siehe border())
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH;
    this.pathBudget = PATH_BUDGET;
    for (const f of [...this.fronts]) this.refresh(f, !!f.force);
    this.repair();
    this.updateNeighbors();
  }

  // Überlappen sich Grenzabschnitte doch einmal (z. B. zwei Abschnitte, die sich keinen
  // Ankerpunkt teilen), teilen die betroffenen Divisionen ihren gemeinsamen Bereich neu auf
  repair() {
    if (!this.border().length) return;
    const segs = this.fronts.filter((f) => f.kind !== 'line').map((f) => ({ f, r: this.rangeOf(f) }));
    const bad = new Set();
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i].r, b = segs[j].r;
        const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
        if (hi > lo && this.lenBelow(hi) - this.lenBelow(lo) > MIN_SECTION) { bad.add(segs[i]); bad.add(segs[j]); }
      }
    }
    if (!bad.size) return;
    const list = [...bad];
    const { kmin, kmax } = this.borderSegs();
    const k0 = Math.min(...list.map((s) => s.r[0])), k1 = Math.max(...list.map((s) => s.r[1]));
    const divs = list.map((s) => s.f.division);
    const made = this.splitBorder(divs,
      [k0 <= kmin ? null : this.anchorAt(k0), k1 >= kmax ? null : this.anchorAt(k1)], divs);
    for (const f of made) f.rotate = list.find((s) => s.f.division === f.division).f.rotate;
  }

  refresh(f, force) {
    const g = this.game;
    f.force = false;
    if (f.division.dissolved) { this.remove(f); return; }
    this.sync(f);

    f.chains = this.chainsFor(f);
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
      if (f.rotate && !u.rotating && frac < limit && !u.target && this.pathBudget > 0 && !this.enemyNear(u, 160)) {
        const c = this.nearestCity(u);
        if (c) {
          this.pathBudget--;
          u.rotating = true;
          u.frontGoal = null;
          u.path = g.map.findPath(u.x, u.y, c.x, c.y, this.safeRouting()) || [];
          continue;
        }
      }
      if (u.rotating && (frac >= RETURN_AT || !f.rotate)) u.rotating = false;
      if (!u.rotating && !u.broken) active.push(u); // Zerschlagene kehren erst erholt zurück
    }

    // Divisionsabschnitte: jede Division bekommt einen zusammenhängenden Abschnitt der
    // Front, Länge nach ihrer Stärke. Kompanien bleiben in ihrem Abschnitt. Im Angriff
    // liegen die Plätze auf der Ziellinie, die Front selbst bleibt unverändert.
    let target = f.chains, targetLen = f.length;
    if (f.attack) {
      target = [withNormals(f.attack.line, (p, n) => this.facing(p, n))];
      targetLen = chainLength(target[0]);
    }
    const { slots, ordered } = this.sectionSlots(f, active, target, targetLen, !f.attack);
    if (!slots.length) return;
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
          if (this.pathBudget <= 0) { pending = true; continue; }
          this.pathBudget--;
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
        this.stopAttack(f, true);
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
      if (!this.game.hostile(o.owner, this.owner)) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < bd) { bd = d; e = o; }
    }
    if (!e) return false;
    const p = u.path[u.path.length - 1];
    return (p.x - u.x) * (e.x - u.x) + (p.y - u.y) * (e.y - u.y) < 0;
  }

  enemyNear(u, r) {
    for (const o of this.game.units) {
      if (this.game.hostile(o.owner, this.owner) && Math.abs(o.x - u.x) < r && Math.abs(o.y - u.y) < r && Math.hypot(o.x - u.x, o.y - u.y) < r) return true;
    }
    return false;
  }

  // Plätze auf einer Linie (chains, Länge total) verteilen, je Division ein zusammenhängender
  // Abschnitt. Nur auf der eigenen Frontlinie (own) werden Abschnitte und Anteile gemerkt;
  // ein Angriff verteilt auf der Ziellinie, ohne sie zu verändern.
  sectionSlots(f, active, chains = f.chains, total = f.length || 0, own = true) {
    if (!active.length || total < 1) return { slots: distribute(chains, active.length), ordered: active };
    // Lage jeder Kompanie auf der Linie: bevorzugt ihr bisheriger Platz (stabile Reihenfolge)
    const posOf = (u) => projectOnChains(chains, u.frontGoal && u.front === f ? u.frontGoal : u);
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
    if (own) f.shares = new Map(divs.map((d) => [d.div, d.strength]));
    const sum = divs.reduce((s, d) => s + d.strength, 0) || 1;
    const slots = [], ordered = [];
    const sections = [];
    let start = 0;
    for (const d of divs) {
      const len = total * d.strength / sum;
      const n = d.list.length;
      for (let k = 0; k < n; k++) {
        const pt = pointAt(chains, start + (k + 0.5) * len / n);
        if (!pt) continue;
        slots.push(pt);
        ordered.push(d.list[k].u);
      }
      sections.push({ div: d.div, from: start, to: start + len });
      start += len;
    }
    if (own) f.sections = sections;
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
      if (!g.hostile(c.owner, this.owner)) continue;
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
    const me = this.owner;
    const foe = (o) => g.hostile(me, o); // feindliche Seite
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
    let cells = collect((n) => foe(tr[n]));
    if (cells.length < 3) {
      // Noch kein Kontakt: Rand zum fremden Land, das mit dem Gegner verbunden ist und in seine Richtung zeigt
      const outside = new Uint8Array(w * h);
      const stack = [];
      for (let i = 0; i < w * h; i++) if (foe(tr[i])) { outside[i] = 1; stack.push(i); }
      for (const c of g.cities) {
        if (!foe(c.owner)) continue;
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
      const foeCities = g.cities.filter((c) => foe(c.owner));
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

// Teil der (aneinandergehängten) Teillinien zwischen den Bogenlängen t0 und t1
export function sliceChains(chains, t0, t1) {
  const out = [];
  let acc = 0;
  for (const c of chains) {
    const cur = [];
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      const s0 = acc, s1 = acc + seg;
      acc = s1;
      if (s1 < t0 || s0 > t1) continue;
      const at = (t) => {
        const k = seg ? (t - s0) / seg : 0;
        return { ...a, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      };
      if (!cur.length) cur.push(t0 > s0 ? at(t0) : a);
      cur.push(t1 < s1 ? at(t1) : b);
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

// Teile der Linien, deren Achsenwert key(p) zwischen k0 und k1 liegt
function sliceByKey(chains, key, k0, k1) {
  const out = [];
  for (const c of chains) {
    let cur = null;
    for (let i = 1; i < c.length; i++) {
      const q = c[i - 1], p = c[i];
      const kq = key(q), kp = key(p);
      if (Math.abs(kp - kq) > SEAM) { // über die Nahtstelle: Linie hier trennen
        if (cur && cur.length >= 2) out.push(cur);
        cur = null;
        continue;
      }
      let ts, te;
      if (kp === kq) {
        [ts, te] = kq < k0 || kq > k1 ? [1, 0] : [0, 1];
      } else {
        const ta = (k0 - kq) / (kp - kq), tb = (k1 - kq) / (kp - kq);
        ts = Math.max(0, Math.min(ta, tb));
        te = Math.min(1, Math.max(ta, tb));
      }
      if (te < ts) {
        if (cur && cur.length >= 2) out.push(cur);
        cur = null;
        continue;
      }
      const at = (t) => ({ ...q, x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t });
      const end = te === 1 ? p : at(te);
      if (cur && ts === 0) cur.push(end);
      else {
        if (cur && cur.length >= 2) out.push(cur);
        cur = [ts === 0 ? q : at(ts), end];
      }
      if (te < 1) {
        out.push(cur);
        cur = null;
      }
    }
    if (cur && cur.length >= 2) out.push(cur);
  }
  return out;
}

function distToChains(chains, p) {
  let best = Infinity;
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
    }
  }
  return best;
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
