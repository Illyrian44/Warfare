import { TERRAIN_INFO, CELL, UNIT_TYPES } from './config.js?v=100';
import { DIVISION, ARMY, formationOf, unitsOf, centerOf } from './orbat.js?v=100';

const REFRESH = 1.5;        // Sekunden zwischen Neuberechnungen
const HOLD_OFFSET = 20;     // Grenzfront: so weit hinter der Grenze stehen
const ROTATE_AT = 0.35;     // Verwundete ziehen sich darunter zurück
const ROTATE_AT_ATTACK = 0.2; // während eines Angriffs erst später
const RETURN_AT = 0.9;      // und kehren ab hier zurück
const CODENAMES = ['ADLER', 'FALKE', 'WOLF', 'LUCHS', 'BÄR', 'HABICHT', 'KRANICH', 'ELCH', 'DACHS', 'MARDER', 'BUSSARD', 'STIER'];
const PATH_BUDGET = 2;      // A*-Suchen je Durchgang, für alle Fronten einer Seite zusammen
const DANGER_RADIUS = 45;   // so viel Abstand halten Verschiebungen zu Feinden
const NEIGHBOR_DIST = 70;   // Fronten, deren Enden so nah beieinander liegen, sind Nachbarn
const INHERIT_HOPS = 3;     // so weit (in Regionen) sucht ein neuer Grenzsektor nach einer Front
const PICK_DIST = 30;       // so nah an der Grenze trifft ein Pinselstrich noch einen Sektor

