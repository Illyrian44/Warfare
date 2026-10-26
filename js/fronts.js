import { TERRAIN_INFO, CELL, UNIT_TYPES } from './config.js?v=111';
import { DIVISION, ARMY, unitsOf, centerOf } from './orbat.js?v=111';

const REFRESH = 1.5;        // Sekunden zwischen Neuberechnungen
const HOLD_IN = 15;         // haltende Kompanien stehen so weit hinter der Grenze
const ROTATE_AT = 0.35;     // Verwundete ziehen sich darunter zurück
const ROTATE_AT_ATTACK = 0.2; // während eines Angriffs erst später
const RETURN_AT = 0.9;      // und kehren ab hier zurück
const CODENAMES = ['ADLER', 'FALKE', 'WOLF', 'LUCHS', 'BÄR', 'HABICHT', 'KRANICH', 'ELCH', 'DACHS', 'MARDER', 'BUSSARD', 'STIER'];
const PATH_BUDGET = 2;      // A*-Suchen je Durchgang, für alle Fronten einer Seite zusammen
const DANGER_RADIUS = 45;   // so viel Abstand halten Verschiebungen zu Feinden
const BRUSH = 4;            // Pinsel: Halbmesser in Feldern
const BAND = 3;             // Zuteilung per Klick: so viele Felder um jedes Grenzfeld
const INHERIT = 7;          // so weit (Felder) sucht ein neues Grenzfeld nach seiner Front
const GAP_FILL = 6;         // Lücken bis zu so vielen Feldern zwischen zwei Teilen schließen sich
const LINK = 2;             // Grenzfelder bis zu diesem Abstand (Felder) gehören zu einer Linie
const ATTACK_STALL = 90;    // Sekunden ohne Fortschritt, nach denen ein Angriff endet
const THREAT_R = 70;        // Feinde in diesem Umkreis machen ein Grenzfeld wichtiger
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Fronten wie in Hearts of Iron, ohne feste Provinzen:
// - Die Front ist die Grenze selbst: jedes eigene Feld mit feindlichem Nachbarn ist ein
//   Grenzfeld (ohne Kontakt: das Feld am Rand zum fremden Land in Richtung Feind).
// - Zuständigkeit (this.resp): je Feld der Auftrag (Armee oder Division), der dort die
//   Front hält; 0 = niemand, -1 = bewusst ohne Front. Der Spieler malt sie mit dem Pinsel
//   über die Grenze, klickt einen Gegner an (ganze Grenze zu ihm) oder nimmt die ganze
//   Grenze. Neue Grenzfelder (die Grenze hat sich bewegt) übernehmen die Zuständigkeit der
//   Felder in ihrer Nähe; sonst ändert sich nichts von selbst.
// - Verteilung: Die Grenzfelder eines Auftrags werden entlang der Grenze geordnet und
//   zusammenhängend nach Stärke auf seine Divisionen aufgeteilt, darin gleichmäßig auf die
//   Kompanien (Felder mit Feinden in der Nähe zählen mehr). Je Division eine Front
//   (this.fronts); Angriffe, Rotation und HQs arbeiten je Division.
export class FrontManager {
  constructor(game, owner) {
    this.game = game;
    this.owner = owner;
    this.fronts = [];
    this.holds = [];
    this.holdIds = new Map();
    const { w, h } = game.map;
    this.resp = new Int32Array(w * h);
    this.wasFront = new Uint8Array(w * h);
    this.version = 0;        // zählt jede Änderung an resp (für Zwischenspeicher)
    this.timer = REFRESH * ((owner - 1) % 4) / 4; // Seiten versetzt rechnen
    this.pathBudget = PATH_BUDGET;
    this.nextId = 1;
    this.events = [];
    this.codename = (owner - 1) * 5;
    // Löst sich eine Division auf, verschwinden ihre Front und ihr eigener Auftrag sofort
    game.orbat[owner].onDissolve.push((div) => {
      if (this.fronts.includes(div.front)) this.remove(div.front);
      const hd = this.holdOf(div);
      if (hd) this.dropHold(hd);
    });
    // Wegfindung hinter der eigenen Linie auch für Spiel und HQs (Festgefahrene, Rückzug)
    (game.routers || (game.routers = {}))[owner] = this;
  }

  // --- Aufträge ----------------------------------------------------------------------

  holdOf(formation) {
    return this.holds.find((h) => h.formation === formation) || null;
  }

  makeHold(formation) {
    let hd = this.holdOf(formation);
    if (!hd) {
      hd = { id: this.nextId++, formation, seeds: new Map(), rotate: true, fallback: null, falling: false };
      this.holds.push(hd);
      this.holdIds.set(hd.id, hd);
    }
    return hd;
  }

  // Auftrag aufheben: seine Felder sind danach bewusst ohne Front, die Divisionen bleiben
  dropHold(hd) {
    const r = this.resp;
    for (let i = 0; i < r.length; i++) if (r[i] === hd.id) r[i] = -1;
    this.version++;
    this.holds = this.holds.filter((h) => h !== hd);
    this.holdIds.delete(hd.id);
    for (const f of [...this.fronts]) if (f.hold === hd) this.remove(f);
  }

  holdAlive(hd) {
    const f = hd.formation;
    return f.level === ARMY ? this.game.orbat[this.owner].armies.includes(f) : !f.dissolved;
  }

  // Divisionen, die einen Auftrag ausführen (bei einer Armee ohne die mit eigenem Auftrag)
  members(hd) {
    const f = hd.formation;
    if (f.level === DIVISION) return f.dissolved ? [] : [f];
    return f.children.filter((d) => !d.dissolved && !this.holdOf(d));
  }

