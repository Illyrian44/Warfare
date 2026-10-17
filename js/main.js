import { generateMap } from './map.js';
import { Game } from './game.js';
import { AI } from './ai.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { DIFFICULTY, UNITS_PER_CITY } from './config.js';

const STEP = 1 / 30;
const $ = (id) => document.getElementById(id);

const app = {
  game: null,
  ai: null,
  renderer: null,
  human: 1,
  cam: { x: 0, y: 0, zoom: 1, min: 0.2, max: 6 },
  ui: { selection: new Set(), drawPath: null, box: null, revealAll: false, selectMode: false },
  paused: false,
  speed: 1,
  settings: loadSettings(),
  lastHud: 0,

  start(seed, size, difficulty) {
    const map = generateMap(seed, size);
    this.game = new Game(map);
    this.ai = new AI(this.game, 2, difficulty);
    this.renderer = new Renderer(canvas, this.game, this.human);
    this.ui.selection.clear();
    this.ui.revealAll = false;
    this.paused = false;
    this.setSpeed(1);
    this.current = { seed, size, difficulty };
    this.settings = { size, difficulty };
    saveSettings(this.settings);
    this.fitCamera();
    $('menu').hidden = true;
    $('end').hidden = true;
    $('hud').hidden = false;
    $('pauseBtn').textContent = '❚❚';
    $('pausedBanner').hidden = true;
    $('resumeBtn').hidden = true;
    $('seedLabel').textContent = `Karte #${seed} · ${DIFFICULTY[difficulty].name}`;
    this.updateSelectionInfo();
    this.toast('Ziehe von einer deiner Einheiten aus einen Weg. Erobere alle Städte!');
  },

  fitCamera() {
    const { worldW, worldH } = this.game.map;
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const fit = Math.min(vw / worldW, vh / worldH);
    this.cam.min = fit * 0.6;
    this.cam.max = 8;
    // Auf die eigene Seite zoomen, wenn der Bildschirm klein ist
    const mine = this.game.citiesOf(this.human);
    if (vw < 700 && mine.length) {
      // Hochformat: die eigene Kartenhälfte füllt die Breite
      this.cam.zoom = Math.max(fit, Math.min(vw / (worldW * 0.55), vh / worldH));
      const cx = mine.reduce((a, c) => a + c.x, 0) / mine.length;
      const cy = mine.reduce((a, c) => a + c.y, 0) / mine.length;
      this.cam.x = cx - vw / 2 / this.cam.zoom;
      this.cam.y = cy - vh / 2 / this.cam.zoom;
    } else {
      this.cam.zoom = fit * 0.98;
      this.cam.x = worldW / 2 - vw / 2 / this.cam.zoom;
      this.cam.y = worldH / 2 - vh / 2 / this.cam.zoom;
    }
    this.clampCamera();
  },

  zoomAt(sx, sy, factor) {
    const cam = this.cam;
    const wx = sx / cam.zoom + cam.x, wy = sy / cam.zoom + cam.y;
    cam.zoom = Math.min(cam.max, Math.max(cam.min, cam.zoom * factor));
    cam.x = wx - sx / cam.zoom;
    cam.y = wy - sy / cam.zoom;
    this.clampCamera();
  },

  clampCamera() {
    if (!this.game) return;
    const cam = this.cam;
    const { worldW, worldH } = this.game.map;
    const vw = canvas.clientWidth / cam.zoom, vh = canvas.clientHeight / cam.zoom;
    const clampAxis = (v, view, world) =>
      view >= world ? (world - view) / 2 : Math.min(world - view * 0.5, Math.max(-view * 0.5, v));
    cam.x = clampAxis(cam.x, vw, worldW);
    cam.y = clampAxis(cam.y, vh, worldH);
  },

  togglePause() {
    if (!this.game || this.game.winner) return;
    this.paused = !this.paused;
    $('pauseBtn').textContent = this.paused ? '▶' : '❚❚';
    $('pausedBanner').hidden = !this.paused;
  },

  setSpeed(s) {
    this.speed = s;
    $('speedBtn').textContent = `${s}×`;
  },

  selectAll() {
    for (const u of this.game.units) if (u.owner === this.human) this.ui.selection.add(u);
    this.updateSelectionInfo();
  },

  stopSelection() {
    for (const u of this.ui.selection) u.path = [];
  },

  setSelectMode(on) {
    this.ui.selectMode = on;
    $('selectBtn').classList.toggle('active', on);
  },

  moveSelectionTo(w) {
    const units = [...this.ui.selection];
    if (!units.length) return;
    const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
    const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
    // Formation beibehalten, aber zusammenziehen
    let spread = 0;
    for (const u of units) spread = Math.max(spread, Math.hypot(u.x - cx, u.y - cy));
    const maxSpread = 10 + Math.sqrt(units.length) * 11;
    const k = spread > maxSpread ? maxSpread / spread : 1;
    const cache = new Map();
    for (const u of units) {
      const tx = w.x + (u.x - cx) * k, ty = w.y + (u.y - cy) * k;
      const key = `${u.x / 30 | 0},${u.y / 30 | 0}`;
      let base = cache.get(key);
      if (base === undefined) {
        base = this.game.map.findPath(u.x, u.y, tx, ty);
        cache.set(key, base);
      }
      if (base && base.length) {
        const p = base.map((q) => ({ x: q.x, y: q.y }));
        p[p.length - 1] = { x: tx, y: ty };
        u.path = p;
        u.stuck = 0;
      }
    }
  },

  updateSelectionInfo() {
    const n = this.ui.selection.size;
    $('selInfo').textContent = n ? `${n} ausgewählt` : '';
    $('deselectBtn').hidden = !n;
  },

  toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  },

  handleEvents() {
    const g = this.game;
    for (const ev of g.events) {
      if (ev.type === 'death') this.ui.selection.delete(ev.unit);
      else if (ev.type === 'capture') {
        if (ev.owner === this.human) this.toast(ev.old ? 'Feindliche Stadt erobert!' : 'Neutrale Stadt eingenommen!', 'good');
        else if (ev.old === this.human) this.toast('Eine Stadt ist gefallen!', 'bad');
      } else if (ev.type === 'gameover') this.showEnd(ev.winner);
    }
    g.events.length = 0;
  },

  showEnd(winner) {
    const g = this.game;
    const won = winner === this.human;
    this.ui.revealAll = true;
    $('endTitle').textContent = won ? 'Sieg!' : 'Niederlage';
    $('endTitle').className = won ? 'good' : 'bad';
    const m = Math.floor(g.time / 60), s = Math.floor(g.time % 60);
    const st = g.stats[this.human];
    $('endStats').innerHTML =
      `Spielzeit: ${m}:${String(s).padStart(2, '0')}<br>` +
      `Einheiten gebaut: ${st.built} · verloren: ${st.lost}<br>` +
      `Städte erobert: ${st.captured}`;
    $('end').hidden = false;
  },

  updateHud() {
    const g = this.game;
    const myC = g.citiesOf(this.human).length, aiC = g.citiesOf(2).length;
    const neutral = g.cities.length - myC - aiC;
    const myU = g.unitsOf(this.human).length;
    $('hudCities').innerHTML =
      `<span class="dot blue"></span>${myC} <span class="muted">Städte</span>` +
      ` <span class="dot red"></span>${aiC}` + (neutral ? ` <span class="dot grey"></span>${neutral}` : '');
    $('hudUnits').innerHTML = `${myU}<span class="muted">/${myC * UNITS_PER_CITY} Einheiten</span>`;
    const m = Math.floor(g.time / 60), s = Math.floor(g.time % 60);
    $('hudTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
  },
};