// Fronten wie in Hearts of Iron, in zwei Stufen:
// 1. Aufträge (this.holds): Eine Armee oder eine einzelne Division hält Frontsektoren
//    (feste Regionen an der Grenze, siehe js/sectors.js) oder eine frei gezeichnete Linie.
//    Jeder Sektor gehört höchstens einem Auftrag (this.assign); Überlappen ist unmöglich.
// 2. Divisionsfronten (this.fronts): Jede Division eines Auftrags bekommt davon einen
//    zusammenhängenden Teil nach ihrer Stärke (hold.parts). Ihre Kompanien verteilen sich
//    darauf und halten ihn selbstständig; Angriffe, Rotation und HQs arbeiten je Division.
// Eine Division mit eigenem Auftrag gehört nicht zum Auftrag ihrer Armee. Rückt die Grenze
// vor, übernehmen neue Grenzsektoren den Auftrag ihres nächsten Nachbarsektors; sonst
// ändern sich Aufträge nur durch den Spieler bzw. die KI.
export class FrontManager {
  constructor(game, owner) {
    this.game = game;
    this.owner = owner;
    this.fronts = [];
    this.holds = [];
    this.assign = new Map(); // Region -> Auftrag (null: bewusst ohne Front)
    this.version = 0;        // zählt jede Änderung an assign (für Zwischenspeicher)
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

  // Auftrag eines Verbands anlegen; wechselt die Art (Sektoren bzw. freie Linie), beginnt
  // er neu
  makeHold(formation, kind, line = null) {
    let hd = this.holdOf(formation);
    if (hd && hd.kind !== kind) { this.dropHold(hd); hd = null; }
    if (!hd) {
      hd = { id: this.nextId++, formation, kind, line: null, parts: new Map(), sig: null, rotate: true, chains: [], length: 0, slot: -1, ver: -1 };
      this.holds.push(hd);
    }
    hd.line = line;
    hd.ver = -1;
    return hd;
  }

  // Auftrag aufheben: seine Sektoren sind danach ohne Front, die Divisionen bleiben bestehen
  dropHold(hd) {
    for (const [r, h] of this.assign) if (h === hd) this.assign.set(r, null);
    this.version++;
    this.holds = this.holds.filter((h) => h !== hd);
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
    for (const hd of this.holds) {
      const divs = this.members(hd);
      const sig = divs.map((d) => d.id).join(',');
      if (sig !== hd.sig) { hd.sig = sig; this.layout(hd); }
      for (const d of divs) want.set(d, hd);
    }
    for (const f of [...this.fronts]) if (want.get(f.division) !== f.hold) this.remove(f);
    for (const [d, hd] of want) {
      if (this.fronts.includes(d.front) && d.front.hold === hd) continue;
      const f = { id: this.nextId++, owner: this.owner, division: d, hold: hd, kind: hd.kind, units: [], chains: [],
        length: 0, rotate: hd.rotate, neighbors: [], attack: null, plan: null };
      d.front = f;
      this.fronts.push(f);
      this.prepare(f);
    }
  }

  // Den Auftrag auf seine Divisionen verteilen: zusammenhängende Teile, Länge nach Stärke.
  // Bekannte Divisionen behalten ihre Reihenfolge, neue reihen sich nach ihrer Lage ein;
  // reset ordnet alle nach ihrer Lage (nach einer neuen Zuteilung)
  layout(hd, reset = false) {
    const divs = this.members(hd);
    const chains = this.holdChains(hd);
    const L = hd.length;
    const old = reset ? new Map() : hd.parts;
    const order = divs.map((d) => {
      const p = old.get(d);
      const c = centerOf(d);
      const t = p ? (p[0] + p[1]) / 2 : c && L > 0 ? projectOnChains(chains, c) / L : 0.5;
      return { d, t, s: Math.max(0.1, divStrength(d)) };
    }).sort((a, b) => a.t - b.t);
    const sum = order.reduce((s, o) => s + o.s, 0) || 1;
    hd.parts = new Map();
    let acc = 0;
    for (const o of order) {
      const a = acc;
      acc += o.s / sum;
      hd.parts.set(o.d, [a, Math.min(1, acc)]);
    }
    hd.sig = divs.map((d) => d.id).join(',');
    for (const f of this.fronts) if (f.hold === hd) this.prepare(f);
  }

  // Nach jeder Zuteilung: Aufträge ohne Frontsektor lösen sich auf, die geänderten werden
  // neu auf ihre Divisionen verteilt
  afterAssign(touched) {
    const used = new Set([...this.sectorInfo().regions.keys()].map((r) => this.assign.get(r)));
    for (const hd of [...this.holds]) if (hd.kind === 'sectors' && !used.has(hd)) this.dropHold(hd);
    this.syncHolds();
    for (const hd of touched) if (this.holds.includes(hd)) this.layout(hd, true);
    this.updateNeighbors();
  }

  // Sektoren einem Verband (Armee oder Division) zuteilen
  paint(formation, regions) {
    const hd = this.makeHold(formation, 'sectors');
    for (const r of regions) this.assign.set(r, hd);
    this.version++;
    this.afterAssign([hd]);
    return this.holds.includes(hd) ? hd : null;
  }

  // Sektoren die Front entziehen
  erase(regions) {
    for (const r of regions) if (this.assign.get(r)) this.assign.set(r, null);
    this.version++;
    this.afterAssign([]);
  }

  // Mehrere Verbände teilen sich Sektoren: zusammenhängend entlang der Grenze, Anteil nach
  // Stärke, Reihenfolge nach ihrer Lage
  paintSplit(forms, regions) {
    if (forms.length === 1) return [this.paint(forms[0], regions)].filter(Boolean);
    const S = this.game.sectors;
    const pos = this.regionOrder();
    const list = [...new Set(regions)].filter((r) => pos.has(r)).sort((a, b) => pos.get(a) - pos.get(b));
    if (!list.length) return [];
    const near = (c) => {
      let best = 0, bd = Infinity;
      list.forEach((r, k) => { const d = Math.hypot(S.regions[r].x - c.x, S.regions[r].y - c.y); if (d < bd) { bd = d; best = k; } });
      return best;
    };
    const order = forms.map((f) => ({ f, k: centerOf(f) ? near(centerOf(f)) : 0, s: Math.max(0.1, formStrength(f)) }))
      .sort((a, b) => a.k - b.k);
    const sum = order.reduce((s, o) => s + o.s, 0);
    let acc = 0, from = 0;
    const made = [];
    order.forEach((o, i) => {
      acc += o.s / sum;
      // jeder bekommt mindestens einen Sektor, solange es reicht
      let to = i === order.length - 1 ? list.length : Math.round(acc * list.length);
      to = Math.max(Math.min(from + 1, list.length), Math.min(to, list.length - (order.length - 1 - i)));
      const part = list.slice(from, to);
      from = to;
      if (part.length) {
        const hd = this.makeHold(o.f, 'sectors');
        for (const r of part) this.assign.set(r, hd);
        made.push(hd);
      }
    });
    this.version++;
    this.afterAssign(made);
    return made.filter((hd) => this.holds.includes(hd));
  }

  // Alle Sektoren an der Grenze zu einem Gegner (Klick ins Feindgebiet wie in HOI4)
  foeSectors(foe) {
    return [...this.sectorInfo().regions.values()].filter((e) => e.foes.has(foe)).map((e) => e.r);
  }

  // Ganze Grenze für einen Verband
  assignAll(formation) {
    const regions = [...this.sectorInfo().regions.keys()];
    return regions.length ? this.paint(formation, regions) : null;
  }

  // Frei gezeichnete Linie (z. B. Verteidigungslinie im Hinterland); mehrere Verbände
  // teilen sie sich nach Lage und Stärke
  drawLine(forms, line) {
    const total = chainLength(line);
    const order = forms.map((f) => {
      const c = centerOf(f);
      return { f, t: c ? projectOnChains([line], c) : 0, s: Math.max(0.1, formStrength(f)) };
    }).sort((a, b) => a.t - b.t);
    const sum = order.reduce((s, o) => s + o.s, 0);
    let acc = 0;
    const made = order.map((o) => {
      const from = acc;
      acc += total * o.s / sum;
      const part = forms.length > 1 ? sliceChains([line], from, acc)[0] || line : line;
      return this.makeHold(o.f, 'line', part.map((q) => ({ x: q.x, y: q.y })));
    });
    this.version++;
    this.afterAssign(made);
    return made;
  }

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
  // enden; die Sektoren bleiben dem Auftrag zugeteilt
  fallBack(hd, on) {
    hd.falling = on && !!hd.fallback;
    for (const f of this.fronts) if (f.hold === hd) { f.plan = null; this.stopAttack(f); }
    this.refreshHold(hd);
  }

  clearFallback(hd) {
    hd.fallback = null;
    if (hd.falling) this.fallBack(hd, false);
  }

  // Linie eines Auftrags neu bestimmen und seine Divisionen neu ausrichten
  refreshHold(hd) {
    hd.ver = -1;
    for (const f of this.fronts) if (f.hold === hd) { for (const u of f.units) u.frontGoal = null; this.prepare(f); }
    this.updateNeighbors();
  }

  // Divisionen, die einer Armee beitreten, bringen ihre Sektoren mit: die Armee hält sie
  // danach gemeinsam, ihre Divisionen teilen sie neu auf
  mergeInto(army) {
    const own = army.children.map((d) => this.holdOf(d)).filter((hd) => hd && hd.kind === 'sectors');
    if (!own.length) return;
    const hd = this.makeHold(army, 'sectors');
    for (const o of own) {
      for (const [r, h] of this.assign) if (h === o) this.assign.set(r, hd);
      this.dropHold(o);
    }
    this.version++;
    this.afterAssign([hd]);
  }

  // --- Grenze und Sektoren -----------------------------------------------------------

  // Grenzlinien je festem Zeitfenster von 0,5 s einmal berechnen; alle Fronten teilen sie
  // sich. Feste Fenster statt „0,5 s nach der letzten Abfrage“: so ändert eine zusätzliche
  // Abfrage (Anzeige, Test) nichts am Spielverlauf. Dabei übernehmen neue Grenzsektoren
  // ihren Auftrag (siehe computeSectors)
  border() {
    const slot = Math.floor(this.game.time / 0.5);
    if (!this.borderCache || this.borderCache.slot !== slot) {
      const cells = this.borderCells();
      this.borderCache = { slot, chains: this.borderChains(cells), info: null };
      this.borderCache.info = this.computeSectors(cells);
    }
    return this.borderCache.chains;
  }

  // Frontsektoren dieser Seite: Region -> { r, foes (angrenzende Gegner), n (Grenzfelder) }
  sectorInfo() {
    this.border();
    return this.borderCache.info;
  }

  computeSectors(cells) {
    const g = this.game, S = g.sectors, tr = g.territory, w = g.map.w, me = this.owner;
    const regions = new Map();
    for (const i of cells) {
      const r = S.of[i];
      if (r < 0) continue;
      let e = regions.get(r);
      if (!e) { e = { r, foes: new Set(), n: 0 }; regions.set(r, e); }
      e.n++;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        const o = tr[j];
        if (o && o !== me && g.hostile(me, o)) e.foes.add(o);
      }
    }
    // Noch ohne Kontakt: der Gegner, dessen Stadt am nächsten liegt
    const foeCities = g.cities.filter((c) => c.owner && g.hostile(me, c.owner));
    for (const e of regions.values()) {
      if (e.foes.size || !foeCities.length) continue;
      const reg = S.regions[e.r];
      let best = foeCities[0], bd = Infinity;
      for (const c of foeCities) { const d = Math.hypot(c.x - reg.x, c.y - reg.y); if (d < bd) { bd = d; best = c; } }
      e.foes.add(best.owner);
    }
    // Neue Grenzsektoren übernehmen den Auftrag ihres nächsten Nachbarn
    let changed = false;
    for (const e of regions.values()) {
      if (this.assign.has(e.r)) continue;
      const v = this.inherit(e.r);
      if (v !== undefined) { this.assign.set(e.r, v); changed = true; }
    }
    if (changed) this.version++;
    return { regions };
  }