  // Divisionsfronten an Aufträge und Gliederung anpassen: jede Division eines Auftrags hat
  // genau eine Front, Divisionen ohne Auftrag keine
  syncHolds() {
    for (const hd of [...this.holds]) if (!this.holdAlive(hd)) this.dropHold(hd);
    const want = new Map(); // Division -> Auftrag
    for (const hd of this.holds) for (const d of this.members(hd)) want.set(d, hd);
    for (const f of [...this.fronts]) if (want.get(f.division) !== f.hold) this.remove(f);
    for (const [d, hd] of want) {
      if (this.fronts.includes(d.front) && d.front.hold === hd) continue;
      const f = { id: this.nextId++, owner: this.owner, division: d, hold: hd, kind: 'border', units: [], cells: [],
        points: [], slots: new Map(), rotate: hd.rotate, neighbors: [], attack: null, plan: null };
      d.front = f;
      this.fronts.push(f);
      this.sync(f);
      this.schedule(f);
    }
  }

  // Nach jeder Zuteilung: Aufträge ohne Grenzfeld lösen sich auf (außer beim Rückzug auf
  // die Auffanglinie), die geänderten verteilen ihre Divisionen neu nach deren Lage
  afterAssign(touched) {
    const used = new Set(this.frontInfo().list.map((e) => this.resp[e.i]));
    for (const hd of [...this.holds]) if (!hd.falling && !used.has(hd.id)) this.dropHold(hd);
    this.syncHolds();
    for (const hd of touched) {
      if (!this.holds.includes(hd)) continue;
      hd.seeds.clear();
      this.layoutHold(hd);
    }
  }

