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
const { REGIMENT } = await load('orbat');

const STEP = 1 / 30;
const MAX_TIME = 20 * 60;   // Sekunden Spielzeit, bis die Partie entschieden sein muss
const CASES = [[1, 'small'], [42, 'medium'], [777, 'large']];

let failed = 0;
const fail = (msg) => { failed++; console.error('  FEHLER: ' + msg); };

function checkState(g, label) {
  // Keine Einheit dauerhaft auf unbegehbarem Gelände
  for (const u of g.units) {
    const t = g.map.cellTerrainAt(u.x, u.y);
    if (!TERRAIN_INFO[t].passable) u.badTime = (u.badTime || 0) + 1; else u.badTime = 0;
    if (u.badTime > 10) { fail(`${label}: Einheit ${u.id} steckt auf unbegehbarem Gelände (${u.x.toFixed(0)}, ${u.y.toFixed(0)})`); u.badTime = -1e9; }
  }
  // Gliederung: jede lebende Kompanie gehört zu genau einem Regiment
  for (let p = 1; p <= 2; p++) {
    const seen = new Map();
    for (const reg of g.orbat[p].all(REGIMENT)) {
      for (const u of reg.units) {
        if (!g.units.includes(u)) continue;
        if (seen.has(u)) fail(`${label}: Kompanie ${u.id} steht in zwei Regimentern`);
        seen.set(u, reg);
        if (u.regiment !== reg) fail(`${label}: Kompanie ${u.id} verweist auf ein anderes Regiment`);
      }
    }
    for (const u of g.units) {
      if (u.owner === p && u.regiment && !seen.has(u)) fail(`${label}: Kompanie ${u.id} fehlt in ihrem Regiment`);
    }
  }
}

for (const [seed, size] of CASES) {
  const label = `${size} #${seed}`;
  const t0 = performance.now();
  let worst = 0;
  try {
    const g = new Game(generateMap(seed, size));
    const ais = [new AI(g, 1, 'medium'), new AI(g, 2, 'hard')];
    let steps = 0;
    while (!g.winner && g.time < MAX_TIME) {
      const t = performance.now();
      for (const ai of ais) ai.update(STEP);
      g.step(STEP);
      g.events.length = 0;
      worst = Math.max(worst, performance.now() - t);
      if (++steps % 30 === 0) checkState(g, label);
    }
    if (!g.winner) fail(`${label}: nach ${MAX_TIME / 60} Minuten Spielzeit noch kein Sieger`);
    const ms = (performance.now() - t0) / steps;
    console.log(`${g.winner ? 'ok  ' : '    '} ${label}: Sieger ${g.winner} nach ${Math.round(g.time)} s, ` +
      `${ms.toFixed(2)} ms/Schritt (max ${worst.toFixed(0)} ms)`);
  } catch (e) {
    fail(`${label}: Absturz\n${e.stack}`);
  }
}

if (failed) {
  console.error(`${failed} Fehler`);
  process.exit(1);
}
console.log('Alle Tests bestanden');