  // Auftrag der nächsten Region mit Auftrag (Breitensuche über Nachbarregionen), undefined,
  // wenn es in der Nähe keine gibt. Bewusst freie Sektoren geben ihre Lücke nicht weiter
  inherit(r) {
    const R = this.game.sectors.regions;
    const seen = new Set([r]);
    let level = [r];
    for (let hop = 0; hop < INHERIT_HOPS && level.length; hop++) {
      const next = [];
      let best, bd = Infinity;
      for (const q of level) {
        for (const n of R[q].nb) {
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
          if (!this.assign.get(n)) continue;
          const d = Math.hypot(R[n].x - R[r].x, R[n].y - R[r].y);
          if (d < bd) { bd = d; best = this.assign.get(n); }
        }
      }
      if (bd < Infinity) return best;
      level = next;
    }
    return undefined;
  }

  // Frontsektor unter einem Punkt (auch knapp neben der Grenze), sonst -1
  sectorAt(p) {
    const g = this.game, info = this.sectorInfo();
    const r = g.sectors.of[g.map.cellIndex(p.x, p.y)];
    if (r >= 0 && info.regions.has(r)) return r;
    let best = -1, bd = PICK_DIST;
    for (const c of this.border()) {
      for (const q of c) {
        const d = Math.hypot(q.bx - p.x, q.by - p.y);
        if (d < bd) { bd = d; best = q.r; }
      }
    }
    return best;
  }

