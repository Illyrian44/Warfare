// Test ohne Browser: die KI spielt auf allen Kartengrößen gegen sich selbst.
// Prüft, dass nichts abstürzt, die Partie endet und Gliederung und Positionen stimmig bleiben.
// Aufruf: npm test
import { readFileSync } from 'node:fs';

const v = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const load = (name) => import(new URL(`../js/${name}.js?v=${v}`, import.meta.url));
const { mapFromData } = await load('map');
const unitsOfDiv = (div) => div.children.flatMap((r) => r.units).map((u) => u.type);
const mapData = new Map();
const realMap = (id, seed) => {
  if (!mapData.has(id)) mapData.set(id, JSON.parse(readFileSync(new URL(`../maps/${id}.json`, import.meta.url), 'utf8')));
  return mapFromData(mapData.get(id), seed);
};
const { Game } = await load('game');
const { AI } = await load('ai');
const { TERRAIN_INFO } = await load('config');
const { REGIMENT, DIVISION, ARMY, DIVISION_MAX, REGIMENT_MAX, strength, divisionOf } = await load('orbat');
const { formationSlots } = await load('formation');
const { FrontManager } = await load('fronts');
const { cycleSelection } = await load('input');
const { KM, CELL, CITY_BORDER, UNIT_BORDER, DIPLOMACY } = await load('config');

const STEP = 1 / 30;
// Sekunden Spielzeit, bis die Partie entschieden sein muss (mit mehr Seiten dauert es länger;
// gleiche Karte und Seitenzahl streuen je nach Zufall etwa zwischen 11 und 21 Minuten)
const maxTime = (np) => (np >= 5 ? 45 : 30) * 60;
// Zufall der Partie, Karte, Zahl der Seiten (alle von der KI gespielt)
// QUICK=1 npm test: nur die schnellen Prüfungen, ohne ganze Partien
const CASES = process.env.QUICK ? [] : [[1, 'balkan', 2], [42, 'mitteleuropa', 3], [777, 'balkan', 5]];

let failed = 0;
const fail = (msg) => { failed++; console.error('  FEHLER: ' + msg); };

const brokenStuck = new Map(); // zerschlagene Kompanien, die ohne Rückzugsweg im Gefecht stehen

