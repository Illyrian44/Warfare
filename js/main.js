import { generateMap } from './map.js?v=64';
import { Game } from './game.js?v=64';
import { AI } from './ai.js?v=64';
import { Renderer, isFrontShown } from './render.js?v=64';
import { Input } from './input.js?v=64';
import { FrontManager, chainLength, frontBadge } from './fronts.js?v=64';
import { DIVISION, DIVISION_MAX, REGIMENT_MAX, unitsOf, divisionColor, divisionOf, strength } from './orbat.js?v=64';
import { DIFFICULTY, UNITS_PER_CITY, SUPPLY, KM, CELL } from './config.js?v=64';

const STEP = 1 / 30;
const $ = (id) => document.getElementById(id);

const app = {
  game: null,
  ai: null,
  renderer: null,
  human: 1,
  cam: { x: 0, y: 0, zoom: 1, min: 0.2, max: 6 },
  ui: { selection: new Set(), drawPath: null, box: null, revealAll: false, selectMode: false, frontMode: null, front: null, showFronts: false, showSupply: false },
  paused: false,
  speed: 1,
  settings: loadSettings(),
  lastHud: 0,

  start(seed, size, difficulty) {
    let map;
    try {
      map = generateMap(seed, size);
    } catch {
      $('menuError').textContent = `Karte #${seed} ließ sich nicht erzeugen – bitte eine andere Karten-Nummer wählen.`;
      $('menuError').hidden = false;
      $('end').hidden = true;
      $('menu').hidden = false;
      return;
    }
    $('menuError').hidden = true;
    this.game = new Game(map);
    this.ai = new AI(this.game, 2, difficulty);
    this.fronts = new FrontManager(this.game, this.human);
    this.ui.frontMode = null;
    this.ui.front = null;
    this.updateFrontPanel();
    this.renderer = new Renderer(canvas, this.game, this.human);
    this.ui.selection.clear();
    this.ui.revealAll = false;
    this.ui.showFronts = false;
    $('showFrontsBtn').classList.remove('active');
    this.ui.showSupply = false;
    $('supplyBtn').classList.remove('active');
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
    this.toast('Deine Kompanien haben noch keine Division: auswählen und „＋ Neue Division“ – oder unten „Auto-Gliederung“.');
  },

  fitCamera() {
    const { worldW, worldH } = this.game.map;
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const fit = Math.min(vw / worldW, vh / worldH);
    this.cam.min = Math.min(fit * 0.6, 0.15); // weit genug für den Überblick über die ganze Insel
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

  // mode: { divs } = Front für Divisionen zeichnen, { plan: front } = Angriffsziel ziehen
  setFrontMode(mode) {
    this.ui.frontMode = mode;
    $('frontBtn').classList.toggle('active', !!mode);
    $('frontBanner').hidden = !mode;
    if (mode) {
      $('frontBanner').firstElementChild.textContent = !mode.divs
        ? 'Angriffsziel: Linie ziehen, bis wohin die Front vorstoßen soll'
        : mode.divs.length === 1
          ? `Front für ${mode.divs[0].name} zeichnen: Linie ziehen`
          : `Front für ${mode.divs.length} Divisionen zeichnen – sie teilen sich die Linie`;
    }
  },

  toggleFrontMode() {
    if (this.ui.frontMode) { this.setFrontMode(null); return; }
    const divs = this.frontDivisions();
    if (divs) this.setFrontMode({ divs });
  },

  // Die ganze Auswahl gehört zu genau einer Division (sonst null)
  selectedDivision() {
    const divs = new Set(this.ownSelection().map(divisionOf));
    return divs.size === 1 ? [...divs][0] : null;
  },

  // Divisionen, die eine Front bekommen sollen: alle Divisionen in der Auswahl
  // (Kompanien ohne Division zählen nicht)
  frontDivisions() {
    const sel = this.ownSelection();
    const divs = [...new Set(sel.map(divisionOf).filter(Boolean))];
    if (divs.length) return divs;
    if (!sel.length) this.toast('Erst eine Division auswählen – unten in der Divisionsleiste oder auf der Karte');
    else this.toast('Kompanien ohne Division können keine Front halten – erst eine Division bilden');
    return null;
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
    const divs = ((mode && mode.divs) || []).filter((d) => !d.dissolved);
    if (!divs.length) return;
    // Nahe der Grenze rastet die Linie ein und wird zum Grenzabschnitt
    const anchors = this.fronts.snapToBorder(line);
    const made = anchors
      ? (divs.length > 1 ? this.fronts.splitBorder(divs, anchors) : [this.fronts.assign(divs[0], 'segment', null, anchors)])
      : (divs.length > 1 ? this.fronts.splitLine(divs, line) : [this.fronts.assign(divs[0], 'line', line)]);
    if (made.length === 1) this.selectFront(made[0]);
    this.divBarSig = null;
    const what = anchors ? 'den Grenzabschnitt' : 'die neue Front';
    this.toast(divs.length > 1 ? `${divs.length} Divisionen teilen sich ${what}` : `${divs[0].name} hält ${what}`);
  },

  // Grenze: eine Division hält die ganze Grenze, mehrere teilen sie sich nach Stärke
  borderFront() {
    const divs = this.frontDivisions();
    if (!divs) return;
    const made = divs.length > 1 ? this.fronts.splitBorder(divs) : [this.fronts.assign(divs[0], 'border', null)];
    if (made.length === 1) this.selectFront(made[0]);
    this.divBarSig = null;
    if (!made.length || !made[0].chains.length) this.toast('Keine Grenze zum Gegner gefunden');
    else this.toast(divs.length > 1 ? `${divs.length} Divisionen teilen sich die Grenze` : `${divs[0].name} hält die Grenze`);
  },

  selectFront(f) {
    this.ui.front = f;
    this.updateFrontPanel();
  },

  // Kartenebene „Nachschub“ ein- oder ausblenden
  toggleSupply() {
    this.ui.showSupply = !this.ui.showSupply;
    $('supplyBtn').classList.toggle('active', this.ui.showSupply);
  },

  // Alle eigenen Fronten ein- oder ausblenden
  toggleShowFronts() {
    this.ui.showFronts = !this.ui.showFronts;
    $('showFrontsBtn').classList.toggle('active', this.ui.showFronts);
  },

  // Nur sichtbare Fronten lassen sich antippen
  pickFrontBadge(w) {
    const tol = Math.max(8, 14 / this.cam.zoom);
    for (const f of this.fronts.fronts) {
      if (!isFrontShown(f, this.ui)) continue;
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
      if (!isFrontShown(f, this.ui)) continue;
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
    const kind = cur.kind === 'border' ? 'Grenzfront' : cur.kind === 'segment' ? 'Grenzabschnitt' : 'Front';
    $('frontTitle').textContent = `${cur.division.name} · ${kind} · ${cur.units.length} Kompanien`;
    $('planBtn').hidden = !!cur.plan;
    $('planBtn').textContent = cur.attack ? '➜ Neues Ziel' : '➜ Angriff planen';
    $('attackBtn').hidden = !cur.plan;
    $('cancelPlanBtn').hidden = !cur.plan;
    $('rotateBtn').classList.toggle('active', cur.rotate);
    const off = this.fronts.detached(cur);
    $('rejoinBtn').hidden = !off;
    $('rejoinBtn').textContent = `↺ ${off} zurück an die Front`;
  },

  // Eigene, lebende Einheiten der Auswahl
  ownSelection() {
    return [...this.ui.selection].filter((u) => u.owner === this.human && u.hp > 0);
  },

  newDivision() {
    const units = this.ownSelection();
    if (!units.length) return;
    const div = this.game.orbat[this.human].createDivision(units);
    this.afterOrbatChange();
    this.toast(units.length > DIVISION_MAX
      ? `${div.name} gebildet – nur ${DIVISION_MAX} Kompanien passen hinein`
      : `${div.name} gebildet (${strength(div)} Kompanien)`);
  },

  addToDivision(id) {
    const ob = this.game.orbat[this.human];
    const div = ob.all(DIVISION).find((d) => d.id === id);
    if (!div) return;
    const units = this.ownSelection().filter((u) => divisionOf(u) !== div);
    if (!units.length) return;
    const n = ob.add(div, units);
    this.afterOrbatChange();
    this.toast(n < units.length
      ? `${n} von ${units.length} Kompanien zur ${div.name} – die Division ist voll (${DIVISION_MAX})`
      : `${n} Kompanien zur ${div.name}`);
  },

  removeFromDivision() {
    const units = this.ownSelection().filter((u) => u.regiment);
    if (!units.length) return;
    this.game.orbat[this.human].remove(units);
    this.afterOrbatChange();
    this.toast(`${units.length} Kompanien ohne Division`);
  },

  autoOrganize() {
    const made = this.game.orbat[this.human].autoOrganize(this.game.units);
    this.afterOrbatChange();
    const loose = this.game.units.filter((u) => u.owner === this.human && !u.regiment).length;
    this.toast(`Auto-Gliederung: ${made.length} neue Divisionen` + (loose ? ` · ${loose} Kompanien bleiben ohne Division` : ''));
  },

  toggleRefill(id) {
    const div = this.game.orbat[this.human].all(DIVISION).find((d) => d.id === id);
    if (!div) return;
    div.refill = !div.refill;
    this.afterOrbatChange();
    this.toast(div.refill ? `${div.name} wird mit neuen Kompanien aufgefüllt` : `${div.name}: Auffüllen aus`);
  },

  afterOrbatChange() {
    this.game.hq.place();
    this.fronts.syncAll();
    this.divBarSig = null;
    this.updateSelectionInfo();
  },

  // „Auffüllen“: neue Kompanie geht an die nächste Division mit freiem Platz und rückt
  // zu ihr (oder an ihre Front) nach
  refill(u) {
    const ob = this.game.orbat[this.human];
    const div = ob.refillFor(u);
    if (!div) return false;
    const mates = unitsOf(div).filter((o) => o !== u);
    ob.add(div, [u]);
    if (this.fronts.fronts.includes(div.front)) {
      // Die Front der Division übernimmt die neue Kompanie
      this.fronts.sync(div.front);
      this.fronts.schedule(div.front);
    } else if (mates.length) {
      const cx = mates.reduce((a, o) => a + o.x, 0) / mates.length;
      const cy = mates.reduce((a, o) => a + o.y, 0) / mates.length;
      u.path = this.game.map.findPath(u.x, u.y, cx, cy) || [];
    }
    this.divBarSig = null;
    return true;
  },

  setSelectMode(on) {
    this.ui.selectMode = on;
    $('selectBtn').classList.toggle('active', on);
  },

  // Bewegen zum Zielpunkt: dicht aufgestellt in Reihen quer zur Marschrichtung (1,5 km
  // Abstand), vordere Einheiten nach vorn, links bleibt links – so kreuzen sich die Wege kaum.
  // keep (Umschalt): die Einheiten behalten ihre Abstände zueinander.
  moveSelectionTo(w, keep = false) {
    const units = this.ownSelection();
    if (!units.length) return;
    const map = this.game.map;
    const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
    const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
    const goals = [];
    if (keep) {
      for (const u of units) goals.push({ u, x: w.x + u.x - cx, y: w.y + u.y - cy });
    } else {
      const l = Math.hypot(w.x - cx, w.y - cy) || 1;
      const fx = (w.x - cx) / l, fy = (w.y - cy) / l; // Marschrichtung
      const lx = -fy, ly = fx;                         // quer dazu
      const depth = (u) => (u.x - cx) * fx + (u.y - cy) * fy;
      const lat = (u) => (u.x - cx) * lx + (u.y - cy) * ly;
      const gap = 1.5 * KM;
      const perRow = Math.max(1, Math.ceil(Math.sqrt(units.length * 2)));
      const rows = Math.ceil(units.length / perRow);
      const byDepth = units.slice().sort((a, b) => depth(b) - depth(a));
      for (let r = 0; r < rows; r++) {
        const row = byDepth.slice(r * perRow, (r + 1) * perRow).sort((a, b) => lat(a) - lat(b));
        const d = ((rows - 1) / 2 - r) * gap;
        row.forEach((u, k) => {
          const s = (k - (row.length - 1) / 2) * gap;
          goals.push({ u, x: w.x + fx * d + lx * s, y: w.y + fy * d + ly * s });
        });
      }
    }
    const cache = new Map();
    for (const g of goals) {
      const u = g.u;
      // Zielplatz auf unbegehbarem Gelände: nächstes begehbares Feld
      if (!map.passableAt(g.x, g.y)) {
        const i = map.nearestPassable(map.cellIndex(g.x, g.y), 4);
        if (i >= 0) { g.x = (i % map.w + 0.5) * CELL; g.y = (Math.floor(i / map.w) + 0.5) * CELL; } else { g.x = w.x; g.y = w.y; }
      }
      // Nebeneinander startende Einheiten teilen sich die Wegsuche zum Zielpunkt
      const key = `${u.x / 30 | 0},${u.y / 30 | 0}`;
      let base = cache.get(key);
      if (base === undefined) {
        base = map.findPath(u.x, u.y, w.x, w.y);
        cache.set(key, base);
      }
      if (base && base.length) {
        const p = base.map((q) => ({ x: q.x, y: q.y }));
        p[p.length - 1] = { x: g.x, y: g.y };
        this.release(u);
        u.path = p;
        u.stuck = 0;
      }
    }
  },


  updateSelectionInfo() {
    const n = this.ui.selection.size;
    let info = n ? `${n} ausgewählt` : '';
    if (n && this.game) {
      const divs = new Set(this.ownSelection().map(divisionOf));
      if (divs.size === 1) {
        const div = [...divs][0];
        info += div ? ` · ${div.name}` : ' · ohne Division';
      }
    }
    $('selInfo').textContent = info;
    $('deselectBtn').hidden = !n;
    $('haltBtn').hidden = !n;
    if (this.fronts) {
      // Das Frontmenü folgt der Auswahl: genau eine Division mit Front gewählt -> ihr Menü
      const div = this.selectedDivision();
      if (div && this.fronts.fronts.includes(div.front)) this.ui.front = div.front;
      else if (n) this.ui.front = null;
      this.updateFrontPanel();
    }
    if (this.game) this.updateDivBar();
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
      } else if (ev.type === 'hqRadio' && ev.owner === this.human && ev.text.includes('übernimmt')) {
        this.toast('📻 ' + ev.text);
      } else if (ev.type === 'spawn' && ev.unit.owner === this.human) {
        this.refill(ev.unit);
      }
      else if (ev.type === 'capture') {
        if (ev.owner === this.human) this.toast(ev.old ? 'Feindliche Stadt erobert!' : 'Neutrale Stadt eingenommen!', 'good');
        else if (ev.old === this.human) this.toast('Eine Stadt ist gefallen!', 'bad');
      } else if (ev.type === 'gameover') this.showEnd(ev.winner);
    }
    g.events.length = 0;
    for (const ev of this.fronts.events) {
      if (ev.type === 'attackDone') this.toast('Angriffsziel erreicht – die Front hält die neue Linie', 'good');
      else if (ev.type === 'frontLost') {
        this.toast(`${ev.division.name} hat keinen Frontabschnitt mehr`);
        this.divBarSig = null;
      }
    }
    this.fronts.events.length = 0;
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

  // Divisionsleiste: Werkzeuge zur Gliederung, dann je eigene Division eine Karte mit
  // Symbol, Name, Stärke und Regimentern
  updateDivBar() {
    const g = this.game;
    const bar = $('divBar');
    const divs = g.orbat[this.human].all(DIVISION)
      .map((f) => ({ f, units: unitsOf(f) }))
      .filter((d) => d.units.length);
    const sel = this.ownSelection();
    const selDivs = new Set(sel.map(divisionOf));
    const single = selDivs.size === 1 ? [...selDivs][0] : null; // ganze Auswahl in einer Division
    const loose = g.units.filter((u) => u.owner === this.human && !u.regiment).length;
    const canAdd = (d) => strength(d.f) < DIVISION_MAX && sel.some((u) => divisionOf(u) !== d.f);
    const supplyOf = (units) => units.reduce((s, u) => s + u.supply, 0) / units.length;
    const orgOf = (units) => units.reduce((s, u) => s + u.org, 0) / units.reduce((s, u) => s + u.maxOrg, 0);
    const sig = divs.map((d) => d.f.id + ':' + d.units.length + ':' + Math.round(strengthOf(d.units) * 20) + ':' + Math.round(supplyOf(d.units) * 20) + ':' + Math.round(orgOf(d.units) * 20) + ':' +
      (d.units.some((u) => this.ui.selection.has(u)) ? 1 : 0) + (canAdd(d) ? 1 : 0) + (d.f.refill ? 1 : 0) + (d.f.front ? 1 : 0)).join('|') +
      `#${sel.length}:${loose}:${single ? single.id : '-'}:${sel.some((u) => u.regiment) ? 1 : 0}`;
    if (sig === this.divBarSig) return;
    this.divBarSig = sig;
    const tools = [];
    if (sel.length) tools.push('<button class="divtool" data-act="new" title="Neue Division aus der Auswahl (D)">＋ Neue Division</button>');
    if (sel.some((u) => u.regiment)) tools.push('<button class="divtool" data-act="remove" title="Auswahl aus ihrer Division nehmen (Umschalt+D)">− Aus Division</button>');
    if (single) {
      tools.push(`<button class="divtool${single.refill ? ' active' : ''}" data-act="refill" data-id="${single.id}" ` +
        `title="Neue Kompanien aus der nächsten Stadt füllen ${single.name} bis ${DIVISION_MAX} Kompanien auf">Auffüllen</button>`);
    }
    if (loose) tools.push(`<button class="divtool" data-act="auto" title="Kompanien ohne Division nach ihrer Lage zu Divisionen zusammenfassen">Auto-Gliederung (${loose})</button>`);
    bar.innerHTML = tools.join('') + divs.map((d) => {
      const heavy = d.units.filter((u) => u.type === 'heavy').length / d.units.length;
      const regs = d.f.children.map((reg) => {
        const alive = reg.units.filter((u) => u.hp > 0).length;
        return natoIcon(reg.type === 'heavy' ? 1 : 0, 16, 11, alive ? 0.35 + 0.65 * alive / REGIMENT_MAX : 0.15, '', divisionColor(d.f));
      });
      const chosen = d.units.some((u) => this.ui.selection.has(u)) ? ' sel' : '';
      const add = canAdd(d) ? `<span class="add" data-act="add" data-id="${d.f.id}" title="Auswahl zur ${d.f.name} hinzufügen">＋</span>` : '';
      return `<button class="divcard${chosen}${d.f.refill ? ' refill' : ''}${add ? ' can-add' : ''}" data-id="${d.f.id}" title="${d.f.name}: ${d.units.length} Kompanien">${add}` +
        `<span class="sym">${natoIcon(heavy, 26, 18, 1, 'XX', divisionColor(d.f))}</span>` +
        `<span class="name">${d.f.name}${d.f.front ? ' <span class="fr" title="hält eine Front">〰</span>' : ''}</span>` +
        `<span class="str" title="Stärke"><i style="width:${Math.round(strengthOf(d.units) * 100)}%"></i></span>` +
        `<span class="org" title="Organisation ${Math.round(orgOf(d.units) * 100)} %"><i style="width:${Math.round(orgOf(d.units) * 100)}%"></i></span>` +
        `<span class="sup${supplyOf(d.units) < SUPPLY.warnBelow ? ' low' : ''}" title="Nachschub ${Math.round(supplyOf(d.units) * 100)} %"><i style="width:${Math.round(supplyOf(d.units) * 100)}%"></i></span>` +
        `<span class="regs">${regs.join('')}</span></button>`;
    }).join('');
  },

  selectDivision(id, focus = true) {
    const g = this.game;
    const f = g.orbat[this.human].all(DIVISION).find((d) => d.id === id);
    if (!f) return;
    const units = unitsOf(f);
    if (!units.length) return;
    this.ui.selection.clear();
    for (const u of units) this.ui.selection.add(u);
    this.updateSelectionInfo();
    this.divBarSig = null;
    if (!focus) return;
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
    app.renderer.draw(app.cam, app.ui, app.fronts);
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
// Die Hilfe hebt nur eine Pause auf, die sie selbst ausgelöst hat
let helpPaused = false;
$('helpBtn').onclick = () => {
  $('help').hidden = false;
  helpPaused = !app.paused;
  if (helpPaused) app.togglePause();
};
$('helpClose').onclick = () => {
  $('help').hidden = true;
  if (helpPaused && app.paused) app.togglePause();
  helpPaused = false;
};
$('menuHelpBtn').onclick = () => { $('help').hidden = false; helpPaused = false; };
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
  const tool = e.target.closest('[data-act]');
  if (tool) {
    const id = +tool.dataset.id;
    const act = tool.dataset.act;
    if (act === 'new') app.newDivision();
    else if (act === 'remove') app.removeFromDivision();
    else if (act === 'add') app.addToDivision(id);
    else if (act === 'refill') app.toggleRefill(id);
    else if (act === 'auto') app.autoOrganize();
    return;
  }
  const card = e.target.closest('.divcard');
  if (card) app.selectDivision(+card.dataset.id);
};
$('frontBtn').onclick = () => app.toggleFrontMode();
$('showFrontsBtn').onclick = () => app.toggleShowFronts();
$('supplyBtn').onclick = () => app.toggleSupply();
$('borderBtn').onclick = () => app.borderFront();
$('planBtn').onclick = () => app.setFrontMode({ plan: app.ui.front });
$('attackBtn').onclick = () => {
  app.fronts.startAttack(app.ui.front);
  app.toast('Angriff läuft!', 'good');
  app.updateFrontPanel();
};
$('cancelPlanBtn').onclick = () => { app.fronts.cancelPlan(app.ui.front); app.updateFrontPanel(); };
$('rotateBtn').onclick = () => { app.ui.front.rotate = !app.ui.front.rotate; app.updateFrontPanel(); };
$('rejoinBtn').onclick = () => { app.fronts.rejoin(app.ui.front); app.updateFrontPanel(); };
$('disbandBtn').onclick = () => {
  for (const u of app.ui.front.units) u.path = [];
  app.fronts.remove(app.ui.front);
  app.selectFront(null);
};
$('frontCancel').onclick = () => app.setFrontMode(null);
$('frontClose').onclick = () => app.selectFront(null);
$('haltBtn').onclick = () => app.stopSelection();
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
function natoIcon(armorShare, w, h, opacity = 1, echelon = '', fill = '#80e0ff') {
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
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="#000" stroke-width="1"/>${inner}</svg>`;
}