  // Reihenfolge der Frontsektoren entlang der Grenze (Region -> Rang)
  regionOrder() {
    const pos = new Map();
    for (const c of this.border()) for (const p of c) if (!pos.has(p.r)) pos.set(p.r, pos.size);
    return pos;
  }

  // Teilstücke der Grenzlinie, deren Sektor test(region) erfüllt. An Wechseln zwischen zwei
  // Sektoren treffen sich die Stücke in der Mitte: keine Lücke, keine Überlappung
  runs(test) {
    const out = [];
    for (const c of this.border()) {
      let cur = null;
      for (let k = 0; k < c.length; k++) {
        const p = c[k];
        if (test(p.r)) {
          if (!cur) cur = k > 0 ? [midPoint(c[k - 1], p)] : [];
          cur.push(p);
        } else if (cur) {
          cur.push(midPoint(c[k - 1], p));
          if (cur.length >= 2) out.push(cur);
          cur = null;
        }
      }
      if (cur && cur.length >= 2) out.push(cur);
    }
    return out;
  }

  // Linie eines Auftrags (je Zeitfenster und Zuteilung einmal berechnet)
  holdChains(hd) {
    this.border();
    const slot = this.borderCache.slot;
    if (hd.slot === slot && hd.ver === this.version) return hd.chains;
    const facing = (p, n) => this.facing(p, n);
    hd.chains = hd.falling && hd.fallback ? [withNormals(hd.fallback.line, facing)]
      : hd.kind === 'line' ? (hd.line ? [withNormals(hd.line, facing)] : [])
        : this.runs((r) => this.assign.get(r) === hd);
    hd.length = hd.chains.reduce((s, c) => s + chainLength(c), 0);
    hd.slot = slot;
    hd.ver = this.version;
    return hd.chains;
  }