function checkState(g, label, ais) {
  // Versorgung: Vorrat und Lieferquote im gültigen Bereich
  for (const u of g.units) {
    if (!(u.supply >= 0 && u.supply <= 1)) fail(`${label}: Kompanie ${u.id} hat Vorrat ${u.supply}`);
    if (!(u.supplyEff >= 0 && u.supplyEff <= 1)) fail(`${label}: Kompanie ${u.id} hat Lieferquote ${u.supplyEff}`);
    if (!(u.org >= 0 && u.org <= u.maxOrg)) fail(`${label}: Kompanie ${u.id} hat Organisation ${u.org}`);
    if (u.broken && u.org >= u.maxOrg * 0.5) fail(`${label}: Kompanie ${u.id} ist zerschlagen trotz Organisation ${u.org.toFixed(1)}`);
    // (ausgenommen: eingeschlossen in der letzten eigenen Stadt, es gibt keinen Rückzugsort)
    const trapped = g.cities.filter((c) => c.owner === u.owner).length <= 1;
    if (u.broken && u.path.length === 0 && u.target && !trapped) brokenStuck.set(u, (brokenStuck.get(u) || 0) + 1);
    else brokenStuck.delete(u);
    if (brokenStuck.get(u) === 6) fail(`${label}: zerschlagene Kompanie ${u.id} steht seit 5 s ohne Rückzugsweg im Gefecht`);
  }
  // Keine Einheit dauerhaft auf unbegehbarem Gelände
  for (const u of g.units) {
    const t = g.map.cellTerrainAt(u.x, u.y);
    if (!TERRAIN_INFO[t].passable) u.badTime = (u.badTime || 0) + 1; else u.badTime = 0;
    if (u.badTime > 10) { fail(`${label}: Einheit ${u.id} steckt auf unbegehbarem Gelände (${u.x.toFixed(0)}, ${u.y.toFixed(0)})`); u.badTime = -1e9; }
  }
  // Bündnisse: Verbündete kämpfen nicht gegeneinander
  for (const u of g.units) {
    if (u.target && !g.hostile(u.owner, u.target.owner)) fail(`${label}: Kompanie ${u.id} (Seite ${u.owner}) kämpft gegen Verbündete (Seite ${u.target.owner})`);
  }
  // Handel: Kolonnen nur zwischen Partnern, nie auf Feindgebiet
  for (const k of g.trade.convoys) {
    if (!g.trade.partnerOk(k.owner, g.cities[k.from].owner === k.owner ? k.owner : k.owner)) fail(`${label}: Kolonne ohne gültigen Besitzer`);
    if (k.kind === 'land' && g.hostile(k.owner, g.territory[g.map.cellIndex(k.x, k.y)])) fail(`${label}: Kolonne von Seite ${k.owner} fährt auf Feindgebiet`);
  }
  // Ausbildung nur in eigenen Städten
  for (const o of g.production.orders) {
    if (g.cities[o.city].owner !== o.owner) fail(`${label}: Auftrag ${o.id} von Seite ${o.owner} in fremder Stadt ${g.cities[o.city].name}`);
  }
  // Wirtschaft: Geld und Manpower nie negativ, Manpower höchstens bis zum Vorrat
  for (const p of g.players) {
    const e = g.eco[p];
    if (!(e.money >= 0) || !Number.isFinite(e.money)) fail(`${label}: Seite ${p} hat Geld ${e.money}`);
    if (!(e.manpower >= 0 && e.manpower <= e.mpCap + 1e-6)) fail(`${label}: Seite ${p} hat Manpower ${e.manpower} (Vorrat ${e.mpCap})`);
  }
  // Gliederung: Höchststärken, Regimenter nach Typ getrennt, jede Kompanie in höchstens einem Regiment
  for (const p of g.players) {
    const divs = g.orbat[p].all(DIVISION);
    for (const div of divs) {
      if (strength(div) > DIVISION_MAX) fail(`${label}: ${div.name} hat ${strength(div)} Kompanien`);
      if (div.dissolved) fail(`${label}: aufgelöste ${div.name} steht noch in der Liste`);
    }
    // Armeen: nie leer, Verweise in beide Richtungen stimmig, nur bestehende Divisionen
    for (const army of g.orbat[p].all(ARMY)) {
      if (!army.children.length) fail(`${label}: leere ${army.name} besteht noch`);
      for (const d of army.children) {
        if (d.parent !== army) fail(`${label}: ${d.name} steht in ${army.name}, verweist aber woanders hin`);
        if (d.dissolved || !divs.includes(d)) fail(`${label}: aufgelöste ${d.name} steht noch in ${army.name}`);
      }
    }
    for (const div of divs) {
      if (div.parent && !g.orbat[p].all(ARMY).includes(div.parent)) fail(`${label}: ${div.name} gehört zu einer aufgelösten Armee`);
    }
    const seen = new Map();
    for (const reg of g.orbat[p].all(REGIMENT)) {
      if (reg.units.length > REGIMENT_MAX) fail(`${label}: ${reg.name} hat ${reg.units.length} Kompanien`);
      if (!divs.includes(reg.parent)) fail(`${label}: ${reg.name} gehört zu keiner bestehenden Division`);
      if (reg.units.some((u) => u.type !== reg.type)) fail(`${label}: ${reg.name} mischt Infanterie und Panzer`);
      for (const u of reg.units) {
        if (!g.units.includes(u)) continue;
        if (seen.has(u)) fail(`${label}: Kompanie ${u.id} steht in zwei Regimentern`);
        seen.set(u, reg);
        if (u.regiment !== reg) fail(`${label}: Kompanie ${u.id} verweist auf ein anderes Regiment`);
      }
    }
    for (const u of g.units) {
      if (u.owner === p && u.regiment && !seen.has(u)) fail(`${label}: Kompanie ${u.id} fehlt in ihrem Regiment`);
      if (u.owner === p && u.regiment && u.regiment.parent.dissolved) fail(`${label}: Kompanie ${u.id} hängt an einer aufgelösten Division`);
    }
  }
  // Fronten: je Division höchstens eine, nur Kompanien der eigenen Division, jede gehört zu
  // einem bestehenden Auftrag, die Teile eines Auftrags überlappen sich nicht
  for (const ai of ais) {
    const fm = ai.fronts;
    // Jedes Grenzfeld gehört höchstens einer Division
    const seen = new Set();
    for (const f of fm.fronts) for (const e of f.cells) {
      if (seen.has(e)) fail(`${label}: Grenzfeld ${e.i} in zwei Divisionsabschnitten`);
      seen.add(e);
    }
    const divs = new Set();
    for (const f of fm.fronts) {
      if (!f.division || f.division.dissolved) fail(`${label}: Front ${f.id} ohne bestehende Division`);
      if (!fm.holds.includes(f.hold)) fail(`${label}: Front von ${f.division.name} ohne Auftrag`);
      if (divs.has(f.division)) fail(`${label}: ${f.division.name} hat zwei Fronten`);
      // Angriffe sind Aufträge: die KI-Division bleibt ihrem Grenzabschnitt zugewiesen
      if (f.kind === 'line') fail(`${label}: Front von ${f.division.name} ist zur freien Linie geworden`);
      divs.add(f.division);
      for (const u of f.units) {
        if (!g.units.includes(u)) continue;
        if (divisionOf(u) !== f.division) fail(`${label}: Kompanie ${u.id} steht an der Front einer fremden Division`);
        if (u.front !== f) fail(`${label}: Kompanie ${u.id} weiß nichts von ihrer Front`);
      }
    }
  }
}

