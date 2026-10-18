import { generateMap } from './map.js?v=33';
import { Game } from './game.js?v=33';
import { AI } from './ai.js?v=33';
import { Renderer } from './render.js?v=33';
import { Input } from './input.js?v=33';
import { FrontManager, chainLength, frontBadge } from './fronts.js?v=33';
import { DIVISION, unitsOf } from './orbat.js?v=33';
import { DIFFICULTY, UNITS_PER_CITY } from './config.js?v=33';

const STEP = 1 / 30;
const $ = (id) => document.getElementById(id);

const app = {
  game: null,
  ai: null,
  renderer: null,
  human: 1,
  cam: { x: 0, y: 0, zoom: 1, min: 0.2, max: 6 },
  ui: { selection: new Set(), drawPath: null, box: null, revealAll: false, selectMode: false, frontMode: null, front: null },
  paused: false,
  speed: 1,
  settings: loadSettings(),
  lastHud: 0,

  start(seed, size, difficulty) {
    const map = generateMap(seed, size);
    this.game = new Game(map);
    this.ai = new AI(this.game, 2, difficulty);
    this.fronts = new FrontManager(this.game, this.human);
    this.ui.frontMode = null;
    this.ui.front = null;
    this.updateFrontPanel();
    this.renderer = new Renderer(canvas, this.game, this.human);
    this.ui.selection.clear();
    this.ui.revealAll = false;
    this.paused = false;
    this.setSpeed(1);
    this.current = { seed, size, difficulty };
    this.settings = { size, difficulty };
    saveSettings(this.settings);
    this.divBarSig = null;
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
    this.cam.min = Math.min(fit * 0.6, 0.15); // weit genug für Korps- und Armeeansicht
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
    for (const u of this.ui.selection) { this.fronts.release(u); u.path = []; }
    this.updateFrontPanel();
  },

  // Manueller Befehl: Einheit verlässt ihre Front
  release(u) {
    if (u.front) { this.fronts.release(u); this.updateFrontPanel(); }
  },

  setFrontMode(mode) {
    this.ui.frontMode = mode;
    $('frontBtn').classList.toggle('active', !!mode);
    $('frontBanner').hidden = !mode;
    if (mode) {
      $('frontBanner').firstElementChild.textContent = mode === 'new'
        ? 'Front zeichnen: Linie mit dem Finger ziehen'
        : 'Angriffsziel: Linie ziehen, bis wohin die Front vorstoßen soll';
    }
  },

  finishFront(line) {
    const mode = this.ui.frontMode;
    this.setFrontMode(null);
    if (chainLength(line) < 30) {
      this.toast('Linie zu kurz – nochmal versuchen');
      return;
    }
    if (mode && mode.plan) {
      this.fronts.planAttack(mode.plan, line);
      this.selectFront(mode.plan);
      this.toast('Angriff geplant – „▶ Angriff starten“ drücken');
      return;
    }
    const f = this.fronts.create('line', line, [...this.ui.selection]);
    this.ui.selection.clear();
    this.updateSelectionInfo();
    this.selectFront(f);
    this.toast(f.units.length ? `Front mit ${f.units.length} Einheiten erstellt` : 'Front erstellt – neue Einheiten rücken nach');
  },

  borderFront() {
    const units = [...this.ui.selection];
    let f = this.fronts.fronts.find((o) => o.kind === 'border');
    if (f) this.fronts.add(f, units);
    else f = this.fronts.create('border', null, units);
    this.ui.selection.clear();
    this.updateSelectionInfo();
    this.selectFront(f);
    this.toast(f.chains.length ? `Grenzfront: ${f.units.length} Einheiten` : 'Keine Grenze zum Gegner gefunden');
  },

  selectFront(f) {
    this.ui.front = f;
    this.updateFrontPanel();
  },

  pickFrontBadge(w) {
    const tol = Math.max(8, 14 / this.cam.zoom);
    for (const f of this.fronts.fronts) {
      const b = frontBadge(f);
      if (b && Math.hypot(b.x - w.x, b.y - w.y) < tol * 1.3) return f;
    }
    return null;
  },

  pickFront(w) {
    const tol = Math.max(8, 14 / this.cam.zoom);
    const badge = this.pickFrontBadge(w);
    if (badge) return badge;
    for (const f of this.fronts.fronts) {
      for (const c of f.chains) {
        for (let i = 1; i < c.length; i++) if (segDist(w, c[i - 1], c[i]) < tol * 0.7) return f;
      }
    }
    return null;
  },

  updateFrontPanel() {
    const f = this.ui.front;
    if (f && !this.fronts.fronts.includes(f)) this.ui.front = null;
    const cur = this.ui.front;
    $('frontPanel').hidden = !cur;
    if (!cur) return;
    $('frontTitle').textContent = `${cur.kind === 'border' ? 'Grenzfront' : 'Front'} · ${cur.units.length} Einheiten`;
    $('planBtn').hidden = !!cur.plan;
    $('planBtn').textContent = cur.attack ? '➜ Neues Ziel' : '➜ Angriff planen';
    $('attackBtn').hidden = !cur.plan;
    $('cancelPlanBtn').hidden = !cur.plan;
    $('reinforceBtn').classList.toggle('active', cur.reinforce);
    $('rotateBtn').classList.toggle('active', cur.rotate);
    $('addBtn').hidden = !this.ui.selection.size;
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
        this.release(u);
        u.path = p;
        u.stuck = 0;
      }
    }
  },

  updateSelectionInfo() {
    const n = this.ui.selection.size;
    $('selInfo').textContent = n ? `${n} ausgewählt` : '';
    $('deselectBtn').hidden = !n;
    if (this.fronts) this.updateFrontPanel();
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
      if (ev.type === 'death') {
        this.ui.selection.delete(ev.unit);
        if (ev.unit.front) this.fronts.release(ev.unit);
      } else if (ev.type === 'spawn' && ev.unit.owner === this.human) {
        this.fronts.onSpawn(ev.unit);
      }
      else if (ev.type === 'capture') {
        if (ev.owner === this.human) this.toast(ev.old ? 'Feindliche Stadt erobert!' : 'Neutrale Stadt eingenommen!', 'good');
        else if (ev.old === this.human) this.toast('Eine Stadt ist gefallen!', 'bad');
      } else if (ev.type === 'gameover') this.showEnd(ev.winner);
    }
    g.events.length = 0;
    for (const ev of this.fronts.events) {
      if (ev.type === 'attackDone') this.toast('Angriffsziel erreicht – die Front hält die neue Linie', 'good');
    }
    this.fronts.events.length = 0;
    this.ai.events.length = 0; // Angriffspläne der KI bleiben geheim
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

  // Divisionsleiste: je eigene Division eine Karte mit Symbol, Name, Stärke und Regimentern
  updateDivBar() {
    const g = this.game;
    const bar = $('divBar');
    const divs = g.orbat[this.human].all(DIVISION)
      .map((f) => ({ f, units: unitsOf(f).filter((u) => g.units.includes(u)) }))
      .filter((d) => d.units.length);
    const sig = divs.map((d) => d.f.id + ':' + d.units.length + ':' + Math.round(strengthOf(d.units) * 20) + ':' +
      (d.units.some((u) => this.ui.selection.has(u)) ? 1 : 0)).join('|');
    if (sig === this.divBarSig) return;
    this.divBarSig = sig;
    bar.innerHTML = divs.map((d) => {
      const heavy = d.units.filter((u) => u.type === 'heavy').length / d.units.length;
      const regs = [];
      for (const brig of d.f.children) {
        for (const reg of brig.children) {
          const alive = reg.units.filter((u) => g.units.includes(u));
          const armor = reg.units.some((u) => u.type === 'heavy');
          regs.push(natoIcon(armor ? 1 : 0, 16, 11, alive.length ? 0.35 + 0.65 * alive.length / 2 : 0.15));
        }
      }
      const sel = d.units.some((u) => this.ui.selection.has(u)) ? ' sel' : '';
      return `<button class="divcard${sel}" data-id="${d.f.id}" title="${d.f.name}: ${d.units.length} Kompanien">` +
        `<span class="sym">${natoIcon(heavy, 26, 18, 1, 'XX')}</span>` +
        `<span class="name">${d.f.name}</span>` +
        `<span class="str"><i style="width:${Math.round(strengthOf(d.units) * 100)}%"></i></span>` +
        `<span class="regs">${regs.join('')}</span></button>`;
    }).join('');
  },

  selectDivision(id) {
    const g = this.game;
    const f = g.orbat[this.human].all(DIVISION).find((d) => d.id === id);
    if (!f) return;
    const units = unitsOf(f).filter((u) => g.units.includes(u));
    if (!units.length) return;
    this.ui.selection.clear();
    for (const u of units) this.ui.selection.add(u);
    this.updateSelectionInfo();
    const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
    const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
    this.cam.x = cx - canvas.clientWidth / 2 / this.cam.zoom;
    this.cam.y = cy - canvas.clientHeight / 2 / this.cam.zoom;
    this.clampCamera();
    this.divBarSig = null;
  },

  updateHud() {
    const g = this.game;
    this.updateDivBar();
    const myC = g.citiesOf(this.human).length, aiC = g.citiesOf(2).length;
    const neutral = g.cities.length - myC - aiC;
    const myU = g.unitsOf(this.human).length;
    $('hudCities').innerHTML =
      `<span class="dot blue"></span>${myC} <span class="muted">Städte</span>` +
      ` <span class="dot red"></span>${aiC}` + (neutral ? ` <span class="dot grey"></span>${neutral}` : '');
    $('hudUnits').innerHTML = `${myU}<span class="muted">/${myC * UNITS_PER_CITY} Einheiten</span>`;
    const m = Math.floor(g.time / 60), s = Math.floor(g.time % 60);
    $('hudTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (this.ui.front) this.updateFrontPanel();
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
        app.fronts.update(STEP);
        app.game.step(STEP);
        acc -= STEP;
        steps++;
      }
      if (steps === 12) acc = 0;
    }
    app.handleEvents();
    app.renderer.draw(app.cam, app.ui, app.fronts, app.ai.fronts);
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
$('divBar').onclick = (e) => {
  const card = e.target.closest('.divcard');
  if (card) app.selectDivision(+card.dataset.id);
};
$('frontBtn').onclick = () => app.setFrontMode(app.ui.frontMode ? null : 'new');
$('borderBtn').onclick = () => app.borderFront();
$('planBtn').onclick = () => app.setFrontMode({ plan: app.ui.front });
$('attackBtn').onclick = () => {
  app.fronts.startAttack(app.ui.front);
  app.toast('Angriff läuft!', 'good');
  app.updateFrontPanel();
};
$('cancelPlanBtn').onclick = () => { app.fronts.cancelPlan(app.ui.front); app.updateFrontPanel(); };
$('reinforceBtn').onclick = () => { app.ui.front.reinforce = !app.ui.front.reinforce; app.updateFrontPanel(); };
$('rotateBtn').onclick = () => { app.ui.front.rotate = !app.ui.front.rotate; app.updateFrontPanel(); };
$('addBtn').onclick = () => {
  app.fronts.add(app.ui.front, [...app.ui.selection]);
  app.ui.selection.clear();
  app.updateSelectionInfo();
};
$('disbandBtn').onclick = () => {
  for (const u of app.ui.front.units) u.path = [];
  app.fronts.remove(app.ui.front);
  app.selectFront(null);
};
$('frontCancel').onclick = () => app.setFrontMode(null);
$('frontClose').onclick = () => app.selectFront(null);
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

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