  // Teil des Auftrags, den eine Division hält
  chainsFor(f) {
    const hd = f.hold;
    const chains = this.holdChains(hd);
    const part = hd.parts.get(f.division);
    if (!part || (part[0] <= 0 && part[1] >= 1)) return chains;
    return sliceChains(chains, part[0] * hd.length, part[1] * hd.length);
  }

  // Grenzstücke ohne besetzten Auftrag (zum Anzeigen; die KI füllt sie auf)
  uncovered() {
    this.border();
    const slot = this.borderCache.slot;
    const manned = new Set(this.holds.filter((hd) => this.members(hd).length));
    const sig = [...manned].map((hd) => hd.id).join();
    const c = this.gapCache;
    if (c && c.slot === slot && c.ver === this.version && c.sig === sig) return c.parts;
    const parts = this.runs((r) => !manned.has(this.assign.get(r)));
    this.gapCache = { slot, ver: this.version, sig, parts };
    return parts;
  }

  // Abfolge der Sektoren je Grenzlinie (gleiche hintereinander zusammengefasst), mit dem
  // Punkt, an dem der Sektor beginnt (Mitte zum Vorgänger)
  sequences() {
    return this.border().map((c) => {
      const seq = [];
      for (let k = 0; k < c.length; k++) {
        const p = c[k];
        const last = seq[seq.length - 1];
        if (!last || last.r !== p.r) seq.push({ r: p.r, at: k ? midPoint(c[k - 1], p) : p });
      }
      return seq;
    });
  }

  // Trenner: Nahtstellen zwischen zwei verschiedenen Aufträgen auf der Grenze
  boundaries() {
    this.border();
    const c = this.boundCache;
    if (c && c.slot === this.borderCache.slot && c.ver === this.version) return c.list;
    const list = [];
    for (const seq of this.sequences()) {
      for (let k = 1; k < seq.length; k++) {
        const a = this.assign.get(seq[k - 1].r) || null, b = this.assign.get(seq[k].r) || null;
        if (a && b && a !== b && a.kind === 'sectors' && b.kind === 'sectors' && !a.falling && !b.falling) list.push({ a, b, x: seq[k].at.x, y: seq[k].at.y });
      }
    }
    this.boundCache = { slot: this.borderCache.slot, ver: this.version, list };
    return list;
  }

  // Trenner zwischen den Aufträgen a und b (zuletzt bei near) zum Punkt p verschieben:
  // Sektoren zwischen beiden wechseln, jeder behält mindestens einen. Liefert die neue Lage
  moveBoundary(a, b, near, p) {
    let best = null, bd = Infinity;
    for (const seq of this.sequences()) {
      for (let k = 1; k < seq.length; k++) {
        const x = this.assign.get(seq[k - 1].r), y = this.assign.get(seq[k].r);
        if (!((x === a && y === b) || (x === b && y === a))) continue;
        const d = Math.hypot(seq[k].at.x - near.x, seq[k].at.y - near.y);
        if (d < bd) { bd = d; best = { seq, k, A: x, B: y }; }
      }
    }
    if (!best) return null;
    const { seq, k, A, B } = best;
    let lo = k - 1, hi = k;
    while (lo > 0 && this.assign.get(seq[lo - 1].r) === A) lo--;
    while (hi < seq.length - 1 && this.assign.get(seq[hi + 1].r) === B) hi++;
    let j = k, jd = Infinity;
    for (let m = lo + 1; m <= hi; m++) {
      const d = Math.hypot(seq[m].at.x - p.x, seq[m].at.y - p.y);
      if (d < jd) { jd = d; j = m; }
    }
    if (j !== k) {
      for (let m = lo; m <= hi; m++) this.assign.set(seq[m].r, m < j ? A : B);
      this.version++;
      this.afterAssign([A, B]);
    }
    return { x: seq[j].at.x, y: seq[j].at.y };
  }