// --- Reine Funktionen der Steuerung -------------------------------------------------
{
  // Klickfolge: Gruppe -> Division -> Kompanie -> Gruppe; gleiche Stufen werden übersprungen
  const a = { id: 1 }, b = { id: 2 }, c = { id: 3 };
  const steps = [[a, b], [a, b, c], [a]];
  const ids = (l) => l.map((u) => u.id).join(',');
  const seq = [[]];
  for (let i = 0; i < 4; i++) seq.push(cycleSelection(steps, seq[seq.length - 1]));
  if (seq.slice(1).map(ids).join(' | ') !== '1,2 | 1,2,3 | 1 | 1,2') fail(`Klickfolge falsch: ${seq.slice(1).map(ids).join(' | ')}`);
  if (ids(cycleSelection([[a, b], [b, a], [a]], [a, b])) !== '1') fail('Klickfolge überspringt gleiche Stufen nicht');
  if (cycleSelection([[a]], [a]).length !== 0) fail('Klickfolge: einzige Stufe erneut angeklickt hebt die Auswahl nicht auf');
  if (ids(cycleSelection(steps, [c])) !== '1,2') fail('Klickfolge beginnt bei fremder Auswahl nicht mit der Gruppe');

  // Aufstellung am Ziel: dicht (1,5 km Abstand), um den Zielpunkt, keine doppelten Plätze
  const units = [];
  for (let i = 0; i < 8; i++) units.push({ id: i, x: 100 + (i % 4) * 30, y: 100 + Math.floor(i / 4) * 30 });
  const target = { x: 400, y: 250 };
  const slots = formationSlots(units, target);
  if (slots.length !== units.length || new Set(slots.map((s) => s.u)).size !== units.length) fail('Aufstellung: nicht jede Einheit hat genau einen Platz');
  let minGap = Infinity, maxDist = 0;
  for (const s of slots) {
    maxDist = Math.max(maxDist, Math.hypot(s.x - target.x, s.y - target.y));
    for (const t of slots) if (s !== t) minGap = Math.min(minGap, Math.hypot(s.x - t.x, s.y - t.y));
  }
  if (minGap < 1.5 * KM - 1e-6) fail(`Aufstellung: Plätze nur ${minGap.toFixed(1)} auseinander`);
  if (maxDist > 2.5 * KM) fail(`Aufstellung: Platz ${maxDist.toFixed(1)} vom Ziel entfernt`);
  // Umschalt: Abstände bleiben erhalten
  const kept = formationSlots(units, target, true);
  const d0 = Math.hypot(units[0].x - units[7].x, units[0].y - units[7].y);
  const d1 = Math.hypot(kept[0].x - kept[7].x, kept[0].y - kept[7].y);
  if (Math.abs(d0 - d1) > 1e-6) fail('Aufstellung mit Umschalt verändert die Abstände');
  if (failed) process.exit(1);
  console.log('ok   Klickfolge und Aufstellung am Ziel');
}

