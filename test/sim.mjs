// Test ohne Browser: die KI spielt auf allen Kartengrößen gegen sich selbst.
// Prüft, dass nichts abstürzt, die Partie endet und Gliederung und Positionen stimmig bleiben.
// Aufruf: npm test
import { readFileSync } from 'node:fs';

const v = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const load = (name) => import(new URL(`../js/${name}.js?v=${v}`, import.meta.url));
const { generateMap } = await load('map');
const { Game } = await load('game');
const { AI } = await load('ai');
const { TERRAIN_INFO } = await load('config');
const { REGIMENT, DIVISION, ARMY, DIVISION_MAX, REGIMENT_MAX, strength, divisionOf } = await load('orbat');
const { formationSlots } = await load('formation');
const { FrontManager } = await load('fronts');
const { cycleSelection } = await load('input');
const { KM } = await load('config');

const STEP = 1 / 30;
const MAX_TIME = 20 * 60;   // Sekunden Spielzeit, bis die Partie entschieden sein muss
const CASES = [[1, 'small'], [42, 'medium'], [777, 'large']];

let failed = 0;
const fail = (msg) => { failed++; console.error('  FEHLER: ' + msg); };

const overlapSince = new Map();
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
  // Gliederung: Höchststärken, Regimenter nach Typ getrennt, jede Kompanie in höchstens einem Regiment
  for (let p = 1; p <= 2; p++) {
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
  // Fronten: je Division höchstens eine, nur Kompanien der eigenen Division,
  // Grenzabschnitte einer Seite überlappen sich nicht
  for (const ai of ais) {
    const ranges = ai.fronts.fronts.filter((f) => f.kind !== 'line').map((f) => [f, ...ai.fronts.rangeOf(f)]);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const [fa, a0, a1] = ranges[i], [fb, b0, b1] = ranges[j];
        // kurzzeitig erlaubt: die Frontverwaltung repariert Überlappungen bei der nächsten Neuberechnung
        const key = `${ai.me}:${fa.id}:${fb.id}`;
        if (Math.min(a1, b1) - Math.max(a0, b0) > 40) overlapSince.set(key, (overlapSince.get(key) || 0) + 1);
        else overlapSince.delete(key);
        if (overlapSince.get(key) === 4) fail(`${label}: Grenzabschnitte von ${fa.division.name} und ${fb.division.name} überlappen seit 3 s`);
      }
    }
    const divs = new Set();
    for (const f of ai.fronts.fronts) {
      if (!f.division || f.division.dissolved) fail(`${label}: Front ${f.id} ohne bestehende Division`);
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
  const g = new Game(generateMap(1, 'small'));
  const fm = new FrontManager(g, 1);
  g.orbat[1].autoOrganize(g.units.filter((u) => u.owner === 1));
  fm.splitBorder(g.orbat[1].all(DIVISION));
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

for (const [seed, size] of CASES) {
  const label = `${size} #${seed}`;
  const t0 = performance.now();
  let worst = 0;
  try {
    const g = new Game(generateMap(seed, size));
    const ais = [new AI(g, 1, 'medium'), new AI(g, 2, 'hard')];
    let steps = 0, maxDivs = 0;
    const formed = [0, 0, 0], reserve = [0, 0, 0], attacks = [0, 0, 0], armies = [0, 0, 0];
    while (!g.winner && g.time < MAX_TIME) {
      const t = performance.now();
      for (const ai of ais) ai.update(STEP);
      // Prüfen zwischen KI und Spielschritt: dann sind alle Zwischenspeicher dieses Schritts
      // schon berechnet, und die Prüfung verändert den Spielverlauf nicht
      if (++steps % 30 === 0) {
        checkState(g, label, ais);
        maxDivs = Math.max(maxDivs, g.orbat[1].all(DIVISION).length + g.orbat[2].all(DIVISION).length);
        for (let p = 1; p <= 2; p++) {
          if (g.orbat[p].all(DIVISION).length) formed[p]++;
          if (g.orbat[p].all(ARMY).length) armies[p]++;
          if (g.units.some((u) => u.owner === p && !u.regiment)) reserve[p]++;
          if (ais[p - 1].fronts.fronts.some((f) => f.attack)) attacks[p]++;
        }
      }
      g.step(STEP);
      g.events.length = 0;
      worst = Math.max(worst, performance.now() - t);
    }
    if (!g.winner) fail(`${label}: nach ${MAX_TIME / 60} Minuten Spielzeit noch kein Sieger`);
    // Die KI bildet Divisionen für ihre Fronten und behält eine Reserve ohne Division
    for (let p = 1; p <= 2; p++) {
      if (formed[p] < steps / 30 * 0.5) fail(`${label}: Seite ${p} hatte nur selten Divisionen (${formed[p]} von ${Math.round(steps / 30)} s)`);
      if (!reserve[p]) fail(`${label}: Seite ${p} hatte nie eine Reserve ohne Division`);
      if (armies[p] < formed[p] * 0.5) fail(`${label}: Seite ${p} fasst ihre Divisionen nicht zu einer Armee zusammen`);
    }
    const ms = (performance.now() - t0) / steps;
    console.log(`${g.winner ? 'ok  ' : '    '} ${label}: Sieger ${g.winner} nach ${Math.round(g.time)} s, ` +
      `${ms.toFixed(2)} ms/Schritt (max ${worst.toFixed(0)} ms), bis zu ${maxDivs} Divisionen, ` +
      `Frontangriffe ${attacks[1]}/${attacks[2]} s`);
  } catch (e) {
    fail(`${label}: Absturz\n${e.stack}`);
  }
}

if (failed) {
  console.error(`${failed} Fehler`);
  process.exit(1);
}
console.log('Alle Tests bestanden');
