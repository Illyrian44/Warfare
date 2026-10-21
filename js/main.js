import { generateMap } from './map.js?v=70';
import { Game } from './game.js?v=70';
import { AI } from './ai.js?v=70';
import { Renderer, isFrontShown } from './render.js?v=70';
import { Input } from './input.js?v=70';
import { formationSlots } from './formation.js?v=70';
import { FrontManager, chainLength, frontBadge } from './fronts.js?v=70';
import { DIVISION, ARMY, DIVISION_MAX, REGIMENT_MAX, unitsOf, divisionColor, divisionOf, armyOf, armyColor, strength } from './orbat.js?v=70';
import { DIFFICULTY, UNITS_PER_CITY, SUPPLY, KM, CELL } from './config.js?v=70';

const STEP = 1 / 30;
const $ = (id) => document.getElementById(id);

const app = {
  game: null,
  ai: null,
  renderer: null,
  human: 1,
  cam: { x: 0, y: 0, zoom: 1, min: 0.2, max: 6 },
  ui: { selection: new Set(), drawPath: null, box: null, revealAll: false, selectMode: false, frontMode: null, front: null, showFronts: false, showSupply: false, armyClosed: new Set(), hover: null },
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
    this.updateCommands();
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
    this.toast('Einheiten anklicken, Rechtsklick (Handy: Antippen) bewegt sie. Erobere alle Städte!');
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
    this.updateCommands();
  },

  // Manueller Befehl: Einheit verlässt ihre Front
  release(u) {
    if (u.front) { this.fronts.release(u); this.updateCommands(); }
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
      const fronts = mode.plan.filter((f) => this.fronts.fronts.includes(f));
      if (!fronts.length) return;
      this.fronts.planAttackGroup(fronts, line);
      this.updateCommands();
      this.toast(fronts.length > 1 ? `Angriff für ${fronts.length} Divisionen geplant – „▶ Angriff starten“ drücken`
        : 'Angriff geplant – „▶ Angriff starten“ drücken');
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
    this.updateSelectionInfo();
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
    this.updateSelectionInfo();
    if (!made.length || !made[0].chains.length) this.toast('Keine Grenze zum Gegner gefunden');
    else this.toast(divs.length > 1 ? `${divs.length} Divisionen teilen sich die Grenze` : `${divs[0].name} hält die Grenze`);
  },

  selectFront(f) {
    this.ui.front = f;
    this.updateCommands();
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

  // Fronten, auf die das Frontmenü wirkt: die aller ausgewählten Divisionen (z. B. einer
  // ganzen Armee), sonst die zuletzt angetippte Front
  panelFronts() {
    const divs = new Set(this.ownSelection().map(divisionOf).filter(Boolean));
    const fs = this.fronts.fronts.filter((f) => divs.has(f.division));
    if (fs.length) return fs;
    return this.ui.front && this.fronts.fronts.includes(this.ui.front) ? [this.ui.front] : [];
  },

  // Gemeinsamer Name der Auswahl: Armee, wenn genau ihre Divisionen gewählt sind
  selectionName(fronts) {
    const divs = [...new Set(fronts.map((f) => f.division))];
    const army = armyOf(divs[0]);
    if (army && divs.length === army.children.length && divs.every((d) => armyOf(d) === army)) return army.name;
    return divs.length === 1 ? divs[0].name : `${divs.length} Divisionen`;
  },

  // Befehlsfeld: erscheint nur mit Auswahl und bietet nur passende Befehle an.
  // Kompanien: Halt, Gliederung. Divisionen zusätzlich: Front, Grenze, Armee.
  // Mit Front: Angriff, Rotation, Auflösen – für alle Fronten der Auswahl (z. B. eine Armee).
  updateCommands() {
    if (this.ui.front && !this.fronts.fronts.includes(this.ui.front)) this.ui.front = null;
    const sel = this.ownSelection();
    $('cmdPanel').hidden = !sel.length;
    if (!sel.length) return;
    const show = (id, on) => { $(id).hidden = !on; };
    const divs = this.selectedDivisions();
    const single = this.selectedDivision();
    const fs = this.panelFronts();
    $('cmdTitle').textContent = this.describeSelection(sel);
    // Ganze Divisionen ausgewählt: keine neue Division daraus, „Aus Division“ löst sie auf
    const whole = divs.length > 0 && sel.every((u) => u.regiment) &&
      divs.every((d) => unitsOf(d).every((u) => this.ui.selection.has(u)));
    show('newDivBtn', !whole);
    show('unDivBtn', sel.some((u) => u.regiment));
    $('unDivBtn').textContent = whole ? (divs.length > 1 ? 'Divisionen auflösen' : 'Division auflösen') : '− Aus Division';
    show('refillBtn', !!single);
    if (single) $('refillBtn').classList.toggle('active', !!single.refill);
    show('newArmyBtn', divs.length > 0);
    show('unArmyBtn', divs.some((d) => armyOf(d)));
    show('cmdFront', divs.length > 0);
    const planned = fs.some((f) => f.plan), attacking = fs.some((f) => f.attack);
    show('planBtn', fs.length && !planned);
    $('planBtn').textContent = attacking ? '➜ Neues Ziel' : '➜ Angriff planen';
    show('attackBtn', planned);
    show('stopAttackBtn', attacking);
    show('cancelPlanBtn', planned);
    show('rotateBtn', fs.length > 0);
    $('rotateBtn').classList.toggle('active', fs.length > 0 && fs.every((f) => f.rotate));
    const off = fs.reduce((s, f) => s + this.fronts.detached(f), 0);
    show('rejoinBtn', off > 0);
    $('rejoinBtn').textContent = `↺ ${off} zurück an die Front`;
    show('disbandBtn', fs.length > 0);
    $('disbandBtn').textContent = fs.length > 1 ? 'Fronten auflösen' : 'Front auflösen';
    $('frontBtn').textContent = fs.length ? '〰 Neue Front' : '〰 Front';
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

  // --- Armeen --------------------------------------------------------------------

  selectedDivisions() {
    return [...new Set(this.ownSelection().map(divisionOf).filter(Boolean))];
  },

  newArmy() {
    const divs = this.selectedDivisions();
    if (!divs.length) { this.toast('Erst Divisionen auswählen'); return; }
    const army = this.game.orbat[this.human].createArmy(divs);
    this.fronts.regroup(army.children);
    this.afterOrbatChange();
    this.toast(`${army.name} gebildet (${army.children.length} Divisionen)`);
  },

  addToArmy(id) {
    const ob = this.game.orbat[this.human];
    const army = ob.all(ARMY).find((a) => a.id === id);
    const divs = this.selectedDivisions().filter((d) => armyOf(d) !== army);
    if (!army || !divs.length) return;
    ob.addToArmy(army, divs);
    // Neue Divisionen bekommen einen Teil des Abschnitts, den die Armee hält
    this.fronts.regroup(army.children);
    this.afterOrbatChange();
    this.toast(`${divs.length} Division${divs.length > 1 ? 'en' : ''} zur ${army.name}`);
  },

  removeFromArmy() {
    const divs = this.selectedDivisions().filter((d) => armyOf(d));
    if (!divs.length) return;
    this.game.orbat[this.human].removeFromArmy(divs);
    this.afterOrbatChange();
    this.toast(`${divs.length} Division${divs.length > 1 ? 'en' : ''} ohne Armee`);
  },

  toggleArmyOpen(id) {
    if (this.ui.armyClosed.has(id)) this.ui.armyClosed.delete(id); else this.ui.armyClosed.add(id);
    this.divBarSig = null;
    this.updateDivBar();
  },

  selectArmy(id, focus = true) {
    const army = this.game.orbat[this.human].all(ARMY).find((a) => a.id === id);
    if (!army) return;
    const units = unitsOf(army);
    if (!units.length) return;
    this.ui.selection.clear();
    for (const u of units) this.ui.selection.add(u);
    this.updateSelectionInfo();
    this.divBarSig = null;
    if (focus) this.focusOn(units);
  },

  focusOn(units) {
    const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
    const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
    this.cam.x = cx - canvas.clientWidth / 2 / this.cam.zoom;
    this.cam.y = cy - canvas.clientHeight / 2 / this.cam.zoom;
    this.clampCamera();
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

  // Bewegen zum Zielpunkt: dichte Aufstellung (siehe formationSlots); keep (Umschalt):
  // die Einheiten behalten ihre Abstände zueinander
  moveSelectionTo(w, keep = false) {
    const units = this.ownSelection();
    if (!units.length) return;
    const map = this.game.map;
    const goals = formationSlots(units, w, keep);
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
    if (this.fronts) {
      // Das Frontmenü folgt der Auswahl: genau eine Division mit Front gewählt -> ihre Front
      const div = this.selectedDivision();
      if (div && this.fronts.fronts.includes(div.front)) this.ui.front = div.front;
      else if (this.ui.selection.size) this.ui.front = null;
      this.updateCommands();
    }
    if (this.game) this.updateDivBar();
  },

  // Name der Auswahl für den Titel des Befehlsfelds
  describeSelection(sel) {
    const divs = new Set(sel.map(divisionOf));
    const army = armyOf([...divs][0]);
    let name = '';
    if (army && divs.size === army.children.length && [...divs].every((d) => armyOf(d) === army)) name = army.name;
    else if (divs.size === 1) name = [...divs][0] ? [...divs][0].name : 'ohne Division';
    else if (!divs.has(null) || divs.size > 2) name = `${[...divs].filter(Boolean).length} Divisionen`;
    return `${sel.length} Kompanie${sel.length === 1 ? '' : 'n'}${name ? ' · ' + name : ''}`;
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
      if (ev.type === 'attackDone') this.toast(`${ev.front.division.name}: Angriffsziel erreicht – sie hält wieder ihren Frontabschnitt`, 'good');
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
    const ob = g.orbat[this.human];
    const divs = ob.all(DIVISION).map((f) => ({ f, units: unitsOf(f) })).filter((d) => d.units.length);
    const armies = ob.all(ARMY).map((a) => ({ a, units: unitsOf(a), divs: divs.filter((d) => armyOf(d.f) === a) }))
      .filter((x) => x.units.length);
    const sel = this.ownSelection();
    const selDivs = new Set(sel.map(divisionOf));
    const single = selDivs.size === 1 ? [...selDivs][0] : null; // ganze Auswahl in einer Division
    const pickedDivs = [...selDivs].filter(Boolean);
    const loose = g.units.filter((u) => u.owner === this.human && !u.regiment).length;
    // „＋“ auf einer Division verschiebt Kompanien; nicht anbieten, wenn ganze Verbände
    // (mehrere Divisionen, z. B. eine Armee) ausgewählt sind
    const wholeDivs = pickedDivs.length > 1 && sel.every((u) => u.regiment);
    const canAdd = (d) => !wholeDivs && strength(d.f) < DIVISION_MAX && sel.some((u) => divisionOf(u) !== d.f);
    const canAddArmy = (x) => pickedDivs.some((d) => armyOf(d) !== x.a);
    const supplyOf = (units) => units.reduce((s, u) => s + u.supply, 0) / units.length;
    const orgOf = (units) => units.reduce((s, u) => s + u.org, 0) / units.reduce((s, u) => s + u.maxOrg, 0);
    const stats = (units) => Math.round(strengthOf(units) * 20) + ':' + Math.round(supplyOf(units) * 20) + ':' + Math.round(orgOf(units) * 20);
    const sig = divs.map((d) => d.f.id + ':' + d.units.length + ':' + stats(d.units) + ':' + (armyOf(d.f) ? armyOf(d.f).id : '-') + ':' +
      (d.units.some((u) => this.ui.selection.has(u)) ? 1 : 0) + (canAdd(d) ? 1 : 0) + (d.f.refill ? 1 : 0) + (d.f.front ? 1 : 0)).join('|') +
      '#' + armies.map((x) => x.a.id + ':' + stats(x.units) + (this.ui.armyClosed.has(x.a.id) ? 'c' : 'o') + (canAddArmy(x) ? 1 : 0)).join('|') +
      `#${sel.length}:${loose}:${single ? single.id : '-'}:${sel.some((u) => u.regiment) ? 1 : 0}:${pickedDivs.some((d) => armyOf(d)) ? 1 : 0}`;
    if (sig === this.divBarSig) return;
    this.divBarSig = sig;
    const bars = (units) => {
      const sup = supplyOf(units), org = orgOf(units);
      return `<span class="str" title="Stärke"><i style="width:${Math.round(strengthOf(units) * 100)}%"></i></span>` +
        `<span class="org" title="Organisation ${Math.round(org * 100)} %"><i style="width:${Math.round(org * 100)}%"></i></span>` +
        `<span class="sup${sup < SUPPLY.warnBelow ? ' low' : ''}" title="Nachschub ${Math.round(sup * 100)} %"><i style="width:${Math.round(sup * 100)}%"></i></span>`;
    };
    const divCard = (d, inArmy) => {
      const heavy = d.units.filter((u) => u.type === 'heavy').length / d.units.length;
      const regs = d.f.children.map((reg) => {
        const alive = reg.units.filter((u) => u.hp > 0).length;
        return natoIcon(reg.type === 'heavy' ? 1 : 0, 16, 11, alive ? 0.35 + 0.65 * alive / REGIMENT_MAX : 0.15, '', divisionColor(d.f));
      });
      const chosen = d.units.some((u) => this.ui.selection.has(u)) ? ' sel' : '';
      const add = canAdd(d) ? `<span class="add" data-act="add" data-id="${d.f.id}" title="Auswahl zur ${d.f.name} hinzufügen">＋</span>` : '';
      const tag = inArmy ? ` style="border-top-color:${armyColor(armyOf(d.f))}"` : '';
      return `<button class="divcard${chosen}${d.f.refill ? ' refill' : ''}${add ? ' can-add' : ''}${inArmy ? ' inarmy' : ''}" data-id="${d.f.id}"${tag} title="${d.f.name}: ${d.units.length} Kompanien">${add}` +
        `<span class="sym">${natoIcon(heavy, 26, 18, 1, 'XX', divisionColor(d.f))}</span>` +
        `<span class="name">${d.f.name}${d.f.front ? ' <span class="fr" title="hält eine Front">〰</span>' : ''}</span>` +
        bars(d.units) + `<span class="regs">${regs.join('')}</span></button>`;
    };
    const armyCard = (x) => {
      const heavy = x.units.filter((u) => u.type === 'heavy').length / x.units.length;
      const open = !this.ui.armyClosed.has(x.a.id);
      const chosen = x.units.every((u) => this.ui.selection.has(u)) ? ' sel' : '';
      const add = canAddArmy(x) ? `<span class="add" data-act="armyadd" data-id="${x.a.id}" title="Ausgewählte Divisionen zur ${x.a.name}">＋</span>` : '';
      return `<button class="divcard armycard${chosen}${add ? ' can-add' : ''}" data-army="${x.a.id}" style="border-color:${armyColor(x.a)}" title="${x.a.name}: ${x.divs.length} Divisionen, ${x.units.length} Kompanien">${add}` +
        `<span class="sym">${natoIcon(heavy, 30, 18, 1, 'XXXX', armyColor(x.a))}</span>` +
        `<span class="name">${x.a.name} <span class="toggle" data-act="armyopen" data-id="${x.a.id}" title="Divisionen ein-/ausklappen">${open ? '▾' : '▸'} ${x.divs.length}</span></span>` +
        bars(x.units) + '</button>' + (open ? x.divs.map((d) => divCard(d, true)).join('') : '');
    };
    bar.innerHTML = armies.map(armyCard).join('') + divs.filter((d) => !armyOf(d.f)).map((d) => divCard(d, false)).join('');
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
    if (focus) this.focusOn(units);
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
    this.updateCommands();
    const loose = g.units.filter((u) => u.owner === this.human && !u.regiment).length;
    $('autoBtn').hidden = !loose;
    $('autoBtn').textContent = `Auto-Gliederung (${loose})`;
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
    if (act === 'add') app.addToDivision(id);
    else if (act === 'armyadd') app.addToArmy(id);
    else if (act === 'armyopen') app.toggleArmyOpen(id);
    return;
  }
  const army = e.target.closest('[data-army]');
  if (army) { app.selectArmy(+army.dataset.army); return; }
  const card = e.target.closest('.divcard');
  if (card) app.selectDivision(+card.dataset.id);
};
$('frontBtn').onclick = () => app.toggleFrontMode();
$('showFrontsBtn').onclick = () => app.toggleShowFronts();
$('supplyBtn').onclick = () => app.toggleSupply();
$('borderBtn').onclick = () => app.borderFront();
$('planBtn').onclick = () => app.setFrontMode({ plan: app.panelFronts() });
$('attackBtn').onclick = () => {
  for (const f of app.panelFronts()) app.fronts.startAttack(f);
  app.toast('Angriff läuft!', 'good');
  app.updateCommands();
};
$('stopAttackBtn').onclick = () => {
  for (const f of app.panelFronts()) app.fronts.stopAttack(f);
  app.toast('Angriff gestoppt – die Divisionen halten ihre Frontabschnitte');
  app.updateCommands();
};
$('cancelPlanBtn').onclick = () => { for (const f of app.panelFronts()) app.fronts.cancelPlan(f); app.updateCommands(); };
$('rotateBtn').onclick = () => {
  const fs = app.panelFronts(), on = !fs.every((f) => f.rotate);
  for (const f of fs) f.rotate = on;
  app.updateCommands();
};
$('rejoinBtn').onclick = () => { for (const f of app.panelFronts()) app.fronts.rejoin(f); app.updateCommands(); };
$('disbandBtn').onclick = () => {
  for (const f of app.panelFronts()) {
    for (const u of f.units) u.path = [];
    app.fronts.remove(f);
  }
  app.selectFront(null);
  app.divBarSig = null;
};
$('frontCancel').onclick = () => app.setFrontMode(null);
$('cmdClose').onclick = () => { app.ui.selection.clear(); app.selectFront(null); app.updateSelectionInfo(); };
$('haltBtn').onclick = () => app.stopSelection();
$('newDivBtn').onclick = () => app.newDivision();
$('unDivBtn').onclick = () => app.removeFromDivision();
$('refillBtn').onclick = () => { const d = app.selectedDivision(); if (d) app.toggleRefill(d.id); };
$('newArmyBtn').onclick = () => app.newArmy();
$('unArmyBtn').onclick = () => app.removeFromArmy();
$('autoBtn').onclick = () => app.autoOrganize();
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
  for (let k = 0; k < echelon.length; k++) {
    const cx = w / 2 + (k - (echelon.length - 1) / 2) * 6;
    ech += `<path d="M${cx - 2} 0.5L${cx + 2} 4.5M${cx + 2} 0.5L${cx - 2} 4.5" stroke="#fff" stroke-width="1"/>`;
  }
  return `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" style="opacity:${opacity.toFixed(2)}">${ech}` +
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="#000" stroke-width="1"/>${inner}</svg>`;
}