// --- Haltende Grenzfront rückt nicht von selbst vor ---------------------------------
{
  // Seite 1 hält die ganze Grenze, der Gegner steht still: das Gebiet darf nach dem
  // Einrücken nicht weiter wachsen (früher schob jede haltende Front die Grenze vor)
  const g = new Game(realMap('mitteleuropa', 1));
  g.growTimer = Infinity; // nur die Front prüfen, nicht das Wachstum ins neutrale Land
  const home = g.cities[g.starts[1]];
  for (let k = 0; k < 12; k++) g.spawnUnit(1, 'light', home);
  const fm = new FrontManager(g, 1);
  g.orbat[1].autoOrganize(g.units.filter((u) => u.owner === 1));
  fm.assignAll(g.orbat[1].createArmy(g.orbat[1].all(DIVISION)));
  const terr = () => g.territory.reduce((a, t) => a + (t === 1), 0);
  let t60 = 0;
  for (let s = 1; s <= 180 * 30; s++) {
    fm.update(STEP); g.step(STEP); g.events.length = 0;
    if (s === 60 * 30) t60 = terr();
  }
  const grown = terr() - t60;
  if (grown > 20) fail(`Haltende Grenzfront nimmt von selbst Land ein (+${grown} Felder in 2 Minuten)`);
  else console.log('ok   Haltende Grenzfront bleibt stehen');
}

// --- Fronten: Aufteilen, Trenner, eigene Division, Mitwandern, keine Lücken ----------
{
  const g = new Game(realMap('balkan', 3), { players: 2 });
  const home = g.cities[g.starts[1]];
  for (let k = 0; k < 16; k++) g.spawnUnit(1, k % 4 ? 'light' : 'heavy', home);
  const ob = g.orbat[1];
  const fm = new FrontManager(g, 1);
  const divs = ob.autoOrganize(g.units.filter((u) => u.owner === 1));
  const all = fm.frontInfo().list;
  if (divs.length < 3) fail(`Fronttest: nur ${divs.length} Divisionen`);
  else if (all.length < 10) fail(`Fronttest: nur ${all.length} Grenzfelder`);
  else {
    const A = ob.createArmy([divs[0]]), B = ob.createArmy(divs.slice(1));
    fm.assignSplit([A, B], all);
    const ha = fm.holdOf(A), hb = fm.holdOf(B);
    const count = (hd) => fm.holdEntries(hd).length;
    if (!ha || !hb) fail('Fronttest: Aufteilen auf zwei Armeen ergibt nicht zwei Aufträge');
    else {
      if (fm.openEntries().length) fail(`Fronttest: ${fm.openEntries().length} Grenzfelder ohne Front nach „Ganze Grenze“`);
      for (const d of [...A.children, ...B.children]) if (!fm.fronts.includes(d.front)) fail(`Fronttest: ${d.name} hat keine Front`);
      // Jede Kompanie hat einen Platz, und die Plätze einer Division liegen auf ihren Grenzfeldern
      fm.syncAll();
      for (const f of fm.fronts) {
        const act = f.units.filter((u) => !u.rotating && !u.broken);
        if (f.cells.length && act.some((u) => !f.slots.get(u))) fail(`Fronttest: Kompanie von ${f.division.name} ohne Platz`);
      }
      // Trenner zur Mitte des anderen Auftrags ziehen: Grenzfelder wechseln, beide behalten welche
      const bnd = fm.boundaries().find((b) => (b.a === ha && b.b === hb) || (b.a === hb && b.b === ha));
      if (!bnd) fail('Fronttest: kein Trenner zwischen den Armeen');
      else {
        const before = count(ha);
        const theirs = fm.holdEntries(hb);
        const target = theirs[Math.floor(theirs.length / 2)];
        fm.moveBoundary(ha, hb, bnd, { x: target.cx, y: target.cy });
        if (count(ha) === before) fail('Fronttest: Trenner verschiebt nichts');
        if (!count(ha) || !count(hb)) fail('Fronttest: Trenner nimmt einer Armee alle Grenzfelder');
      }
      // Eine Division der Armee B malt sich ein eigenes Stück und verlässt den Auftrag der Armee
      const d = B.children[0], e = fm.holdEntries(hb)[0];
      fm.paintStroke(d, { x: e.cx, y: e.cy }, { x: e.cx + 1, y: e.cy });
      if (!fm.holdOf(d) || fm.holdOf(d) !== d.front.hold || fm.members(fm.holdOf(B) || { formation: B }).includes(d)) fail('Fronttest: eigene Front einer Division greift nicht');
      // Die Grenze wächst ins neutrale Land: neue Grenzfelder übernehmen ihre Front
      const open0 = fm.openEntries().length;
      for (let s = 0; s < 90 * 30; s++) { fm.update(STEP); g.step(STEP); g.events.length = 0; }
      const now = fm.frontInfo().list;
      const open = fm.openEntries().length;
      if (open > Math.max(open0, now.length * 0.05)) fail(`Fronttest: ${open} von ${now.length} Grenzfeldern ohne Front nach 90 s`);
      // Darstellung: jede Grenzkante gehört zu genau einer Linie
      const edges = fm.edges().reduce((s, l) => s + l.teeth.length, 0);
      if (!fm.edges().length || !edges) fail('Fronttest: keine Frontlinien zum Zeichnen');
    }
  }
  if (!failed) console.log('ok   Fronten: Aufteilen, Trenner, eigene Division, Mitwandern, keine Lücken');
}