  // Felder um einen Weltpunkt (Halbmesser rad in Feldern) zuteilen; only: nur Felder, die
  // bisher diesen Wert haben
  paintDisc(v, x, y, rad, only) {
    const { w, h } = this.game.map, r = this.resp;
    const cx = x / CELL, cy = y / CELL;
    for (let yy = Math.max(0, Math.floor(cy - rad)); yy <= Math.min(h - 1, Math.floor(cy + rad)); yy++) {
      for (let xx = Math.max(0, Math.floor(cx - rad)); xx <= Math.min(w - 1, Math.floor(cx + rad)); xx++) {
        if ((xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2 > rad * rad) continue;
        const i = yy * w + xx;
        if (only === undefined || r[i] === only) r[i] = v;
      }
    }
  }

  // Pinselstrich von a nach b für einen Verband (null: Front entziehen). Liefert die
  // getroffenen Grenzfelder. quick: während des Ziehens nur malen, verteilt wird erst mit
  // commit() am Ende des Strichs
  paintStroke(formation, a, b, quick = false) {
    const fi = this.frontInfo();
    const v = formation ? this.makeHold(formation).id : -1;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2)));
    for (let k = 0; k <= n; k++) this.paintDisc(v, a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n, BRUSH);
    this.version++;
    const hit = fi.list.filter((e) => this.resp[e.i] === v && segDist(e.cx, e.cy, a, b) <= (BRUSH + 0.5) * CELL);
    if (!quick) this.commit(formation ? [formation] : []);
    return hit;
  }

  // Malen abschließen: Lücken der gemalten Fronten schließen, neu verteilen
  commit(forms) {
    const holds = forms.map((f) => this.holdOf(f)).filter(Boolean);
    for (const hd of holds) this.fillGaps(hd.id);
    this.afterAssign(holds);
  }

  // Grenzfelder einem Verband zuteilen (mit einem Streifen beiderseits der Grenze)
  assignEntries(v, entries) {
    for (const e of entries) this.paintDisc(v, e.cx, e.cy, BAND);
    this.version++;
  }

  // Mehrere Verbände teilen sich Grenzfelder: zusammenhängend entlang der Grenze, Anteil
  // nach Stärke, Reihenfolge nach ihrer Lage
  assignSplit(forms, entries) {
    if (!entries.length || !forms.length) return [];
    const holds = forms.map((f) => this.makeHold(f));
    const parts = splitAlong(entries, forms.map((f) => centerOf(f) || entries[0]), forms.map((f) => Math.max(0.1, formStrength(f))), () => 1);
    holds.forEach((hd, k) => this.assignEntries(hd.id, parts[k]));
    for (const hd of holds) this.fillGaps(hd.id);
    this.afterAssign(holds);
    return holds.filter((hd) => this.holds.includes(hd));
  }

  // Ganze Grenze für einen Verband
  assignAll(formation) {
    const list = this.frontInfo().list;
    if (!list.length) return null;
    return this.assignSplit([formation], list)[0] || null;
  }

  // Grenzfelder zu einem Gegner (Klick ins Feindgebiet wie in HOI4)
  foeEntries(foe) {
    return this.frontInfo().list.filter((e) => e.foe === foe);
  }

  // Kleine Lücken in der Front eines Auftrags schließen: freie Grenzfelder, die zwischen
  // zwei seiner Felder liegen (nicht weiter als GAP_FILL entfernt, auf verschiedenen Seiten)
  fillGaps(v) {
    const fi = this.frontInfo(), r = this.resp;
    const mine = fi.list.filter((e) => r[e.i] === v);
    let changed = false;
    for (const e of fi.list) {
      if (r[e.i] > 0 && this.holdIds.has(r[e.i])) continue;
      const near = mine.filter((o) => Math.abs(o.cx - e.cx) <= GAP_FILL * CELL && Math.abs(o.cy - e.cy) <= GAP_FILL * CELL);
      if (near.length < 2) continue;
      let both = false;
      for (let a = 0; a < near.length && !both; a++) {
        for (let b = a + 1; b < near.length; b++) {
          const ax = near[a].cx - e.cx, ay = near[a].cy - e.cy, bx = near[b].cx - e.cx, by = near[b].cy - e.cy;
          if (ax * bx + ay * by < 0) { both = true; break; } // auf verschiedenen Seiten
        }
      }
      if (!both) continue;
      this.paintDisc(v, e.cx, e.cy, 1, r[e.i]);
      r[e.i] = v;
      changed = true;
    }
    if (changed) this.version++;
  }

  // Divisionen, die einer Armee beitreten, bringen ihre Front mit: die Armee hält sie
  // danach gemeinsam, ihre Divisionen teilen sie neu auf
  mergeInto(army) {
    const own = army.children.map((d) => this.holdOf(d)).filter(Boolean);
    if (!own.length) return;
    const hd = this.makeHold(army);
    const ids = new Set(own.map((o) => o.id)), r = this.resp;
    for (let i = 0; i < r.length; i++) if (ids.has(r[i])) r[i] = hd.id;
    for (const o of own) { this.holds = this.holds.filter((x) => x !== o); this.holdIds.delete(o.id); }
    this.version++;
    this.afterAssign([hd]);
  }

  // --- Auffanglinie -------------------------------------------------------------------

  // Auffanglinie wie in HOI4: eine Linie hinter der Front, auf die sich der Auftrag auf Befehl
  // zurückzieht. Mehrere Aufträge teilen sich eine gezogene Linie nach Lage und Stärke
  setFallback(holds, line) {
    const total = chainLength(line);
    const order = holds.map((hd) => {
      const c = centerOf(hd.formation);
      return { hd, t: c ? projectOnChains([line], c) : 0, s: Math.max(0.1, formStrength(hd.formation)) };
    }).sort((a, b) => a.t - b.t);
    const sum = order.reduce((s, o) => s + o.s, 0);
    let acc = 0;
    for (const o of order) {
      const from = acc;
      acc += total * o.s / sum;
      const part = holds.length > 1 ? sliceChains([line], from, acc)[0] || line : line;
      o.hd.fallback = { line: part.map((q) => ({ x: q.x, y: q.y })) };
      if (o.hd.falling) this.refreshHold(o.hd);
    }
  }

  // Auf die Auffanglinie zurückfallen (on) bzw. wieder die Front halten. Laufende Angriffe
  // enden; die Zuständigkeit an der Grenze bleibt
  fallBack(hd, on) {
    hd.falling = on && !!hd.fallback;
    for (const f of this.fronts) if (f.hold === hd) { f.plan = null; this.stopAttack(f); }
    this.refreshHold(hd);
  }

  clearFallback(hd) {
    hd.fallback = null;
    if (hd.falling) this.fallBack(hd, false);
  }

  refreshHold(hd) {
    for (const f of this.fronts) if (f.hold === hd) { for (const u of f.units) u.frontGoal = null; this.schedule(f); }
    this.layoutHold(hd);
  }

  // --- Grenze ------------------------------------------------------------------------

  // Grenzfelder je festem Zeitfenster von 0,5 s einmal bestimmen; alle Fronten teilen sie
  // sich. Feste Fenster statt „0,5 s nach der letzten Abfrage“: so ändert eine zusätzliche
  // Abfrage (Anzeige, Test) nichts am Spielverlauf. Dabei übernehmen neue Grenzfelder ihre
  // Zuständigkeit (inherit)
  frontInfo() {
    const g = this.game, slot = Math.floor(g.time / 0.5);
    if (this.fi && this.fi.slot === slot) return this.fi;
    const map = g.map, { w } = map, tr = g.territory, me = this.owner;
    const { cells, isOut } = this.borderCells();
    const list = [], byCell = new Map();
    for (const i of cells) {
      const x = i % w, y = (i / w) | 0;
      let ox = 0, oy = 0, foe = 0;
      const dirs = [];
      for (const [dx, dy] of DIRS) {
        const j = i + dy * w + dx;
        if (!isOut(j)) continue;
        ox += dx; oy += dy;
        dirs.push([dx, dy]);
        if (tr[j] && tr[j] !== me && g.hostile(me, tr[j])) foe = tr[j];
      }
      if (!ox && !oy) { // Feind auf gegenüberliegenden Seiten: Richtung aus der Umgebung
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (isOut(i + dy * w + dx)) { ox += dx; oy += dy; }
        if (!ox && !oy) ox = 1;
      }
      const l = Math.hypot(ox, oy), nx = ox / l, ny = oy / l;
      const cx = (x + 0.5) * CELL, cy = (y + 0.5) * CELL;
      let px = cx - nx * HOLD_IN, py = cy - ny * HOLD_IN;
      const k = map.cellIndex(px, py);
      if (!map.cellPassable(k) || tr[k] !== me) { px = cx; py = cy; }
      const e = { i, gw: w, cx, cy, x: px, y: py, nx, ny, dirs, foe, w: 1 };
      list.push(e);
      byCell.set(i, e);
    }
    // Ohne Kontakt: der Gegner, dessen Stadt am nächsten liegt
    const foeCities = g.cities.filter((c) => c.owner && g.hostile(me, c.owner));
    for (const e of list) {
      if (e.foe || !foeCities.length) continue;
      let best = foeCities[0], bd = Infinity;
      for (const c of foeCities) { const d = (c.x - e.cx) ** 2 + (c.y - e.cy) ** 2; if (d < bd) { bd = d; best = c; } }
      e.foe = best.owner;
    }
    // Bedrohung: Feinde in der Nähe machen ein Grenzfeld wichtiger (mehr Kompanien dorthin)
    // (Feinde einmal auf ein grobes Raster eintragen statt je Grenzfeld zu suchen)
    if (list.length) {
      const B = 4 * CELL, bw = Math.ceil(map.worldW / B), bh = Math.ceil(map.worldH / B);
      const near = new Map();
      for (const o of g.units) {
        if (o.owner === me || !g.hostile(o.owner, me)) continue;
        const k = Math.floor(o.y / B) * bw + Math.floor(o.x / B);
        if (!near.has(k)) near.set(k, []);
        near.get(k).push(o);
      }
      const reach = Math.ceil(THREAT_R / B);
      for (const e of list) {
        const bx = Math.floor(e.cx / B), by = Math.floor(e.cy / B);
        search: for (let y = Math.max(0, by - reach); y <= Math.min(bh - 1, by + reach); y++) {
          for (let x = Math.max(0, bx - reach); x <= Math.min(bw - 1, bx + reach); x++) {
            const os = near.get(y * bw + x);
            if (os) for (const o of os) if ((o.x - e.cx) ** 2 + (o.y - e.cy) ** 2 <= THREAT_R * THREAT_R) { e.w = 3; break search; }
          }
        }
      }
    }
    this.fi = { slot, list, byCell, edges: null, order: null };
    this.inherit(list);
    this.wasFront.fill(0);
    for (const e of list) this.wasFront[e.i] = 1;
    return this.fi;
  }

  // Neue Grenzfelder übernehmen den Auftrag des nächsten zuständigen Felds in der Nähe
  // (bis INHERIT Felder). Bestehende freie Grenzfelder bleiben frei: nichts wächst von
  // selbst die Grenze entlang
  inherit(list) {
    if (!this.holds.length) return;
    const { w, h } = this.game.map, r = this.resp;
    const found = [];
    for (const e of list) {
      if (this.wasFront[e.i] || r[e.i] < 0 || (r[e.i] > 0 && this.holdIds.has(r[e.i]))) continue;
      const x0 = e.i % w, y0 = (e.i / w) | 0;
      let best = 0, bd = INHERIT * INHERIT + 1;
      for (let dy = -INHERIT; dy <= INHERIT; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -INHERIT; dx <= INHERIT; dx++) {
          const d = dx * dx + dy * dy, x = x0 + dx;
          if (d >= bd || x < 0 || x >= w) continue;
          const v = r[y * w + x];
          if (v > 0 && this.holdIds.has(v)) { bd = d; best = v; }
        }
      }
      found.push([e.i, best]);
    }
    let changed = false;
    for (const [i, v] of found) if (v) { r[i] = v; changed = true; }
    if (changed) this.version++;
  }

  // Grenzfeld nahe einem Punkt (bis rad Felder), sonst null
  entryAt(p, rad = BRUSH) {
    let best = null, bd = (rad * CELL) ** 2;
    for (const e of this.frontInfo().list) {
      const d = (e.cx - p.x) ** 2 + (e.cy - p.y) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  holdEntries(hd) {
    const r = this.resp;
    return this.frontInfo().list.filter((e) => r[e.i] === hd.id);
  }

  // Grenzfelder ohne besetzten Auftrag (Lücken)
  openEntries() {
    const r = this.resp;
    const manned = new Set(this.holds.filter((hd) => this.members(hd).length).map((hd) => hd.id));
    return this.frontInfo().list.filter((e) => !manned.has(r[e.i]));
  }

  // Lage eines Punkts entlang der Grenze (für Sortierungen, z. B. in der KI)
  along(p) {
    const fi = this.frontInfo();
    if (!fi.order) fi.order = orderAlong(fi.list);
    const e = nearestEntry(fi.list, p);
    return e ? fi.order.get(e) : 0;
  }

  // Besetzung eines Auftrags: Frontlänge, Divisionen, einsatzbereite Kompanien
  // level: 'good' (dicht), 'thin' (dünn), 'weak' (zu dünn), 'none' (keine Grenze)
  holdStatus(hd) {
    const cells = this.holdEntries(hd).length;
    const divs = this.members(hd);
    const units = divs.reduce((s, d) => s + unitsOf(d).filter((u) => !u.broken).length, 0);
    const per = cells ? units * 4 / cells : 0; // eine Kompanie je 4 Grenzfelder gilt als dicht
    const level = !cells ? 'none' : per >= 1 ? 'good' : per >= 0.5 ? 'thin' : 'weak';
    return { cells, km: Math.round(cells * (this.game.map.kmPerCell || 1)), divs: divs.length, units, level };
  }

  // Grenzlinien zum Zeichnen: die Kanten zwischen Grenzfeldern und Feindfeldern, zu Linien
  // verbunden und geglättet; key = Auftrag (0 = keine Front). Keine Lücken: jede Kante
  // gehört zu genau einer Linie. teeth: Stellen für die Zacken Richtung Feind
  edges() {
    const fi = this.frontInfo();
    if (fi.edges && fi.edgesVer === this.version) return fi.edges;
    const r = this.resp;
    const key = (e) => (r[e.i] > 0 && this.holdIds.has(r[e.i]) ? r[e.i] : 0);
    fi.edges = traceEdges(fi.list, this.game.map.w, key);
    fi.edgesVer = this.version;
    return fi.edges;
  }

  // Linien eines Abschnitts (einer Division), zum Hervorheben
  edgesOf(f) {
    const fi = this.frontInfo();
    if (f.edgeCache && f.edgeCache.slot === fi.slot && f.edgeCache.n === f.cells.length) return f.edgeCache.lines;
    const lines = traceEdges(f.cells, this.game.map.w, () => 1);
    f.edgeCache = { slot: fi.slot, n: f.cells.length, lines };
    return lines;
  }

  // Lage des Abzeichens eines Auftrags: das Grenzfeld nahe der Mitte seiner Felder
  holdBadge(hd) {
    const cells = this.holdEntries(hd);
    if (!cells.length) return null;
    return snapCenter(cells);
  }

  // Trenner: Stellen, an denen zwei Aufträge auf der Grenze aneinanderstoßen
  boundaries() {
    const fi = this.frontInfo();
    if (fi.bounds && fi.boundsVer === this.version) return fi.bounds;
    const { w } = this.game.map, r = this.resp;
    const list = [];
    for (const e of fi.list) {
      const a = r[e.i];
      if (!(a > 0) || !this.holdIds.has(a)) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = fi.byCell.get(e.i + dy * w + dx);
          if (!o) continue;
          const b = r[o.i];
          if (!(b > a) || !this.holdIds.has(b)) continue; // jedes Paar nur einmal (b > a)
          const x = (e.cx + o.cx) / 2, y = (e.cy + o.cy) / 2;
          if (list.some((q) => ((q.a.id === a && q.b.id === b) || (q.a.id === b && q.b.id === a)) && Math.hypot(q.x - x, q.y - y) < 5 * CELL)) continue;
          const A = this.holdIds.get(a), B = this.holdIds.get(b);
          if (A.falling || B.falling) continue;
          list.push({ a: A, b: B, x, y });
        }
      }
    }
    fi.bounds = list;
    fi.boundsVer = this.version;
    return list;
  }

  // Trenner zwischen den Aufträgen a und b (zuletzt bei near) zum Punkt p ziehen: die
  // Grenzfelder der anderen Seite zwischen Trenner und p wechseln. Liefert die neue Lage
  moveBoundary(a, b, near, p) {
    const fi = this.frontInfo(), r = this.resp, { w } = this.game.map;
    const c = nearestEntry(fi.list.filter((e) => r[e.i] === a.id || r[e.i] === b.id), p);
    if (!c || Math.hypot(c.cx - p.x, c.cy - p.y) > 6 * CELL) return near;
    const from = r[c.i] === b.id ? a : b, into = from === a ? b : a; // from wächst in into hinein
    // Breitensuche über die Grenzfelder von into, ab denen, die am Trenner an from grenzen
    const dist = new Map(), queue = [];
    for (const e of fi.list) {
      if (r[e.i] !== into.id || Math.hypot(e.cx - near.x, e.cy - near.y) > 4 * CELL) continue;
      dist.set(e, 0);
      queue.push(e);
    }
    for (let q = 0; q < queue.length; q++) {
      const e = queue[q];
      for (let dy = -LINK; dy <= LINK; dy++) {
        for (let dx = -LINK; dx <= LINK; dx++) {
          const o = fi.byCell.get(e.i + dy * w + dx);
          if (!o || dist.has(o) || r[o.i] !== into.id) continue;
          dist.set(o, dist.get(e) + 1);
          queue.push(o);
        }
      }
    }
    if (!dist.has(c)) return near;
    // into behält mindestens ein Feld
    const limit = dist.get(c);
    const take = [...dist.keys()].filter((e) => dist.get(e) <= limit);
    if (take.length >= this.holdEntries(into).length) return near;
    for (const e of take) this.paintDisc(from.id, e.cx, e.cy, BAND, into.id);
    this.version++;
    this.afterAssign([from, into]);
    return { x: c.cx, y: c.cy };
  }

  // --- Verteilung --------------------------------------------------------------------

  // Den Auftrag auf seine Divisionen verteilen und darin auf die Kompanien: zusammenhängend
  // entlang der Grenze, Divisionen nach Stärke, Kompanien gleichmäßig nach Gewicht der Felder.
  // Die Reihenfolge folgt der Lage (keine Kompanie läuft an einer anderen vorbei)
  layoutHold(hd) {
    hd.sig = this.members(hd).map((d) => d.id).join();
    const fronts = this.fronts.filter((f) => f.hold === hd);
    for (const f of fronts) { f.cells = []; f.points = []; f.slots = new Map(); f.neighbors = []; }
    if (!fronts.length) return;
    if (hd.falling && hd.fallback) { this.layoutLine(fronts, [withNormals(hd.fallback.line, (p, n) => this.facing(p, n))]); return; }
    const cells = this.holdEntries(hd);
    if (!cells.length) return;
    const order = orderAlong(cells);
    const seeds = fronts.map((f) => hd.seeds.get(f.division) || centerOf(f.division) || cells[0]);
    const parts = splitAlong(cells, seeds, fronts.map((f) => Math.max(0.1, divStrength(f.division))), (e) => e.w, order);
    fronts.forEach((f, k) => {
      f.cells = parts[k];
      f.points = parts[k];
      if (parts[k].length) hd.seeds.set(f.division, snapCenter(parts[k]));
      this.layoutUnits(f, order);
    });
    // Nachbarn: Divisionen, deren Abschnitte aneinanderstoßen (HQs helfen einander aus)
    for (const f of fronts) {
      f.neighbors = fronts.filter((o) => o !== f && touches(f.cells, o.cells));
    }
  }

  // Kompanien einer Division gleichmäßig auf ihre Grenzfelder
  layoutUnits(f, order) {
    const act = f.units.filter((u) => !u.rotating && !u.broken);
    if (!act.length || !f.cells.length) return;
    const parts = splitAlong(f.cells, act.map((u) => u.frontGoal || u), act.map(() => 1), (e) => e.w, order);
    act.forEach((u, k) => {
      const e = parts[k].length ? snapCenter(parts[k]) : nearestEntry(f.cells, u);
      f.slots.set(u, { x: e.x, y: e.y, nx: e.nx, ny: e.ny });
    });
  }

  // Auf einer Linie (Auffanglinie): Divisionen nach Lage und Stärke, Kompanien gleichmäßig
  layoutLine(fronts, chains) {
    const total = chains.reduce((s, c) => s + chainLength(c), 0);
    const order = this.byPosition(fronts.map((f) => f.division), (c) => projectOnChains(chains, c));
    const sum = order.reduce((s, o) => s + o.s, 0) || 1;
    let acc = 0;
    for (const o of order) {
      const f = o.d.front;
      const from = acc;
      acc += total * o.s / sum;
      const part = sliceChains(chains, from, acc);
      const act = f.units.filter((u) => !u.rotating && !u.broken)
        .sort((a, b) => projectOnChains(chains, a) - projectOnChains(chains, b));
      const slots = distribute(part.length ? part : chains, act.length);
      act.forEach((u, k) => f.slots.set(u, slots[k]));
      f.points = (part.length ? part : chains).flat();
    }
  }

  // --- Divisionsfronten ----------------------------------------------------------------

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
    this.syncHolds();
    for (const f of [...this.fronts]) {
      if (f.division.dissolved) this.remove(f);
      else if (this.sync(f)) this.schedule(f);
    }
    // neu verteilen nur, wo sich die Divisionen geändert haben (sonst im nächsten Durchgang)
    for (const hd of this.holds) {
      const sig = this.members(hd).map((d) => d.id).join();
      if (sig !== hd.sig) this.layoutHold(hd);
    }
  }

  // Angriff beenden (erreicht oder abgebrochen): zurück zum Halten des eigenen Abschnitts
  stopAttack(f) {
    if (!f.attack) return;
    f.attack = null;
    for (const u of f.units) u.frontGoal = null;
    this.schedule(f);
  }

  // Besetzung sofort, die Wege erst im nächsten Durchgang (verteilt die Rechenlast)
  prepare(f) {
    this.sync(f);
    this.schedule(f);
  }

  update(dt) {
    const fi = this.frontInfo(); // Grenze zu festem Zeitpunkt im Durchgang auffrischen
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH;
    this.pathBudget = PATH_BUDGET;
    this.syncHolds();
    for (const f of this.fronts) this.sync(f);
    // Neu verteilen höchstens einmal je Zeitfenster der Grenze
    for (const hd of this.holds) if (hd.layoutSlot !== fi.slot || hd.layoutVer !== this.version) {
      hd.layoutSlot = fi.slot;
      hd.layoutVer = this.version;
      this.layoutHold(hd);
    }
    for (const f of [...this.fronts]) this.refresh(f);
  }

  refresh(f) {
    const g = this.game;
    f.force = false;
    if (f.division.dissolved) { this.remove(f); return; }
    this.sync(f);

    // Rotation: Verwundete zur nächsten Stadt, geheilte zurück an die Front
    const active = [];
    for (const u of f.units) {
      const frac = u.hp / u.maxHp;
      const limit = f.attack ? ROTATE_AT_ATTACK : ROTATE_AT;
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

    // Plätze: beim Halten aus der Verteilung des Auftrags (layoutHold), im Angriff auf der
    // Ziellinie (die Front selbst bleibt unverändert)
    let pairs;
    if (f.attack) {
      if (!f.attack.parts.length) { this.stopAttack(f); this.events.push({ type: 'attackStalled', front: f }); return; }
      const target = f.attack.parts.map((c) => withNormals(c, (p, n) => this.facing(p, n)));
      const total = target.reduce((s, c) => s + chainLength(c), 0);
      const { slots, ordered } = this.sectionSlots(f, active, target, total);
      pairs = ordered.map((u, k) => [slots[k], u]);
    } else {
      pairs = active.map((u) => [f.slots.get(u), u]);
    }
    let pending = false;
    const shared = new Map(); // Wege für nebeneinander stehende Einheiten mit ähnlichem Ziel teilen
    for (const [s, u] of pairs) {
      if (!s) continue;
      const goalMoved = !u.frontGoal || Math.hypot(u.frontGoal.x - s.x, u.frontGoal.y - s.y) > 20;
      if (!goalMoved && u.path.length) continue; // schon unterwegs: Budget den Wartenden lassen
      if (!goalMoved && Math.hypot(u.x - s.x, u.y - s.y) < 10) continue;
      if (u.target) continue; // im Gefecht die Stellung halten, keine neuen Marschbefehle
      if (u.swapUntil > g.time) continue; // Platztausch innerhalb der Division läuft
      if (u.hqOrder > g.time) continue;   // Befehl des Divisions-HQ hat Vorrang
      // Feindkontakt: Stellung halten wie in HOI4. Seitliche Verschiebung im eigenen
      // Abschnitt ist erlaubt (hinter der Linie), nur ein Rückzug weg vom Feind nicht
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
        this.stopAttack(f);
        this.events.push({ type: 'attackDone', front: f });
      } else if (arrived > f.attack.best) {
        f.attack.best = arrived;
        f.attack.gained = g.time;
      } else if (g.time - f.attack.gained > ATTACK_STALL) {
        // Kein Fortschritt mehr (Ziel unerreichbar, Gegner zu stark): zurück in den Abschnitt
        this.stopAttack(f);
        this.events.push({ type: 'attackStalled', front: f });
      }
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

  // Divisionen nach ihrer Lage (pos des Schwerpunkts) ordnen, mit ihrer Stärke
  byPosition(divs, pos) {
    return divs.map((d) => {
      const c = centerOf(d);
      return { d, t: c ? pos(c) : 0, s: divStrength(d) };
    }).sort((a, b) => a.t - b.t);
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
    // Plätze nur auf begehbarem Gelände: Stücke der Ziellinie über Meer oder Gebirge fallen weg
    const parts = passableParts(f.plan.line, this.game.map);
    f.attack = { line: f.plan.line, name: f.plan.name, started: this.game.time, parts, best: 0, gained: this.game.time };
    f.plan = null;
    for (const u of f.units) u.frontGoal = null;
    this.prepare(f);
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

  // Plätze auf der Ziellinie eines Angriffs gleichmäßig verteilen, Kompanien nach ihrer Lage
  sectionSlots(f, active, chains) {
    const ordered = [...active].sort((a, b) => projectOnChains(chains, a) - projectOnChains(chains, b));
    return { slots: distribute(chains, ordered.length), ordered };
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

  // Grenzfelder zum Gegner (ohne Kontakt: Rand zu fremdem Land, das in seine Richtung zeigt);
  // isOut(j): liegt das Nachbarfeld j auf der Feindseite?
  borderCells() {
    const g = this.game;
    const map = g.map;
    const { w, h } = map;
    const tr = g.territory;
    const me = this.owner;
    // feindliche Seite als Tabelle je Besitzer (die Abfrage läuft über die ganze Karte)
    const hostileTo = new Uint8Array(256);
    for (const o of g.players) if (o !== me && g.hostile(me, o)) hostileTo[o] = 1;
    const foe = (o) => hostileTo[o] === 1;
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
    let cells = collect((n) => hostileTo[tr[n]] === 1);
    let isOut = (n) => hostileTo[tr[n]] === 1;
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
      isOut = (n) => outside[n] === 1;
      const frontier = collect(isOut);
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
    return { cells, isOut };
  }

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

// Stelle für das Abzeichen einer Divisionsfront: ihr Grenzfeld nahe der Mitte
export function frontBadge(f) {
  return f.points && f.points.length ? snapCenter(f.points) : null;
}

// Begehbare Stücke einer Linie (im Abstand von etwa einem halben Feld geprüft)
function passableParts(line, map) {
  const out = [];
  let cur = null;
  for (let i = 0; i < line.length; i++) {
    const a = i ? line[i - 1] : line[0], b = line[i];
    const n = i ? Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2))) : 1;
    for (let k = i ? 1 : 0; k <= n; k++) {
      const p = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n };
      if (map.passableAt(p.x, p.y)) (cur || (cur = [])).push(p);
      else if (cur) { if (cur.length >= 2) out.push(cur); cur = null; }
    }
  }
  if (cur && cur.length >= 2) out.push(cur);
  return out.filter((c) => chainLength(c) >= CELL);
}