const canvas = $('game');

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  app.clampCamera();
}
window.addEventListener('resize', resize);
resize();

new Input(canvas, app);

let last = performance.now();
let acc = 0;
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (app.game) {
    if (!app.paused && !app.game.winner) {
      acc += dt * app.speed;
      let steps = 0;
      while (acc >= STEP && steps < 12) {
        app.ai.update(STEP);
        app.game.step(STEP);
        acc -= STEP;
        steps++;
      }
      if (steps === 12) acc = 0;
    }
    app.handleEvents();
    app.renderer.draw(app.cam, app.ui);
    if (now - app.lastHud > 250) { app.updateHud(); app.lastHud = now; }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Menü
function randomSeed() { return Math.floor(Math.random() * 99999) + 1; }

function setupChoice(groupId, value) {
  const group = $(groupId);
  for (const b of group.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.value === value);
    b.onclick = () => {
      for (const o of group.querySelectorAll('button')) o.classList.remove('active');
      b.classList.add('active');
    };
  }
}
const choice = (groupId) => $(groupId).querySelector('button.active').dataset.value;

setupChoice('diffChoice', app.settings.difficulty || 'medium');
setupChoice('sizeChoice', app.settings.size || 'medium');
$('seedInput').value = randomSeed();
$('seedRandom').onclick = () => { $('seedInput').value = randomSeed(); };
$('startBtn').onclick = () => {
  const seed = Math.max(1, parseInt($('seedInput').value, 10) || randomSeed());
  app.start(seed, choice('sizeChoice'), choice('diffChoice'));
};
$('pauseBtn').onclick = () => app.togglePause();
$('speedBtn').onclick = () => app.setSpeed(app.speed >= 3 ? 1 : app.speed + 1);
$('helpBtn').onclick = () => { $('help').hidden = false; if (!app.paused) app.togglePause(); };
$('helpClose').onclick = () => { $('help').hidden = true; if (app.paused) app.togglePause(); };
$('menuHelpBtn').onclick = () => { $('help').hidden = false; };
$('menuBtn').onclick = () => {
  if (!app.paused) app.togglePause();
  $('seedInput').value = randomSeed();
  $('menu').hidden = false;
  $('resumeBtn').hidden = false;
};
$('resumeBtn').onclick = () => { $('menu').hidden = true; if (app.paused) app.togglePause(); };
$('selectBtn').onclick = () => app.setSelectMode(!app.ui.selectMode);
$('allBtn').onclick = () => app.selectAll();
$('deselectBtn').onclick = () => { app.ui.selection.clear(); app.updateSelectionInfo(); };
$('centerBtn').onclick = () => app.fitCamera();
$('againBtn').onclick = () => app.start(app.current.seed, app.current.size, app.current.difficulty);
$('newBtn').onclick = () => app.start(randomSeed(), app.current.size, app.current.difficulty);
$('endMenuBtn').onclick = () => { $('end').hidden = true; $('menu').hidden = false; $('resumeBtn').hidden = true; };

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('wod-settings')) || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem('wod-settings', JSON.stringify(s)); } catch { /* egal */ }
}

window.wod = app; // zum Debuggen in der Konsole