// --- Feindliche Städte holen sich kein Land zurück -----------------------------------
{
  // Seite 1 steht vor einer Stadt von Seite 2 und hält das Land ringsum, Seite 2 hat keine
  // Truppen: das Land hinter den eigenen Truppen darf nicht an die Stadt zurückfallen
  // (früher färbte jede Stadt ständig 80 Einheiten um sich ein, auch hinter feindlichen Truppen)
  const g = new Game(realMap('mitteleuropa', 1));
  g.growTimer = Infinity;
  const c = g.cities[g.starts[2]];
  g.units = g.units.filter((u) => u.owner === 1);
  const { w, h } = g.map;
  const dist = (i) => Math.hypot((i % w + 0.5) * CELL - c.x, (Math.floor(i / w) + 0.5) * CELL - c.y);
  for (let i = 0; i < w * h; i++) if (g.map.isLand(i) && dist(i) < 140 && dist(i) > 30) g.territory[i] = 1;
  g.units.forEach((u, k) => { u.x = c.x + 35; u.y = c.y + (k - (g.units.length - 1) / 2) * 15; u.path = []; }); // Linie vor der Stadt
  // hinter den Truppen: näher an ihnen als an der Stadt, aber außer Reichweite ihrer eigenen Färbung
  const near = (i) => Math.min(...g.units.map((u) => Math.hypot((i % w + 0.5) * CELL - u.x, (Math.floor(i / w) + 0.5) * CELL - u.y)));
  const behind = [];
  for (let i = 0; i < w * h; i++) if (g.territory[i] === 1 && dist(i) < CITY_BORDER && near(i) < dist(i) && near(i) > UNIT_BORDER + CELL) behind.push(i);
  for (let s = 0; s < 10 * 30; s++) { g.step(STEP); g.events.length = 0; }
  const lost = behind.filter((i) => g.territory[i] !== 1).length;
  if (!behind.length) fail('Stadt ohne Truppen: Testaufbau ohne Land hinter den Truppen');
  else if (lost) fail(`Stadt ohne Truppen holt sich ${lost} von ${behind.length} Feldern hinter den eigenen Truppen zurück`);
  else console.log(`ok   Feindliche Stadt ohne Truppen nimmt kein Land (${behind.length} Felder geprüft)`);
}