// Kampfwert einer Kompanie zum Aufteilen von Fronten (Typ und Lebenspunkte)
function compStrength(u) {
  return UNIT_TYPES[u.type].strength * (0.4 + 0.6 * u.hp / u.maxHp);
}

function divStrength(d) {
  return unitsOf(d).reduce((s, u) => s + compStrength(u), 0);
}

// Armee oder Division
function formStrength(f) {
  return unitsOf(f).reduce((s, u) => s + compStrength(u), 0);
}

// --- Grenzfelder: Ordnung, Aufteilung, Linien ----------------------------------------

// Abstand eines Punkts zur Strecke a–b
function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - a.x - dx * t, py - a.y - dy * t);
}

function nearestEntry(list, p) {
  let best = null, bd = Infinity;
  for (const e of list) {
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// Grenzfeld nahe dem Schwerpunkt einer Menge von Grenzfeldern
function snapCenter(list) {
  let x = 0, y = 0;
  for (const e of list) { x += e.x; y += e.y; }
  return nearestEntry(list, { x: x / list.length, y: y / list.length });
}

// Berühren sich zwei Mengen von Grenzfeldern (Abstand bis LINK Felder)?
function touches(A, B) {
  if (!A.length || !B.length) return false;
  const set = new Set(B.map((e) => e.i)), w = A[0].gw;
  for (const e of A) {
    for (let dy = -LINK; dy <= LINK; dy++) for (let dx = -LINK; dx <= LINK; dx++) if (set.has(e.i + dy * w + dx)) return true;
  }
  return false;
}

// Lage jedes Grenzfelds entlang der Grenze: Weglänge über benachbarte Grenzfelder (Lücken
// bis LINK Felder überbrückt) von einem Ende aus. Getrennte Stücke (z. B. durch Gebirge)
// werden hintereinander gehängt. Robust auch bei Verzweigungen: Felder einer Abzweigung
// bekommen ähnliche Werte wie die Stelle, an der sie abzweigt
function orderAlong(list) {
  const out = new Map();
  if (!list.length) return out;
  const w = list[0].gw;
  const byCell = new Map(list.map((e) => [e.i, e]));
  const near = (e) => {
    const res = [];
    for (let dy = -LINK; dy <= LINK; dy++) {
      for (let dx = -LINK; dx <= LINK; dx++) {
        if (!dx && !dy) continue;
        const o = byCell.get(e.i + dy * w + dx);
        if (o) res.push([o, Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? (dx && dy ? 1.4 : 1) : 2.2]);
      }
    }
    return res;
  };
  // Kürzeste Wege (Dijkstra mit kleinem Heap) innerhalb eines Stücks
  const dijkstra = (start, comp) => {
    const dist = new Map([[start, 0]]);
    const heap = new Heap();
    heap.push(0, start);
    while (heap.size) {
      const [d, e] = heap.pop();
      if (d > dist.get(e)) continue;
      for (const [o, c] of near(e)) {
        if (comp && !comp.has(o)) continue;
        const nd = d + c;
        if (nd < (dist.has(o) ? dist.get(o) : Infinity)) { dist.set(o, nd); heap.push(nd, o); }
      }
    }
    return dist;
  };
  const farthest = (dist) => {
    let best = null, bd = -1;
    for (const [e, d] of dist) if (d > bd || (d === bd && e.i < best.i)) { bd = d; best = e; }
    return best;
  };
  const key = (e) => e.cx * 0.3 + e.cy; // feste Richtung: das „obere“ Ende zuerst
  const seen = new Set(), comps = [];
  for (const e of list) {
    if (seen.has(e)) continue;
    const all = dijkstra(e);
    for (const o of all.keys()) seen.add(o);
    const comp = new Set(all.keys());
    const a = farthest(all);
    const fromA = dijkstra(a, comp);
    const b = farthest(fromA);
    comps.push(key(a) <= key(b) ? { start: a, dist: fromA } : { start: b, dist: dijkstra(b, comp) });
  }
  comps.sort((p, q) => key(p.start) - key(q.start));
  let offset = 0;
  for (const c of comps) {
    let max = 0;
    for (const [e, d] of c.dist) { out.set(e, offset + d); max = Math.max(max, d); }
    offset += max + 10;
  }
  return out;
}

// Grenzfelder zusammenhängend entlang der Grenze auf mehrere Empfänger aufteilen
// (Divisionen oder Kompanien): Anteil nach caps, Gewicht je Feld wf, Reihenfolge der
// Empfänger nach der Lage ihres seed (so läuft keiner am anderen vorbei)
// order: Lage aus orderAlong (für Teilmengen die der ganzen Front weiterverwenden)
function splitAlong(list, seeds, caps, wf, order = orderAlong(list)) {
  const parts = seeds.map(() => []);
  if (!list.length || !seeds.length) return parts;
  const sorted = [...list].sort((a, b) => order.get(a) - order.get(b) || a.i - b.i);
  const rank = seeds.map((s, k) => ({ k, t: order.get(nearestEntry(list, s)) + k * 1e-6 })).sort((a, b) => a.t - b.t);
  const total = sorted.reduce((s, e) => s + wf(e), 0);
  const capSum = caps.reduce((s, c) => s + c, 0) || 1;
  let acc = 0, cum = 0, idx = 0;
  rank.forEach(({ k }, n) => {
    acc += total * caps[k] / capSum;
    const last = n === rank.length - 1;
    while (idx < sorted.length && (last || cum + wf(sorted[idx]) / 2 <= acc + 1e-9)) {
      cum += wf(sorted[idx]);
      parts[k].push(sorted[idx++]);
    }
  });
  return parts;
}

// Kanten zwischen Grenzfeldern und Feindfeldern zu Linien verbinden (je key eigene Linien),
// geglättet; die Kanten laufen so, dass das eigene Feld rechts liegt, aufeinanderfolgende
// Kanten hängen also Kopf an Fuß. teeth: Stellen und Richtung der Zacken zum Feind
function traceEdges(list, w, keyOf) {
  const segs = [];
  for (const e of list) {
    const x = e.i % w, y = (e.i / w) | 0, key = keyOf(e);
    for (const [dx, dy] of e.dirs) {
      let a, b;
      if (dx === 1) { a = [x + 1, y]; b = [x + 1, y + 1]; }
      else if (dx === -1) { a = [x, y + 1]; b = [x, y]; }
      else if (dy === 1) { a = [x + 1, y + 1]; b = [x, y + 1]; }
      else { a = [x, y]; b = [x + 1, y]; }
      segs.push({ a, b, key, nx: dx, ny: dy, used: false });
    }
  }
  const from = new Map(), to = new Map();
  const vk = (p) => p[0] * 100000 + p[1];
  segs.forEach((s, k) => {
    if (!from.has(vk(s.a))) from.set(vk(s.a), []);
    from.get(vk(s.a)).push(k);
    if (!to.has(vk(s.b))) to.set(vk(s.b), []);
    to.get(vk(s.b)).push(k);
  });
  const next = (s, map, end) => {
    for (const k of map.get(vk(end)) || []) if (!segs[k].used && segs[k].key === s.key) return segs[k];
    return null;
  };
  const lines = [];
  for (const s0 of segs) {
    if (s0.used) continue;
    s0.used = true;
    const chain = [s0];
    for (let s = next(s0, from, s0.b); s; s = next(s, from, s.b)) { s.used = true; chain.push(s); }
    for (let s = next(s0, to, s0.a); s; s = next(s, to, s.a)) { s.used = true; chain.unshift(s); }
    const pts = [chain[0].a, ...chain.map((s) => s.b)].map((p) => ({ x: p[0] * CELL, y: p[1] * CELL }));
    const teeth = [];
    chain.forEach((s, k) => {
      if (k % 3 !== 1) return;
      teeth.push({ x: (s.a[0] + s.b[0]) / 2 * CELL, y: (s.a[1] + s.b[1]) / 2 * CELL, nx: s.nx, ny: s.ny });
    });
    lines.push({ key: s0.key, pts: chaikin(chaikin(pts)), teeth });
  }
  return lines;
}

// Ecken abrunden (Enden bleiben fest, damit benachbarte Linien aneinanderstoßen)
function chaikin(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Kleiner Binär-Heap (Vorrang: kleinster Schlüssel)
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

