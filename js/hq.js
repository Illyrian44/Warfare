import { unitStrength } from './game.js?v=110';
import { DIVISION, REGIMENT, unitsOf } from './orbat.js?v=110';

const HQ_BEHIND = 90;        // so weit hinter der Division steht das HQ
const PRESSURE_RADIUS = 140; // Feinde in diesem Umkreis zählen als Druck auf eine Kompanie
const SUPPORT_RADIUS = 80;   // eigene Kompanien in diesem Umkreis zählen als Unterstützung
const DONOR_RANGE = 200;     // so weit holt das HQ Verstärkung heran
const HELP_RANGE = 200;      // so weit darf eine Kompanie zum Aushelfen oder Abriegeln marschieren
const COMMAND_RANGE = 380;   // Durchbrüche in diesem Umkreis um das HQ werden abgeriegelt
const ORDER_TIME = 14;       // Sekunden, die ein HQ-Befehl Vorrang hat
const LOAN_TIME = 30;        // so lange hilft eine Kompanie im Nachbarabschnitt aus
const GAP_COVER = 45;        // ein Frontpunkt gilt als besetzt, wenn eine Kompanie so nah steht
const SEAL_COOLDOWN = 20;    // so lange nach einem Abriegeln kein weiteres in derselben Division
const SEAL_DEPTH = 60;       // so weit muss ein Feind hinter der Linie stehen

// Divisions-Hauptquartiere: stehen hinter der Linie, sind keine Kampfeinheiten und
// steuern die Kompanien ihrer Division in der Verteidigung
export class HQManager {
  constructor(game) {
    this.game = game;
    this.timer = 1;
    this.cmdTimer = 2;
    this.messages = []; // Funkverkehr zwischen HQs (zum Anzeigen)
  }

  // Nachricht zwischen zwei HQs festhalten
  radio(from, to, text) {
    const g = this.game;
    this.messages.push({ from, to, text, time: g.time, owner: from.owner });
    if (this.messages.length > 40) this.messages.shift();
    g.events.push({ type: 'hqRadio', owner: from.owner, from, to, text });
  }