// --- Bündnisende: Ankündigung, Waffenruhe, Räumen, dann Krieg -----------------------
{
  const g = new Game(realMap('mitteleuropa', 1), { players: 3 });
  g.growTimer = Infinity;
  const c2 = g.cities[g.starts[2]];
  g.units = [];
  // Land von Seite 1 gleich neben der Stadt von Seite 2
  let land = null;
  for (let a = 0; a < 6.28 && !land; a += 0.2) {
    const x = c2.x + Math.cos(a) * 150, y = c2.y + Math.sin(a) * 150;
    if ([0.4, 0.7, 1].every((f) => g.map.passableAt(c2.x + (x - c2.x) * f, c2.y + (y - c2.y) * f))) land = { x, y };
  }
  g.paint(1, land.x, land.y, 70);
  const u1 = g.spawnUnit(1, 'light', c2), u2 = g.spawnUnit(2, 'light', c2);
  u2.x = u1.x + 12; u2.y = u1.y;
  const seen = new Set();
  let fought = false; // haben sich die beiden in der Waffenruhe beschossen?
  const run = (sec) => {
    for (let s = 0; s < sec * 30; s++) {
      g.step(STEP);
      if (g.inTruce(1, 2) && (u1.target === u2 || u2.target === u1)) fought = true;
      for (const e of g.events) seen.add(e.type);
      g.events.length = 0;
    }
  };
  g.answerOffer(g.offerAlliance(1, 2).id, true);
  const key = g.pairKey(1, 2);
  run(2);
  g.allySince.set(key, g.time - DIPLOMACY.duration + 30); // noch 30 s
  run(1);
  const warned = seen.has('allianceEnding') && g.allied(1, 2);
  g.allySince.set(key, g.time - DIPLOMACY.duration - 1);
  run(1);
  const truce = seen.has('allianceExpired') && !g.allied(1, 2) && g.inTruce(1, 2) && !g.hostile(1, 2);
  // Seite 2 schickt ihre Kompanie mitten in der Waffenruhe ins Land von Seite 1: zurück
  run(4);
  u2.path = g.map.findPath(u2.x, u2.y, land.x, land.y) || [];
  run(2);
  const end2 = u2.path.length ? u2.path[u2.path.length - 1] : u2;
  const sentBack = g.territory[g.map.cellIndex(end2.x, end2.y)] !== 1;
  run(DIPLOMACY.truce - 10);
  const left = g.territory[g.map.cellIndex(u1.x, u1.y)] === 1;
  const noFight = !fought && u1.hp > 0 && u2.hp > 0;
  run(4);
  const war = seen.has('truceEnded') && g.hostile(1, 2) && !g.inTruce(1, 2);
  if (!warned) fail('Bündnisende: Auslaufen nicht angekündigt');
  else if (!truce) fail('Bündnisende: keine Waffenruhe nach dem Auslaufen');
  else if (!noFight) fail('Bündnisende: in der Waffenruhe wurde gekämpft');
  else if (!left) fail('Bündnisende: Kompanie hat das Land des früheren Verbündeten nicht geräumt');
  else if (!sentBack) fail('Bündnisende: Kompanie darf in der Waffenruhe ins fremde Land marschieren');
  else if (!war) fail('Bündnisende: nach der Waffenruhe kein Krieg');
  else console.log('ok   Bündnisende: Ankündigung, Waffenruhe, Räumen, dann Krieg');
}

// --- Internationaler Verräter: −20 % Verteidigung ----------------------------------
{
  const loss = (traitor) => {
    const g = new Game(realMap('mitteleuropa', 1), { players: 2 });
    g.units = [];
    const c = g.cities[g.starts[1]];
    const a = g.spawnUnit(1, 'light', c, 0), b = g.spawnUnit(2, 'light', c, 0);
    b.x = a.x + 12; b.y = a.y;
    if (traitor) g.betrayedAt[1] = g.time;
    g.step(STEP);
    return { a: a.maxHp - a.hp, b: b.maxHp - b.hp };
  };
  const honest = loss(false), traitor = loss(true);
  const ratio = traitor.a / honest.a;
  if (!(honest.a > 0) || Math.abs(ratio - (1 + DIPLOMACY.traitorDefense)) > 1e-6) fail(`Verräter: Schaden ×${ratio.toFixed(3)} statt ×${1 + DIPLOMACY.traitorDefense}`);
  else if (Math.abs(traitor.b - honest.b) > 1e-9) fail('Verräter: auch der Gegner nimmt mehr Schaden');
  else console.log(`ok   Verräter nimmt ${Math.round(DIPLOMACY.traitorDefense * 100)} % mehr Schaden`);
}