function strengthOf(units) {
  let hp = 0, max = 0;
  for (const u of units) { hp += u.hp; max += u.maxHp; }
  return max ? hp / max : 0;
}

// Kleines NATO-Symbol als SVG: X = Infanterie, Oval = Panzer, beides bei gemischten Verbänden
function natoIcon(armorShare, w, h, opacity = 1, echelon = '') {
  const top = echelon ? 6 : 1;
  const H = h + top;
  const inf = armorShare < 0.67, arm = armorShare > 0.33;
  const rx = 1, ry = top, rw = w - 2, rh = h - 2;
  let inner = '';
  if (inf) inner += `<path d="M${rx} ${ry}L${rx + rw} ${ry + rh}M${rx + rw} ${ry}L${rx} ${ry + rh}" stroke="#000" stroke-width="1"/>`;
  if (arm) inner += `<ellipse cx="${w / 2}" cy="${ry + rh / 2}" rx="${rw * 0.31}" ry="${rh * 0.25}" fill="none" stroke="#000" stroke-width="1"/>`;
  let ech = '';
  if (echelon === 'XX') {
    for (const cx of [w / 2 - 3, w / 2 + 3]) ech += `<path d="M${cx - 2} 0.5L${cx + 2} 4.5M${cx + 2} 0.5L${cx - 2} 4.5" stroke="#fff" stroke-width="1"/>`;
  }
  return `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" style="opacity:${opacity.toFixed(2)}">${ech}` +
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#80e0ff" stroke="#000" stroke-width="1"/>${inner}</svg>`;
}