  // Frontsektoren ohne besetzten Auftrag (Lücken)
  openSectors() {
    const manned = new Set(this.holds.filter((hd) => this.members(hd).length));
    return [...this.sectorInfo().regions.keys()].filter((r) => !manned.has(this.assign.get(r)));
  }

  // Besetzung eines Auftrags: einsatzbereite Kompanien je Frontsektor
  // level: 'good' (dicht), 'thin' (dünn), 'weak' (zu dünn), 'none' (keine Sektoren)
  holdStatus(hd) {
    let sectors = 0;
    for (const r of this.sectorInfo().regions.keys()) if (this.assign.get(r) === hd) sectors++;
    const divs = this.members(hd);
    const units = divs.reduce((s, d) => s + unitsOf(d).filter((u) => !u.broken).length, 0);
    const per = sectors ? units / sectors : 0;
    const level = !sectors ? 'none' : per >= 1 ? 'good' : per >= 0.5 ? 'thin' : 'weak';
    return { sectors, divs: divs.length, units, level };
  }

  // Nachbarn: Fronten desselben Auftrags, deren Enden nah an den eigenen Enden liegen
  // (HQs helfen einander nur innerhalb ihrer Armee aus)
  updateNeighbors() {
    const ends = new Map();
    for (const f of this.fronts) {
      const c = f.chains.filter((x) => x.length);
      ends.set(f, c.length ? [c[0][0], c[c.length - 1][c[c.length - 1].length - 1]] : []);
    }
    for (const f of this.fronts) {
      const mine = ends.get(f);
      f.neighbors = this.fronts.filter((o) => o !== f && o.hold === f.hold &&
        mine.some((p) => ends.get(o).some((q) => Math.hypot(p.x - q.x, p.y - q.y) < NEIGHBOR_DIST)));
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
    f.attack = { line: f.plan.line, name: f.plan.name, started: this.game.time };
    f.plan = null;
    for (const u of f.units) u.frontGoal = null;
    this.prepare(f);
  }

  // Angriff beenden (erreicht oder abgebrochen): zurück zum Halten des eigenen Abschnitts.
  // Eine frei gezeichnete Linie einer einzelnen Division rückt dabei auf die Ziellinie vor
  stopAttack(f, reached = false) {
    if (!f.attack) return;
    if (reached && f.kind === 'line' && this.members(f.hold).length === 1) {
      f.hold.line = f.attack.line;
      f.hold.ver = -1;
    }
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
    this.syncHolds();
    for (const f of [...this.fronts]) this.refresh(f, !!f.force);
    this.updateNeighbors();
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

  // Grenzzellen zum Gegner (ohne Kontakt: zu fremdem Land, das in seine Richtung zeigt)
  borderCells() {
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
    return cells;
  }

  // Grenzzellen zu Linien verketten; jeder Punkt kennt seine Grenzzelle (bx, by), deren
  // Sektor (r) und die Richtung zum Feind (nx, ny)
  borderChains(cells) {
    const g = this.game;
    const map = g.map;
    const { w, h } = map;
    const tr = g.territory;
    const me = this.owner;
    const passable = (i) => TERRAIN_INFO[map.cells[i]].passable;
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
        pts.push({ x: px, y: py, nx: n.x, ny: n.y, bx, by, r: g.sectors.of[i] });
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

function midPoint(a, b) {
  return { ...b, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