// --- Baumenü: Ausbildung, Vorlagen, Abbruch, Ausrüstung ---------------------------------
{
  const g = new Game(realMap('balkan', 5), { players: 2 });
  const prod = g.production, e = g.eco[1];
  e.money = 5000; e.manpower = 9000; e.mpCap = 20000;
  const home = g.starts[1];
  const before = { money: e.money, manpower: e.manpower };
  const one = prod.order(1, home, 'light');
  if (!one || e.money !== before.money - 30 || e.manpower !== before.manpower - 150) fail('Baumenü: Kompanie wird nicht korrekt bezahlt');
  prod.cancel(one.id);
  if (e.money !== before.money || e.manpower !== before.manpower) fail('Baumenü: Abbruch erstattet die Kosten nicht');
  if (prod.order(1, g.starts[2], 'light')) fail('Baumenü: Ausbildung in einer fremden Stadt möglich');
  if (prod.orderTemplate(1, home, 'mixed') || prod.order(1, home, 'heavy')) fail('Baumenü: Panzer ohne Fabrik ausgebildet');
  g.cities[home].buildings.factory = 1;
  const group = prod.orderTemplate(1, home, 'mixed');
  if (!group || group.length !== 9) fail('Baumenü: Vorlage „Gemischte Division“ bestellt nicht 9 Kompanien');
  for (let s = 0; s < 30 * 120 && prod.ordersOf(1).length; s++) { prod.step(STEP); g.events.length = 0; }
  const div = g.orbat[1].all(DIVISION).at(-1);
  const types = div ? unitsOfDiv(div) : [];
  if (!div || types.length !== 9 || types.filter((t) => t === 'heavy').length !== 3) fail(`Baumenü: Vorlage ergibt ${types.length} Kompanien statt 6 Inf. + 3 Pz.`);
  // Großstadt (Hauptstadt) bildet 3 gleichzeitig aus: 9 Kompanien in 3 Durchgängen
  if (g.time !== 0) fail('Baumenü-Test darf die Spielzeit nicht verändern');
  if (div) {
    if (!prod.upgrade(1, div, 'artillery') || div.equip.artillery !== 1) fail('Baumenü: Artillerie lässt sich nicht verbessern');
    const u = div.children[0].units[0];
    if (Math.abs(u.atk - 1.15) > 1e-9) fail(`Baumenü: Artillerie wirkt nicht (atk ${u.atk})`);
    prod.upgrade(1, div, 'artillery');
    if (prod.upgrade(1, div, 'artillery')) fail('Baumenü: Ausrüstung über die höchste Stufe hinaus');
  }
  // Städte ausbauen: Preis, Bauzeit, nur ein Bau je Stadt, Abbruch, Häfen nur an der Küste
  const city = g.cities[home];
  const m0 = e.money;
  if (!prod.construct(1, home, 'housing') || e.money !== m0 - 120) fail('Städtebau: Wohnviertel wird nicht korrekt bezahlt');
  if (prod.construct(1, home, 'barracks')) fail('Städtebau: zwei Bauten gleichzeitig in einer Stadt');
  const slots0 = prod.citySlots(city);
  for (let s = 0; s < 30 * 25; s++) prod.step(STEP);
  if (city.buildings.housing !== 1 || city.construction) fail('Städtebau: Wohnviertel nach 20 s nicht fertig');
  prod.construct(1, home, 'barracks');
  prod.cancelConstruction(home);
  if (city.construction || e.money !== m0 - 120) fail('Städtebau: Abbruch erstattet nicht');
  prod.construct(1, home, 'barracks');
  for (let s = 0; s < 30 * 16; s++) prod.step(STEP);
  if (prod.citySlots(city) !== slots0 + 1) fail('Städtebau: Kaserne bringt keinen Ausbildungsplatz');
  const inland = g.cities.find((c) => !c.coastal), coast = g.cities.find((c) => c.coastal);
  if (!inland || !coast || prod.nextBuilding(inland, 'port') || !prod.nextBuilding(coast, 'port')) fail('Städtebau: Häfen nicht nur an der Küste');
  if (!failed) console.log('ok   Baumenü und Städtebau: Ausbildung, Vorlagen, Abbruch, Ausrüstung, Gebäude');
}