  get hqs() {
    const out = [];
    for (const p of this.game.players) {
      for (const f of this.game.orbat[p].all(DIVISION)) if (f.hq && f.hq.alive) out.push(f.hq);
    }
    return out;
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = 0.5; this.place(); }
    this.cmdTimer -= dt;
    if (this.cmdTimer <= 0) { this.cmdTimer = 2; this.command(); }
  }

  // HQ hinter den Schwerpunkt der Division setzen, Richtung nächste eigene Stadt
  place() {
    const g = this.game;
    for (const p of g.players) {
      const cities = g.cities.filter((c) => c.owner === p);
      for (const f of g.orbat[p].all(DIVISION)) {
        const units = unitsOf(f);
        if (!units.length || !cities.length) { if (f.hq) f.hq.alive = false; continue; }
        const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
        const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
        let city = cities[0], bd = Infinity;
        for (const c of cities) { const d = Math.hypot(c.x - cx, c.y - cy); if (d < bd) { bd = d; city = c; } }
        const back = Math.min(HQ_BEHIND, bd);
        const dx = (city.x - cx) / (bd || 1), dy = (city.y - cy) / (bd || 1);
        let tx = cx + dx * back, ty = cy + dy * back;
        // Im eigenen Gebiet bleiben: notfalls weiter Richtung Stadt rücken
        for (let k = 0; k < 10 && g.territory[g.map.cellIndex(tx, ty)] !== p; k++) {
          tx += (city.x - tx) * 0.3; ty += (city.y - ty) * 0.3;
        }
        if (!f.hq) f.hq = { owner: p, formation: f, x: tx, y: ty, alive: true };
        const hq = f.hq;
        hq.alive = true;
        hq.x += (tx - hq.x) * 0.35;
        hq.y += (ty - hq.y) * 0.35;
      }
    }
  }

  // Darf das HQ diese Kompanie bewegen? Nur in der Verteidigung, nicht bei Angriffen,
  // laufenden Platztauschen, Rotation oder Gefecht
  controllable(u) {
    const t = this.game.time;
    if (u.target || u.rotating || u.broken || u.swapUntil > t || u.hqOrder > t) return false;
    if (u.front) return !u.front.attack;
    if (u.ai && (u.ai.role === 'attack' || u.ai.role === 'stage' || u.ai.role === 'retreat')) return false;
    return !u.path.length;
  }

  // Sichtbare Feinde bzw. eigene Kompanien im Umkreis, aus dem Raster des Spielschritts
  // (statt jedes Mal alle Kompanien durchzugehen)
  foesNear(p, x, y, r) {
    const g = this.game;
    return g.unitGrid.within(x, y, r).filter((e) => g.hostile(e.owner, p) && g.isVisible(p, e.x, e.y));
  }

  ownNear(p, x, y, r) {
    return this.game.unitGrid.within(x, y, r).filter((o) => o.owner === p);
  }

  command() {
    const g = this.game;
    for (const p of g.players) {
      const enemies = g.units.filter((e) => g.hostile(e.owner, p) && g.isVisible(p, e.x, e.y));
      // laufende Abriegelungen dieser Seite (für sealBreakthrough)
      this.sealing = g.units.filter((o) => o.owner === p && o.hqTask === 'abriegeln' && o.hqOrder > g.time && o.path.length);
      for (const f of g.orbat[p].all(DIVISION)) {
        const hq = f.hq;
        if (!hq || !hq.alive) continue;
        const units = unitsOf(f);
        if (units.length < 2) continue;
        if (!this.sealBreakthrough(p, f, hq, units, enemies)) this.balance(p, units);
      }
      this.coverGaps(p);
    }
  }

  // HQs sprechen sich ab: ist der Frontabschnitt einer Division (weitgehend) leer,
  // fordert ihr HQ bei den HQs der Nachbarfronten Hilfe an; der Nachbar mit Reserven
  // schickt Kompanien hinüber, bis die eigene Division den Abschnitt wieder besetzen kann
  coverGaps(p) {
    const g = this.game;
    // Über die Divisionen suchen: auch ein ganz verlassener Abschnitt bittet um Hilfe
    const fronts = g.orbat[p].all(DIVISION).map((d) => d.front)
      .filter((f) => f && f.points.length && !f.attack && f.neighbors && f.neighbors.length);
    for (const f of fronts) {
      const div = f.division;
      // Rückt die Division selbst noch ein, ist die Lücke kein Notfall
      if (f.units.length >= 2 && f.units.filter((u) => u.path.length).length >= f.units.length * 0.5) continue;
      const gaps = [];
      let total = 0;
      // Stichproben entlang des Abschnitts (etwa alle drei Grenzfelder)
      for (let k = 1; k < f.points.length; k += 3) {
        total++;
        const pt = f.points[k];
        if (!this.ownNear(p, pt.x, pt.y, GAP_COVER).some((u) => !u.rotating)) gaps.push(pt);
      }
      if (!total || gaps.length / total < 0.5) continue; // Abschnitt ausreichend besetzt
      if ((div.helpUntil || 0) > g.time) continue;       // Hilfe ist schon unterwegs
      const asker = div.hq;
      // Nachbarfronten fragen, die Division mit den meisten freien Kompanien nehmen
      let best = null;
      for (const nf of f.neighbors) {
        const nd = nf.division;
        if (!nd || nd.dissolved || nf.attack || !nd.hq || !nd.hq.alive) continue;
        const free = unitsOf(nd).filter((u) => this.controllable(u) && !this.foesNear(p, u.x, u.y, PRESSURE_RADIUS).length);
        if (!best || free.length > best.free.length) best = { div: nd, free };
      }
      if ((div.askUntil || 0) > g.time) continue; // nicht ständig neu funken
      div.askUntil = g.time + 8;
      if (asker && asker.alive && best) this.radio(asker, best.div.hq, `${div.name} bittet um Unterstützung`);
      if (!best || best.free.length < 2) continue; // Nachbar hat selbst keine Reserven
      const send = Math.min(Math.ceil(gaps.length / 2), Math.floor(best.free.length / 2), 3);
      let sent = 0;
      for (let k = 0; k < send; k++) {
        const pt = gaps[Math.floor((k + 0.5) * gaps.length / send)];
        // nur Kompanien in der Nähe der Lücke, und nur auf einem Weg hinter der eigenen Linie
        let u = null, bd = HELP_RANGE;
        for (const c of best.free) { const d = Math.hypot(c.x - pt.x, c.y - pt.y); if (d < bd) { bd = d; u = c; } }
        if (!u) continue;
        best.free.splice(best.free.indexOf(u), 1);
        if (this.send(u, pt.x, pt.y, 'aushelfen', true, LOAN_TIME)) sent++;
      }
      if (sent > 0) {
        div.helpUntil = g.time + LOAN_TIME;
        this.radio(best.div.hq, asker && asker.alive ? asker : best.div.hq, `${best.div.name} übernimmt Abschnitt (${sent} Kp.)`);
      }
    }
  }

  // Durchbruch: ein Feind steht näher an unserer Stadt als unsere Kompanien in seiner Nähe,
  // ist also an ihnen vorbei -> nächstes freies Regiment der Division riegelt ab
  sealBreakthrough(p, f, hq, units, enemies) {
    const g = this.game;
    const cities = g.cities.filter((c) => c.owner === p);
    if (!cities.length || (f.sealUntil || 0) > g.time) return false;
    let target = null, bd = Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - hq.x, e.y - hq.y);
      if (d > COMMAND_RANGE || d >= bd) continue;
      if (this.ownNear(p, e.x, e.y, 40).length) continue;
      let city = cities[0], cd = Infinity;
      for (const c of cities) { const dc = Math.hypot(c.x - e.x, c.y - e.y); if (dc < cd) { cd = dc; city = c; } }
      const line = units.filter((u) => Math.hypot(u.x - e.x, u.y - e.y) < 220);
      if (!line.length) continue;
      const lineDist = Math.min(...line.map((u) => Math.hypot(u.x - city.x, u.y - city.y)));
      if (cd >= lineDist - SEAL_DEPTH) continue;
      // Schon ein Regiment unterwegs dorthin?
      if (this.sealing.some((o) => Math.hypot(o.path[o.path.length - 1].x - e.x, o.path[o.path.length - 1].y - e.y) < 80)) continue;
      target = e; bd = d;
    }
    if (!target) return false;
    let best = null, bestD = Infinity;
    // Erst eigene Regimenter, sonst darf ein Nachbar aushelfen (kehrt danach zurück)
    const own = regimentsOf(f);
    const neighbors = g.orbat[p].all(f.level).filter((o) => o !== f && o.hq && o.hq.alive &&
      Math.hypot(o.hq.x - hq.x, o.hq.y - hq.y) < COMMAND_RANGE).flatMap(regimentsOf);
    let helper = false;
    for (const reg of own.concat(neighbors)) {
      if (best && !helper && !own.includes(reg)) break; // eigenes Regiment gefunden
      const comps = reg.units.filter((u) => u.hp > 0);
      if (!comps.length || !comps.every((u) => this.controllable(u) && u.org > u.maxOrg * 0.5)) continue;
      // Nur Regimenter ohne Feinddruck: sonst reißt das Abriegeln neue Lücken
      if (comps.some((u) => this.foesNear(p, u.x, u.y, PRESSURE_RADIUS).length)) continue;
      const cx = comps.reduce((a, u) => a + u.x, 0) / comps.length;
      const cy = comps.reduce((a, u) => a + u.y, 0) / comps.length;
      const d = Math.hypot(cx - target.x, cy - target.y);
      if (d < bestD && d < HELP_RANGE) { bestD = d; best = comps; helper = !own.includes(reg); }
    }
    if (!best) return false;
    // Sperrstellung zwischen Durchbrecher und Stadt beziehen, quer zur Stoßrichtung
    let city = cities[0], cd = Infinity;
    for (const c of cities) { const dc = Math.hypot(c.x - target.x, c.y - target.y); if (dc < cd) { cd = dc; city = c; } }
    const ux = (city.x - target.x) / (cd || 1), uy = (city.y - target.y) / (cd || 1);
    const bx = target.x + ux * Math.min(45, cd * 0.5), by = target.y + uy * Math.min(45, cd * 0.5);
    let sent = 0;
    best.forEach((u, k) => {
      const off = (k - (best.length - 1) / 2) * 16;
      if (this.send(u, bx - uy * off, by + ux * off, 'abriegeln', helper)) sent++;
    });
    f.sealUntil = g.time + SEAL_COOLDOWN;
    return sent > 0;
  }

  // Kräfte angleichen: Kompanie mit größtem Überdruck bekommt Verstärkung aus ruhigen Abschnitten
  balance(p, units) {
    const sum = (list) => list.reduce((a, o) => a + unitStrength(o), 0);
    const rated = units.map((u) => {
      const pressure = sum(this.foesNear(p, u.x, u.y, PRESSURE_RADIUS));
      const support = sum(this.ownNear(p, u.x, u.y, SUPPORT_RADIUS));
      return { u, pressure, gap: pressure - support };
    });
    let moves = 0;
    for (const hot of rated.filter((r) => r.gap > 0.8).sort((a, b) => b.gap - a.gap)) {
      if (moves >= 3) break;
      // Ruhige Kompanie der Division (kein Druck) in Reichweite suchen
      let donor = null, dd = Infinity;
      for (const r of rated) {
        if (r === hot || r.pressure > 0 || !this.controllable(r.u) || r.u.org < r.u.maxOrg * 0.6) continue;
        const d = Math.hypot(r.u.x - hot.u.x, r.u.y - hot.u.y);
        if (d < dd && d < DONOR_RANGE) { dd = d; donor = r; }
      }
      if (!donor) continue;
      // Hinter die bedrängte Kompanie, vom Feind abgewandt
      const foes = this.foesNear(p, hot.u.x, hot.u.y, PRESSURE_RADIUS);
      const ex = foes.reduce((a, e) => a + e.x, 0) / foes.length, ey = foes.reduce((a, e) => a + e.y, 0) / foes.length;
      const dl = Math.hypot(hot.u.x - ex, hot.u.y - ey) || 1;
      const side = (moves % 2 ? 1 : -1) * 14;
      const nx = (hot.u.x - ex) / dl, ny = (hot.u.y - ey) / dl;
      if (!this.send(donor.u, hot.u.x + nx * 12 - ny * side, hot.u.y + ny * 12 + nx * side, 'verstärken')) {
        donor.pressure = Infinity; // kein sicherer Weg: diese Kompanie nicht nochmal fragen
        continue;
      }
      hot.gap -= unitStrength(donor.u);
      donor.pressure = Infinity; // nicht doppelt verwenden
      moves++;
    }
  }

  // helper: Regiment eines Nachbarn; behält seinen Frontplatz und kehrt nach dem Befehl zurück.
  // Nur auf einem Weg hinter der eigenen Linie: führt keiner durch eigenes (verbündetes oder
  // neutrales) Land, unterbleibt der Befehl (liefert false)
  send(u, x, y, task, helper = false, duration = ORDER_TIME) {
    const g = this.game;
    const fm = g.routers && g.routers[u.owner];
    const safe = fm ? fm.safeRouting() : null;
    const path = g.map.findPath(u.x, u.y, x, y, safe ? { cost: safe.cost, safe: safe.safe, strict: true } : null);
    if (!path) return false;
    for (const q of path) if (g.hostile(u.owner, g.territory[g.map.cellIndex(q.x, q.y)])) return false;
    u.path = path;
    u.stuck = 0;
    u.hqOrder = g.time + duration;
    u.hqTask = task;
    if (u.ai) u.ai = null;
    // Die Front übernimmt die neue Stellung als Platz der Kompanie
    if (u.front && !helper) u.frontGoal = { x, y };
    return true;
  }
}

function regimentsOf(f) {
  if (f.level === REGIMENT) return [f];
  return f.children.flatMap(regimentsOf);
}
