import { unitStrength } from './game.js?v=54';
import { DIVISION, REGIMENT, unitsOf } from './orbat.js?v=54';
import { pointAt } from './fronts.js?v=54';

const HQ_BEHIND = 90;        // so weit hinter der Division steht das HQ
const PRESSURE_RADIUS = 140; // Feinde in diesem Umkreis zählen als Druck auf eine Kompanie
const SUPPORT_RADIUS = 80;   // eigene Kompanien in diesem Umkreis zählen als Unterstützung
const DONOR_RANGE = 320;     // so weit holt das HQ Verstärkung heran
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
    for (let p = 1; p <= 2; p++) {
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
    for (let p = 1; p <= 2; p++) {
      const cities = g.cities.filter((c) => c.owner === p);
      for (const f of g.orbat[p].all(DIVISION)) {
        const units = unitsOf(f).filter((u) => g.units.includes(u));
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
    if (u.target || u.rotating || u.swapUntil > t || u.hqOrder > t) return false;
    if (u.front) return !u.front.attack;
    if (u.ai && (u.ai.role === 'attack' || u.ai.role === 'stage' || u.ai.role === 'retreat')) return false;
    return !u.path.length;
  }

  command() {
    const g = this.game;
    for (let p = 1; p <= 2; p++) {
      const enemies = g.units.filter((e) => e.owner !== p && g.isVisible(p, e.x, e.y));
      for (const f of g.orbat[p].all(DIVISION)) {
        const hq = f.hq;
        if (!hq || !hq.alive) continue;
        const units = unitsOf(f).filter((u) => g.units.includes(u));
        if (units.length < 2) continue;
        if (!this.sealBreakthrough(p, f, hq, units, enemies)) this.balance(p, units, enemies);
      }
      this.coverGaps(p, enemies);
    }
  }

  // HQs sprechen sich ab: ist der Frontabschnitt einer Division (weitgehend) leer,
  // fordert ihr HQ bei den HQs der Nachbarfronten Hilfe an; der Nachbar mit Reserven
  // schickt Kompanien hinüber, bis die eigene Division den Abschnitt wieder besetzen kann
  coverGaps(p, enemies) {
    const g = this.game;
    const own = g.units.filter((u) => u.owner === p && !u.rotating);
    // Über die Divisionen suchen: auch ein ganz verlassener Abschnitt bittet um Hilfe
    const fronts = g.orbat[p].all(DIVISION).map((d) => d.front)
      .filter((f) => f && f.chains.length && !f.attack && f.neighbors && f.neighbors.length);
    for (const f of fronts) {
      const div = f.division;
      // Rückt die Division selbst noch ein, ist die Lücke kein Notfall
      if (f.units.length >= 2 && f.units.filter((u) => u.path.length).length >= f.units.length * 0.5) continue;
      const gaps = [];
      let total = 0;
      for (let t = 15; t < f.length; t += 30) {
        total++;
        const pt = pointAt(f.chains, t);
        if (!pt) continue;
        if (!own.some((u) => Math.abs(u.x - pt.x) < GAP_COVER && Math.abs(u.y - pt.y) < GAP_COVER &&
          Math.hypot(u.x - pt.x, u.y - pt.y) < GAP_COVER)) gaps.push(pt);
      }
      if (!total || gaps.length / total < 0.5) continue; // Abschnitt ausreichend besetzt
      if ((div.helpUntil || 0) > g.time) continue;       // Hilfe ist schon unterwegs
      const asker = div.hq;
      // Nachbarfronten fragen, die Division mit den meisten freien Kompanien nehmen
      let best = null;
      for (const nf of f.neighbors) {
        const nd = nf.division;
        if (!nd || nd.dissolved || nf.attack || !nd.hq || !nd.hq.alive) continue;
        const free = unitsOf(nd).filter((u) => g.units.includes(u) && this.controllable(u) &&
          !enemies.some((e) => Math.hypot(e.x - u.x, e.y - u.y) < PRESSURE_RADIUS));
        if (!best || free.length > best.free.length) best = { div: nd, free };
      }
      if ((div.askUntil || 0) > g.time) continue; // nicht ständig neu funken
      div.askUntil = g.time + 8;
      if (asker && asker.alive && best) this.radio(asker, best.div.hq, `${div.name} bittet um Unterstützung`);
      if (!best || best.free.length < 2) continue; // Nachbar hat selbst keine Reserven
      const send = Math.min(Math.ceil(gaps.length / 2), Math.floor(best.free.length / 2), 3);
      for (let k = 0; k < send; k++) {
        const pt = gaps[Math.floor((k + 0.5) * gaps.length / send)];
        let u = null, bd = Infinity;
        for (const c of best.free) { const d = Math.hypot(c.x - pt.x, c.y - pt.y); if (d < bd) { bd = d; u = c; } }
        if (!u) break;
        best.free.splice(best.free.indexOf(u), 1);
        this.send(u, pt.x, pt.y, 'aushelfen', true, LOAN_TIME);
      }
      if (send > 0) {
        div.helpUntil = g.time + LOAN_TIME;
        this.radio(best.div.hq, asker && asker.alive ? asker : best.div.hq, `${best.div.name} übernimmt Abschnitt (${send} Kp.)`);
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
      if (g.units.some((o) => o.owner === p && Math.hypot(o.x - e.x, o.y - e.y) < 40)) continue;
      let city = cities[0], cd = Infinity;
      for (const c of cities) { const dc = Math.hypot(c.x - e.x, c.y - e.y); if (dc < cd) { cd = dc; city = c; } }
      const line = units.filter((u) => Math.hypot(u.x - e.x, u.y - e.y) < 220);
      if (!line.length) continue;
      const lineDist = Math.min(...line.map((u) => Math.hypot(u.x - city.x, u.y - city.y)));
      if (cd >= lineDist - SEAL_DEPTH) continue;
      // Schon ein Regiment unterwegs dorthin?
      if (g.units.some((o) => o.owner === p && o.hqTask === 'abriegeln' && o.hqOrder > g.time &&
        o.path.length && Math.hypot(o.path[o.path.length - 1].x - e.x, o.path[o.path.length - 1].y - e.y) < 80)) continue;
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
      const comps = reg.units.filter((u) => u.hp > 0 && g.units.includes(u));
      if (!comps.length || !comps.every((u) => this.controllable(u))) continue;
      // Nur Regimenter ohne Feinddruck: sonst reißt das Abriegeln neue Lücken
      if (comps.some((u) => enemies.some((e) => Math.hypot(e.x - u.x, e.y - u.y) < PRESSURE_RADIUS))) continue;
      const cx = comps.reduce((a, u) => a + u.x, 0) / comps.length;
      const cy = comps.reduce((a, u) => a + u.y, 0) / comps.length;
      const d = Math.hypot(cx - target.x, cy - target.y);
      if (d < bestD) { bestD = d; best = comps; helper = !own.includes(reg); }
    }
    if (!best) return false;
    // Sperrstellung zwischen Durchbrecher und Stadt beziehen, quer zur Stoßrichtung
    let city = cities[0], cd = Infinity;
    for (const c of cities) { const dc = Math.hypot(c.x - target.x, c.y - target.y); if (dc < cd) { cd = dc; city = c; } }
    const ux = (city.x - target.x) / (cd || 1), uy = (city.y - target.y) / (cd || 1);
    const bx = target.x + ux * Math.min(45, cd * 0.5), by = target.y + uy * Math.min(45, cd * 0.5);
    best.forEach((u, k) => {
      const off = (k - (best.length - 1) / 2) * 16;
      this.send(u, bx - uy * off, by + ux * off, 'abriegeln', helper);
    });
    f.sealUntil = g.time + SEAL_COOLDOWN;
    return true;
  }

  // Kräfte angleichen: Kompanie mit größtem Überdruck bekommt Verstärkung aus ruhigen Abschnitten
  balance(p, units, enemies) {
    const near = (list, x, y, r) => list.reduce((a, o) => (Math.hypot(o.x - x, o.y - y) <= r ? a + unitStrength(o) : a), 0);
    const own = this.game.units.filter((o) => o.owner === p);
    const rated = units.map((u) => {
      const pressure = near(enemies, u.x, u.y, PRESSURE_RADIUS);
      const support = near(own, u.x, u.y, SUPPORT_RADIUS);
      return { u, pressure, gap: pressure - support };
    });
    let moves = 0;
    for (const hot of rated.filter((r) => r.gap > 0.8).sort((a, b) => b.gap - a.gap)) {
      if (moves >= 3) break;
      // Ruhige Kompanie der Division (kein Druck) in Reichweite suchen
      let donor = null, dd = Infinity;
      for (const r of rated) {
        if (r === hot || r.pressure > 0 || !this.controllable(r.u)) continue;
        const d = Math.hypot(r.u.x - hot.u.x, r.u.y - hot.u.y);
        if (d < dd && d < DONOR_RANGE) { dd = d; donor = r; }
      }
      if (!donor) continue;
      // Hinter die bedrängte Kompanie, vom Feind abgewandt
      const foes = enemies.filter((e) => Math.hypot(e.x - hot.u.x, e.y - hot.u.y) <= PRESSURE_RADIUS);
      const ex = foes.reduce((a, e) => a + e.x, 0) / foes.length, ey = foes.reduce((a, e) => a + e.y, 0) / foes.length;
      const dl = Math.hypot(hot.u.x - ex, hot.u.y - ey) || 1;
      const side = (moves % 2 ? 1 : -1) * 14;
      const nx = (hot.u.x - ex) / dl, ny = (hot.u.y - ey) / dl;
      this.send(donor.u, hot.u.x + nx * 12 - ny * side, hot.u.y + ny * 12 + nx * side, 'verstärken');
      hot.gap -= unitStrength(donor.u);
      donor.pressure = Infinity; // nicht doppelt verwenden
      moves++;
    }
  }

  // helper: Regiment eines Nachbarn; behält seinen Frontplatz und kehrt nach dem Befehl zurück
  send(u, x, y, task, helper = false, duration = ORDER_TIME) {
    const g = this.game;
    u.path = g.map.findPath(u.x, u.y, x, y) || [];
    u.stuck = 0;
    u.hqOrder = g.time + duration;
    u.hqTask = task;
    if (u.ai) u.ai = null;
    // Die Front übernimmt die neue Stellung als Platz der Kompanie
    if (u.front && !helper) u.frontGoal = { x, y };
  }
}

function regimentsOf(f) {
  if (f.level === REGIMENT) return [f];
  return f.children.flatMap(regimentsOf);
}