for (const [seed, size, np] of CASES) {
  const label = `${size} #${seed}`;
  const t0 = performance.now();
  let worst = 0;
  try {
    const g = new Game(realMap(size, seed), { players: np });
    const ais = g.players.map((p) => new AI(g, p, p % 2 ? 'medium' : 'hard'));
    let steps = 0, maxDivs = 0;
    const slots = () => [0, ...g.players.map(() => 0)];
    const formed = slots(), reserve = slots(), attacks = slots(), armies = slots(), alive = slots();
    while (!g.winner && g.time < maxTime(np)) {
      const t = performance.now();
      for (const ai of ais) ai.update(STEP);
      // Prüfen zwischen KI und Spielschritt: dann sind alle Zwischenspeicher dieses Schritts
      // schon berechnet, und die Prüfung verändert den Spielverlauf nicht
      if (++steps % 30 === 0) {
        checkState(g, label, ais);
        maxDivs = Math.max(maxDivs, g.players.reduce((s, p) => s + g.orbat[p].all(DIVISION).length, 0));
        for (const p of g.players) {
          if (!g.alive(p)) continue;
          if (ais[p - 1].fronts.fronts.some((f) => f.attack)) attacks[p]++;
          if (g.units.some((u) => u.owner === p && !u.regiment)) reserve[p]++;
          if (g.units.filter((u) => u.owner === p).length < 14) continue; // zu klein für Front-Divisionen
          alive[p]++;
          if (g.orbat[p].all(DIVISION).length) formed[p]++;
          if (g.orbat[p].all(ARMY).length) armies[p]++;
        }
      }
      g.step(STEP);
      g.events.length = 0;
      worst = Math.max(worst, performance.now() - t);
    }
    if (!g.winner) fail(`${label}: nach ${maxTime(np) / 60} Minuten Spielzeit noch kein Sieger`);
    // Die KI bildet Divisionen für ihre Fronten und behält eine Reserve ohne Division
    // (gemessen über die Zeit, in der die Seite mindestens 14 Kompanien hatte; zu Beginn hat jede nur 4)
    for (const p of g.players) {
      if (alive[p] < 120) continue;
      if (formed[p] < alive[p] * 0.4) fail(`${label}: Seite ${p} hatte nur selten Divisionen (${formed[p]} von ${alive[p]} s)`);
      if (!reserve[p]) fail(`${label}: Seite ${p} hatte nie eine Reserve ohne Division`);
      if (armies[p] < formed[p] * 0.5) fail(`${label}: Seite ${p} fasst ihre Divisionen nicht zu einer Armee zusammen`);
    }
    const ms = (performance.now() - t0) / steps;
    console.log(`${g.winner ? 'ok  ' : '    '} ${label}: Sieger ${g.winner} nach ${Math.round(g.time)} s, ` +
      `${ms.toFixed(2)} ms/Schritt (max ${worst.toFixed(0)} ms), bis zu ${maxDivs} Divisionen, ` +
      `Land ${g.players.map((p) => Math.round(g.share[p] * 100) + '%').join('/')}, ` +
      `Ausgaben ${g.players.map((p) => Math.round(g.eco[p].spent)).join('/')}, ` +
      `Handel ${g.players.map((p) => Math.round(g.eco[p].trade)).join('/')}, ` +
      `Frontangriffe ${g.players.map((p) => attacks[p]).join('/')} s`);
  } catch (e) {
    fail(`${label}: Absturz\n${e.stack}`);
  }
}

if (failed) {
  console.error(`${failed} Fehler`);
  process.exit(1);
}
console.log('Alle Tests bestanden');
