import { loadMap, MAPS } from './map.js?v=110';
import { Game } from './game.js?v=110';
import { AI } from './ai.js?v=110';
import { Renderer } from './render.js?v=110';
import { Input } from './input.js?v=110';
import { formationSlots } from './formation.js?v=110';
import { FrontManager, chainLength } from './fronts.js?v=110';
import { DIVISION, ARMY, DIVISION_MAX, REGIMENT_MAX, unitsOf, divisionColor, divisionOf, armyOf, armyColor, strength } from './orbat.js?v=110';
import { DIFFICULTY, SUPPLY, KM, CELL, PLAYER_COLORS, PLAYER_NAMES, CITY_RADIUS, UNIT_TYPES, TEMPLATES, UPGRADES, BUILDINGS, BUILDING_MAX, DIPLOMACY } from './config.js?v=110';
import { templateCost } from './production.js?v=110';

const STEP = 1 / 30;
const $ = (id) => document.getElementById(id);
const VERSION = '110'; // für Kartendaten, siehe scripts/bump-version.sh
// Reiter der oberen Leiste: Inhalt in der Seitenleiste
const TAB_BODIES = { build: 'buildBody', city: 'cityBody', diplo: 'diploBody', logistics: 'logiBody', troops: 'troopBody' };
const TAB_TITLES = { build: 'Produktion', city: 'Städte', diplo: 'Diplomatie', logistics: 'Logistik', troops: 'Truppen' };

const app = {
  game: null,
  ais: [],
  renderer: null,
  human: 1,
  cam: { x: 0, y: 0, zoom: 1, min: 0.2, max: 6 },
  ui: { selection: new Set(), drawPath: null, box: null, revealAll: false, selectMode: false, frontMode: null, front: null, showFronts: true, showSupply: false, openGroup: null, tab: null, hover: null, intent: null },
  paused: false,
  speed: 1,
  settings: loadSettings(),
  lastHud: 0,

  // Ohne startCity: erst die Karte zeigen und die Startstadt wählen lassen (pickStart).
  // seed: Zufall dieser Partie (KI, Produktion), „Nochmal“ spielt sie gleich wieder
  async start(seed, mapId, difficulty, opponents = 1, startCity = null) {
    let map;
    try {
      map = await loadMap(mapId, seed, VERSION);
    } catch {
      $('menuError').textContent = 'Die Karte ließ sich nicht laden – bitte nochmal versuchen.';
      $('menuError').hidden = false;
      $('end').hidden = true;
      $('menu').hidden = false;
      return;
    }
    $('menuError').hidden = true;
    const preview = startCity === null;
    this.picking = preview;
    this.game = new Game(map, { players: 1 + opponents, preview, starts: [null, startCity] });
    this.ais = preview ? [] : this.game.players.filter((p) => p !== this.human).map((p) => new AI(this.game, p, difficulty));
    this.fronts = new FrontManager(this.game, this.human);
    this.ui.frontMode = null;
    this.ui.front = null;
    this.updateCommands();
    this.renderer = new Renderer(canvas, this.game, this.human);
    this.ui.selection.clear();
    this.ui.revealAll = false;
    this.ui.showFronts = true; // Fronten sind immer zu sehen (V blendet sie aus)
    $('showFrontsBtn').classList.add('active');
    this.ui.showSupply = false;
    $('supplyBtn').classList.remove('active');
    this.paused = true; // jede Runde beginnt pausiert: erst in Ruhe gliedern und Fronten setzen
    this.setSpeed(1);
    this.current = { seed, map: mapId, difficulty, opponents };
    this.settings = { map: mapId, difficulty, opponents };
    saveSettings(this.settings);
    this.divBarSig = null;
    this.fitCamera();
    $('menu').hidden = true;
    $('end').hidden = true;
    $('hud').hidden = false;
    $('pauseBtn').textContent = '▶';
    $('pauseBtn').classList.add('paused');
    this.setTab(null);
    $('pausedBanner').hidden = preview;
    $('pickBanner').hidden = !preview;
    $('offerBox').hidden = true;
    this.diploSig = null;
    $('resumeBtn').hidden = true;
    $('seedLabel').textContent = `${map.name} · 1 Feld ≈ ${map.kmPerCell} km · ${DIFFICULTY[difficulty].name}`;
    this.ui.pickHover = null;
    this.updateSelectionInfo();
    if (preview) return;
    this.toast('Einheiten anklicken, Rechtsklick (Handy: Antippen) bewegt sie. Halte 70 % des Landes!');
    this.toast('Erobere zuerst neutrale Städte in der Nähe – jede bringt Land und Nachschub für neue Truppen.');
  },

  // Stadt unter dem Zeiger (für die Wahl der Startstadt)
  cityAt(w) {
    const tol = CITY_RADIUS + Math.max(4, 12 / this.cam.zoom);
    let best = null, bd = tol;
    for (const c of this.game.cities) {
      const d = Math.hypot(c.x - w.x, c.y - w.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  },

  // Startstadt gewählt: das eigentliche Spiel beginnt dort, die KIs verteilen sich
  // möglichst weit entfernt
  async pickStart(w) {
    const c = w ? this.cityAt(w) : this.game.cities[Math.floor(Math.random() * this.game.cities.length)];
    if (!c) { this.toast('Tippe auf eine Stadt (gelber Kreis), um dort zu beginnen'); return; }
    const { seed, map, difficulty, opponents } = this.current;
    const cam = { ...this.cam };
    await this.start(seed, map, difficulty, opponents, c.id);
    if (window.innerWidth >= 700) Object.assign(this.cam, cam); // Ansicht beibehalten
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
    if (!this.game || this.game.winner || this.picking) return;
    this.paused = !this.paused;
    $('pauseBtn').textContent = this.paused ? '▶' : '❚❚';
    $('pauseBtn').classList.toggle('paused', this.paused);
    $('pausedBanner').hidden = !this.paused;
  },

  setSpeed(s) {
    this.speed = s;
    $('speedBtn').textContent = `${s}×`;
  },

  selectAll() {
    for (const u of this.game.units) if (u.owner === this.human && !u.broken) this.ui.selection.add(u);
    this.updateSelectionInfo();
  },

  stopSelection() {
    for (const u of this.ui.selection) {
      if (u.broken) continue; // Rückzug Zerschlagener nicht anhalten
      this.fronts.release(u);
      u.path = [];
    }
    this.updateCommands();
  },

  // Manueller Befehl: Einheit verlässt ihre Front
  release(u) {
    if (u.front) { this.fronts.release(u); this.updateCommands(); }
  },

  // Werkzeug des Schlachtplans: { forms } = Frontlinie malen (erase: entziehen),
  // { plan: fronts } = Vorstoß (Ziellinie ziehen), { fallback: holds } = Auffanglinie ziehen.
  // Das Werkzeug bleibt an, bis „Fertig“, Esc oder ein anderer Verband gewählt wird
  setFrontMode(mode) {
    if (mode) mode.sig = this.selectionSig();
    this.ui.frontMode = mode;
    if (!mode) this.ui.drawPath = null;
    this.toolSig = null;
    this.updateCommands();
  },

  toolOf(mode) {
    return !mode ? null : mode.forms ? 'front' : mode.plan ? 'attack' : 'fallback';
  },

  // Divisionen der Auswahl als Kennung (wechselt sie, endet das Werkzeug)
  selectionSig() {
    return [...new Set(this.ownSelection().map(divisionOf).filter(Boolean))].map((d) => d.id).sort((a, b) => a - b).join();
  },

  // Werkzeug-Knopf (oder Taste F/G/R): einschalten bzw. wieder aus
  toggleTool(tool) {
    if (this.toolOf(this.ui.frontMode) === tool) { this.setFrontMode(null); return; }
    if (tool === 'front') {
      const forms = this.frontTargets();
      if (forms) this.setFrontMode({ forms });
    } else if (tool === 'attack') {
      const fs = this.panelFronts();
      if (fs.length) this.setFrontMode({ plan: fs });
      else this.toast('Erst eine Frontlinie zuweisen – von ihr aus wird vorgestoßen');
    } else if (tool === 'fallback') {
      const holds = this.panelHolds();
      if (holds.length) this.setFrontMode({ fallback: holds });
      else this.toast('Erst eine Frontlinie zuweisen – die Auffanglinie liegt dahinter');
    }
  },

  toggleFrontMode() {
    this.toggleTool('front');
  },

  toggleFrontErase() {
    const mode = this.ui.frontMode;
    if (mode && mode.forms) this.setFrontMode({ ...mode, erase: !mode.erase });
  },

  // Schnellwahl im Werkzeug Frontlinie: ganze Grenze und je Gegner seine Grenze (mit Länge)
  frontQuickHtml() {
    const list = this.fronts.frontInfo().list;
    if (!list.length) return '<span class="muted">Keine Grenze zu einem Gegner</span>';
    const km = (n) => Math.round(n * (this.game.map.kmPerCell || 1));
    const foes = new Map();
    for (const e of list) foes.set(e.foe, (foes.get(e.foe) || 0) + 1);
    let h = `<button class="chip" data-opt="quick" data-foe="all" title="Grenze zu allen Gegnern">Ganze Grenze · ${km(list.length)} km</button>`;
    if (foes.size > 1) { // bei nur einem Gegner ist seine Grenze die ganze Grenze
      for (const [p, n] of [...foes].sort((a, b) => b[1] - a[1])) {
        if (!p) continue;
        h += `<button class="chip" data-opt="quick" data-foe="${p}" title="Grenze zu ${PLAYER_NAMES[p]}"><span class="dot" style="background:${PLAYER_COLORS[p]}"></span>${PLAYER_NAMES[p]} · ${km(n)} km</button>`;
      }
    }
    return h;
  },

  // Schnellwahl angetippt: die Auswahl hält diese Grenze (mehrere Verbände teilen sie sich)
  frontQuick(foe) {
    const mode = this.ui.frontMode;
    if (!mode || !mode.forms) return;
    const forms = mode.forms.filter((f) => !f.dissolved && unitsOf(f).length);
    const entries = foe === 'all' ? this.fronts.frontInfo().list : this.fronts.foeEntries(+foe);
    if (!forms.length || !entries.length) return;
    this.fronts.assignSplit(forms, entries);
    this.afterFrontChange();
    const km = Math.round(entries.length * (this.game.map.kmPerCell || 1));
    this.toast(`${this.formsName(forms)} hält ${foe === 'all' ? 'die ganze Grenze' : `die Grenze zu ${PLAYER_NAMES[+foe]}`} (${km} km)`);
  },

  // Knopf in der Werkzeugleiste
  toolOption(opt, el) {
    if (opt === 'quick') this.frontQuick(el.dataset.foe);
    else if (opt === 'erase') this.toggleFrontErase();
    else if (opt === 'disband') this.disbandFronts();
    else if (opt === 'cancelPlan') { for (const f of this.panelFronts()) this.fronts.cancelPlan(f); this.updateCommands(); }
    else if (opt === 'fallNow') this.fallbackAction();
    else if (opt === 'clearFallback') { for (const hd of this.panelHolds()) this.fronts.clearFallback(hd); this.updateCommands(); }
  },

  // Inhalt der Werkzeugleiste: Überschrift, Hinweis, Optionen
  toolDrawer(tool, st) {
    const mode = this.ui.frontMode;
    if (tool === 'front') {
      const own = this.panelHolds().length > 0;
      return {
        title: mode.erase ? 'Frontlinie entziehen' : `Frontlinie · ${this.formsName(mode.forms)}`,
        hint: mode.erase ? 'Über die Grenze ziehen, um sie freizugeben' : 'Grenze übermalen · ins Feindgebiet tippen = ganze Grenze zu ihm',
        opts: (mode.erase ? '' : this.frontQuickHtml()) +
          '<span class="sep"></span>' +
          `<button data-opt="erase" class="${mode.erase ? 'active' : ''}" title="Statt zu malen: der Grenze unter dem Pinsel die Front entziehen">⌫ Entziehen</button>` +
          (own ? '<button data-opt="disband" class="danger" title="Front der Auswahl auflösen – die Verbände bleiben bestehen">✕ Auflösen</button>' : ''),
      };
    }
    if (tool === 'attack') {
      return {
        title: st.attacking ? 'Vorstoß · neues Ziel' : 'Vorstoß',
        hint: 'Ziellinie ziehen, bis wohin die Front angreifen soll – dann ▶ Angriff starten',
        opts: st.planned ? '<button data-opt="cancelPlan" class="danger">✕ Plan verwerfen</button>' : '',
      };
    }
    return {
      title: 'Auffanglinie',
      hint: st.lined ? 'Neue Linie ziehen ersetzt die alte' : 'Linie hinter der Front ziehen',
      opts: st.lined
        ? `<button data-opt="fallNow" class="${st.falling ? '' : 'warn'}">${st.falling ? '↥ Front wieder halten' : '⤶ Jetzt zurückfallen'}</button>` +
          '<button data-opt="clearFallback" class="danger">✕ Linie löschen</button>'
        : '',
    };
  },

  // Lage des Schlachtplans der Auswahl
  planState() {
    const fs = this.panelFronts(), holds = this.panelHolds();
    const lined = holds.filter((hd) => hd.fallback);
    return {
      fs, holds,
      attacking: fs.some((f) => f.attack),
      planned: fs.some((f) => f.plan),
      lined: lined.length > 0,
      falling: lined.some((hd) => hd.falling),
      // zuletzt gezogene Linie entscheidet, was „Ausführen“ zuerst anbietet
      next: this.ui.intent && this.ui.intent.sig === this.selectionSig() ? this.ui.intent.kind : null,
    };
  },

  // „Ausführen“ (Enter): was gerade ansteht – Angriff stoppen, Front wieder halten,
  // geplanten Angriff starten oder auf die Auffanglinie zurückfallen
  execute() {
    const st = this.planState();
    this.ui.intent = null;
    if (st.lined && !st.falling && st.next === 'fallback') {
      this.fallbackAction();
      return;
    }
    if (st.attacking) {
      for (const f of st.fs) this.fronts.stopAttack(f);
      this.toast('Angriff gestoppt – die Divisionen halten ihre Abschnitte');
    } else if (st.falling) {
      this.fallbackAction();
      return;
    } else if (st.planned) {
      for (const f of st.fs) this.fronts.startAttack(f);
      this.toast('Angriff läuft!', 'good');
      if (this.toolOf(this.ui.frontMode) === 'attack') this.setFrontMode(null);
    } else if (st.lined) {
      this.fallbackAction();
      return;
    } else return;
    this.updateCommands();
  },

  // Die ganze Auswahl gehört zu genau einer Division (sonst null)
  selectedDivision() {
    const divs = new Set(this.ownSelection().map(divisionOf));
    return divs.size === 1 ? [...divs][0] : null;
  },

  // Verbände, die eine Front bekommen: ganz ausgewählte Armeen als Ganzes, sonst die
  // ausgewählten Divisionen einzeln (Kompanien ohne Division zählen nicht)
  frontTargets() {
    const sel = this.ownSelection();
    const divs = [...new Set(sel.map(divisionOf).filter(Boolean))];
    if (!divs.length) {
      if (!sel.length) this.toast('Erst eine Armee oder Division auswählen – unten in der Leiste oder auf der Karte');
      else this.toast('Kompanien ohne Division können keine Front halten – erst eine Division bilden');
      return null;
    }
    const out = [];
    for (const a of new Set(divs.map(armyOf).filter(Boolean))) if (a.children.every((d) => divs.includes(d))) out.push(a);
    for (const d of divs) if (!out.includes(armyOf(d))) out.push(d);
    return out;
  },

  formsName(forms) {
    return forms.length === 1 ? forms[0].name : `${forms.length} Verbände`;
  },

  // Nach jeder Frontänderung Leiste und Befehlsfeld auffrischen
  afterFrontChange() {
    this.divBarSig = null;
    this.updateSelectionInfo();
  },

  // Pinselstrich über die Grenze: die Grenze unter dem Pinsel geht an den (ersten) Verband;
  // mehrere Verbände teilen sich den Strich am Ende (frontStrokeEnd)
  frontStroke(g, w) {
    const mode = this.ui.frontMode;
    if (!mode || !mode.forms) return;
    const hit = this.fronts.paintStroke(mode.erase ? null : mode.forms[0], g.last || g.start, w, true);
    g.last = w;
    for (const e of hit) g.stroke.set(e.i, e);
    if (g.stroke.size) this.ui.drawPath = null; // kein Linienentwurf, sobald gemalt wird
  },

  frontStrokeEnd(g) {
    const mode = this.ui.frontMode;
    if (!mode || !mode.forms) return;
    const forms = mode.forms.filter((f) => !f.dissolved && unitsOf(f).length);
    if (!forms.length) { this.setFrontMode(null); return; }
    const name = this.formsName(forms);
    const km = (n) => Math.round(n * (this.game.map.kmPerCell || 1));
    if (g.stroke.size) {
      if (!mode.erase && forms.length > 1) this.fronts.assignSplit(forms, [...g.stroke.values()]);
      else this.fronts.commit(mode.erase ? [] : [forms[0]]);
      this.afterFrontChange();
      return;
    }
    if (!g.moved) {
      // Antippen: Feindgebiet = ganze Grenze zu diesem Gegner, sonst die Grenze unter dem Pinsel
      const owner = this.game.territory[this.game.map.cellIndex(g.start.x, g.start.y)];
      if (!mode.erase && owner && this.game.hostile(this.human, owner)) {
        const entries = this.fronts.foeEntries(owner);
        if (!entries.length) { this.toast(`Keine gemeinsame Grenze mit ${PLAYER_NAMES[owner]}`); return; }
        this.fronts.assignSplit(forms, entries);
        this.afterFrontChange();
        this.toast(`${name} hält die Grenze zu ${PLAYER_NAMES[owner]} (${km(entries.length)} km)`);
      } else if (this.fronts.entryAt(g.start)) {
        this.fronts.paintStroke(mode.erase ? null : forms[0], g.start, g.start);
        this.afterFrontChange();
      } else this.toast('Auf die Grenze tippen bzw. darüber ziehen – oder ins Feindgebiet tippen');
      return;
    }
    this.toast('Hier liegt keine Grenze – über die Grenze ziehen oder ins Feindgebiet tippen');
  },

  // Angriffsziel bzw. Auffanglinie gezogen
  finishFront(line) {
    const mode = this.ui.frontMode;
    if (!mode || !(mode.plan || mode.fallback)) return;
    if (chainLength(line) < 30) {
      this.toast('Linie zu kurz – nochmal versuchen');
      return;
    }
    if (mode.fallback) {
      const holds = mode.fallback.filter((hd) => this.fronts.holds.includes(hd));
      if (!holds.length) return;
      this.fronts.setFallback(holds, line);
      this.ui.intent = { kind: 'fallback', sig: this.selectionSig() };
      this.updateCommands();
      this.toast('Auffanglinie gezogen – „⤶ Zurückfallen“ zieht die Front dorthin zurück');
      this.setFrontMode(null);
      return;
    }
    const fronts = mode.plan.filter((f) => this.fronts.fronts.includes(f));
    if (!fronts.length) return;
    this.fronts.planAttackGroup(fronts, line);
    this.ui.intent = { kind: 'attack', sig: this.selectionSig() };
    this.updateCommands();
    this.toast(fronts.length > 1 ? `Angriff für ${fronts.length} Divisionen geplant – „▶ Angriff starten“ drücken`
      : 'Angriff geplant – „▶ Angriff starten“ drücken');
    this.setFrontMode(null);
  },

  // Front auflösen: Aufträge der ausgewählten Verbände; eine Division im Auftrag ihrer Armee
  // verlässt ihn nicht einzeln
  disbandFronts() {
    const forms = this.frontTargets();
    if (!forms) return;
    let n = 0;
    for (const f of forms) {
      const hd = this.fronts.holdOf(f);
      if (!hd) continue;
      for (const u of unitsOf(f)) if (u.front) u.path = [];
      this.fronts.dropHold(hd);
      n++;
    }
    this.fronts.afterAssign([]);
    this.selectFront(null);
    this.afterFrontChange();
    if (!n) {
      const army = forms.map((f) => (f.level === DIVISION ? armyOf(f) : null)).find((a) => a && this.fronts.holdOf(a));
      this.toast(army ? `Die Front gehört der ${army.name} – die Armee auswählen, um sie aufzulösen` : 'Keine Front zum Auflösen');
    }
  },

  selectFront(f) {
    this.ui.front = f;
    this.updateCommands();
  },

  // Armee oder Division auswählen (z. B. über ihr Frontabzeichen)
  selectFormation(f) {
    if (f.level === ARMY) this.selectArmy(f.id, false);
    else this.selectDivision(f.id, false);
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

  // Abzeichen eines Auftrags unter dem Zeiger (siehe Renderer.drawHoldBadges)
  pickHoldBadge(w) {
    if (!this.ui.showFronts || !this.renderer.holdHits) return null;
    const h = this.renderer.holdHits.find((b) => Math.abs(b.x - w.x) <= b.hw && Math.abs(b.y - w.y) <= b.hh);
    return h ? h.hd : null;
  },

  // Auftrag, dessen Frontlinie nah am Zeiger liegt
  pickHold(w) {
    if (!this.ui.showFronts) return null;
    const tol = Math.max(8, 10 / this.cam.zoom);
    for (const l of this.fronts.edges()) {
      const hd = l.key && this.fronts.holdIds.get(l.key);
      if (!hd) continue;
      for (let i = 1; i < l.pts.length; i++) if (segDist(w, l.pts[i - 1], l.pts[i]) < tol) return hd;
    }
    return null;
  },

  // Trenner zwischen zwei Aufträgen unter dem Zeiger
  pickBoundary(w) {
    if (!this.ui.showFronts) return null;
    const tol = Math.max(6, 13 / this.cam.zoom);
    let best = null, bd = tol;
    for (const b of this.fronts.boundaries()) {
      const d = Math.hypot(b.x - w.x, b.y - w.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  },

  // Fronten, auf die das Frontmenü wirkt: die aller ausgewählten Divisionen (z. B. einer
  // ganzen Armee), sonst die zuletzt angetippte Front
  panelFronts() {
    const divs = new Set(this.ownSelection().map(divisionOf).filter(Boolean));
    const fs = this.fronts.fronts.filter((f) => divs.has(f.division));
    if (fs.length) return fs;
    return this.ui.front && this.fronts.fronts.includes(this.ui.front) ? [this.ui.front] : [];
  },

  // Aufträge (Armee- bzw. Divisionsfronten) der ausgewählten Divisionen
  panelHolds() {
    return [...new Set(this.panelFronts().map((f) => f.hold))].filter((hd) => this.fronts.holds.includes(hd));
  },

  // Auffanglinie: ohne Linie ziehen, sonst zurückfallen bzw. wieder die Front halten
  fallbackAction() {
    const holds = this.panelHolds();
    if (!holds.length) return;
    const lined = holds.filter((hd) => hd.fallback);
    if (!lined.length) { this.setFrontMode({ fallback: holds }); return; }
    if (this.toolOf(this.ui.frontMode) === 'fallback') this.ui.frontMode = null;
    const back = lined.some((hd) => hd.falling);
    for (const hd of lined) this.fronts.fallBack(hd, !back);
    this.updateCommands();
    this.toast(back ? 'Die Front wird wieder gehalten' : 'Rückzug auf die Auffanglinie', back ? '' : 'bad');
  },

  // Gemeinsamer Name der Auswahl: Armee, wenn genau ihre Divisionen gewählt sind
  selectionName(fronts) {
    const divs = [...new Set(fronts.map((f) => f.division))];
    const army = armyOf(divs[0]);
    if (army && divs.length === army.children.length && divs.every((d) => armyOf(d) === army)) return army.name;
    return divs.length === 1 ? divs[0].name : `${divs.length} Divisionen`;
  },

  // Befehlsfeld unten links (erscheint mit einer Auswahl): Kopf mit Name, Stärke, Frontlänge
  // und Lage; darunter der Schlachtplan (Werkzeuge Frontlinie, Vorstoß, Auffanglinie, ein
  // „Ausführen“, Rotation) mit der Leiste des offenen Werkzeugs; zuletzt die Gliederung
  updateCommands() {
    if (this.ui.front && !this.fronts.fronts.includes(this.ui.front)) this.ui.front = null;
    const sel = this.ownSelection();
    // Werkzeug endet, wenn die Auswahl wechselt
    if (this.ui.frontMode && (!sel.length || this.ui.frontMode.sig !== this.selectionSig())) {
      this.ui.frontMode = null;
      this.ui.drawPath = null;
    }
    $('cmdPanel').hidden = !sel.length;
    if ($('cmdPanel').hidden) return;
    const show = (id, on) => { $(id).hidden = !on; };
    const enable = (id, on) => { $(id).disabled = !on; };
    const divs = this.selectedDivisions();
    const single = this.selectedDivision();
    const st = this.planState(), fs = st.fs;
    // Kopf
    $('cmdTitle').textContent = this.selectionTitle(sel, divs);
    // Frontlänge: die der Aufträge; eine einzelne Division im Auftrag ihrer Armee nennt ihren Abschnitt
    const kmPer = this.game.map.kmPerCell || 1;
    const army = armyOf(divs[0]);
    const wholeArmy = !!army && divs.length === army.children.length && divs.every((d) => armyOf(d) === army);
    const own = !!single && !wholeArmy && !!single.front && st.holds.length === 1 && st.holds[0].formation !== single;
    const km = own ? Math.round(single.front.cells.length * kmPer)
      : st.holds.reduce((s, hd) => s + this.fronts.holdStatus(hd).km, 0);
    const parts = [];
    if (divs.length > 1) parts.push(`${divs.length} Div.`);
    parts.push(`${sel.length} Kp.`);
    if (divs.length) parts.push(!st.holds.length ? 'ohne Front' : own ? `Abschnitt ${km} km` : `Front ${km} km`);
    $('cmdSub').textContent = parts.join(' · ');
    const [stTxt, stCls] = !divs.length ? ['', '']
      : st.attacking ? ['Angriff läuft', 'go']
      : st.falling ? ['Rückzug', 'bad']
      : st.planned ? ['Angriff geplant', 'plan']
      : st.holds.length ? ['Hält die Front', 'hold'] : ['Reserve', ''];
    $('cmdState').textContent = stTxt;
    $('cmdState').className = 'state ' + stCls;
    $('cmdState').hidden = !stTxt;
    // Schlachtplan
    show('planBar', divs.length > 0);
    const tool = this.toolOf(this.ui.frontMode);
    for (const b of $('planBar').querySelectorAll('[data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === tool);
      b.disabled = b.dataset.tool !== 'front' && !fs.length;
    }
    const [icon, label, cls, tip] = st.lined && !st.falling && st.next === 'fallback' ? ['⤶', 'Zurückfallen', 'warn', 'Auf die Auffanglinie zurückziehen und sie halten']
      : st.attacking ? ['■', 'Angriff stoppen', 'stop', 'Laufenden Angriff beenden – die Divisionen halten wieder ihre Abschnitte']
      : st.falling ? ['↥', 'Front halten', 'go', 'Von der Auffanglinie zurück an die Grenze']
      : st.planned ? ['▶', 'Angriff starten', 'go', 'Geplanten Vorstoß ausführen']
      : st.lined ? ['⤶', 'Zurückfallen', 'warn', 'Auf die Auffanglinie zurückziehen und sie halten']
      : ['▶', 'Ausführen', '', 'Erst einen Vorstoß oder eine Auffanglinie planen'];
    const exec = $('execBtn');
    exec.className = 'exec ' + cls;
    exec.disabled = !cls;
    exec.title = tip + ' (Enter)';
    if (exec.dataset.sig !== label) { exec.dataset.sig = label; exec.innerHTML = `<i>${icon}</i><span>${label}</span>`; }
    enable('rotateBtn', fs.length > 0);
    $('rotateBtn').classList.toggle('active', fs.length > 0 && fs.every((f) => f.rotate));
    const off = fs.reduce((s, f) => s + this.fronts.detached(f), 0);
    show('rejoinBtn', off > 0);
    $('rejoinN').textContent = off ? `${off} zurück` : '';
    // Leiste des offenen Werkzeugs (nur bei Änderung neu, damit Klicks nicht verloren gehen)
    show('toolDrawer', !!tool);
    if (tool) {
      const d = this.toolDrawer(tool, st);
      const sig = d.title + d.hint + d.opts;
      if (sig !== this.toolSig) {
        this.toolSig = sig;
        $('toolTitle').textContent = d.title;
        $('toolHint').textContent = d.hint;
        $('toolOpts').innerHTML = d.opts;
      }
    }
    // Gliederung: ganze Divisionen ausgewählt -> keine neue Division daraus, „Aus Division“
    // löst sie auf
    const whole = divs.length > 0 && sel.every((u) => u.regiment) &&
      divs.every((d) => unitsOf(d).every((u) => this.ui.selection.has(u)));
    show('newDivBtn', !whole);
    show('unDivBtn', sel.some((u) => u.regiment));
    $('unDivBtn').textContent = whole ? (divs.length > 1 ? 'Divisionen auflösen' : 'Division auflösen') : '− Aus Division';
    show('refillBtn', !!single);
    if (single) $('refillBtn').classList.toggle('active', !!single.refill);
    show('newArmyBtn', divs.length > 0);
    show('unArmyBtn', divs.some((d) => armyOf(d)));
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
    this.fronts.mergeInto(army); // die Fronten der Divisionen gehen an die Armee
    this.afterOrbatChange();
    this.toast(`${army.name} gebildet (${army.children.length} Divisionen)`);
  },

  addToArmy(id) {
    const ob = this.game.orbat[this.human];
    const army = ob.all(ARMY).find((a) => a.id === id);
    const divs = this.selectedDivisions().filter((d) => armyOf(d) !== army);
    if (!army || !divs.length) return;
    ob.addToArmy(army, divs);
    // Neue Divisionen bringen ihre Front mit und bekommen einen Teil der Armeefront
    this.fronts.mergeInto(army);
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

  // --- Diplomatie -------------------------------------------------------------------

  // --- Reiter (Seitenleiste) ---------------------------------------------------------

  // Einen Reiter öffnen (null: Seitenleiste schließen); derselbe Reiter noch einmal schließt
  setTab(tab) {
    this.ui.tab = tab;
    $('sidePanel').hidden = !tab;
    document.body.classList.toggle('side-open', !!tab);
    for (const b of document.querySelectorAll('#topbar .tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const [t, id] of Object.entries(TAB_BODIES)) $(id).hidden = t !== tab;
    if (!tab) return;
    $('sideTitle').textContent = TAB_TITLES[tab];
    this.buildSig = this.diploSig = this.troopSig = this.logiSig = null;
    this.updateTab();
  },

  toggleTab(tab) {
    this.setTab(this.ui.tab === tab ? null : tab);
  },

  updateTab() {
    if (!this.game) return;
    if (this.ui.tab === 'build' || this.ui.tab === 'city') this.updateBuildPanel();
    else if (this.ui.tab === 'troops') this.updateTroops();
    else if (this.ui.tab === 'logistics') this.updateLogistics();
    this.updateDiplo();
  },

  toggleDiplo(open = this.ui.tab !== 'diplo') {
    this.setTab(open ? 'diplo' : null);
  },

  updateDiplo() {
    if (!this.game) return;
    const g = this.game, me = this.human;
    // Angebot an den Spieler: das älteste offene
    const offer = g.offers.find((o) => o.to === me);
    $('offerBox').hidden = !offer;
    if (offer) {
      const left = Math.max(0, Math.ceil(DIPLOMACY.offerTimeout - (g.time - offer.time)));
      $('offerText').innerHTML = `<span class="dot" style="background:${PLAYER_COLORS[offer.from]}"></span> ${PLAYER_NAMES[offer.from]} bietet dir ein Bündnis an <small class="muted">(${left} s)</small>`;
      this.offerId = offer.id;
    }
    if (this.ui.tab !== 'diplo') return;
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const rows = g.players.filter((p) => p !== me).map((p) => {
      const ally = g.allied(me, p), out = !g.alive(p);
      const since = g.allySince.get(g.pairKey(me, p));
      const truce = g.truces.get(g.pairKey(me, p));
      const pending = g.offers.some((o) => o.from === me && o.to === p);
      let status = out ? 'ausgeschieden' : ally ? `verbündet${since !== undefined ? ` · noch ${mmss(DIPLOMACY.duration - (g.time - since))}` : ''}`
        : truce !== undefined ? `Waffenruhe · Krieg in ${mmss(truce - g.time)}` : 'Krieg';
      if (!out && g.isTraitor(p)) status += ` · Verräter (−${DIPLOMACY.traitorDefense * 100} % Verteidigung)`;
      let btn = '';
      if (!out && ally && this.confirmBreak === p) {
        // Warnung vor dem Bruch: erst bestätigen
        return '<div class="diploRow warn">' +
          `<span class="who"><b>Bündnis mit ${PLAYER_NAMES[p]} brechen?</b><small>⚠ Du wirst ${DIPLOMACY.traitorTime / 60} Minuten internationaler Verräter: ` +
          `−${DIPLOMACY.traitorDefense * 100} % Verteidigung, und keine KI verbündet sich mit dir.</small></span>` +
          `<button data-act="breakYes" data-p="${p}" class="attack">Brechen</button><button data-act="breakNo" data-p="${p}">Abbrechen</button></div>`;
      }
      if (!out && ally) btn = `<button data-act="break" data-p="${p}" title="Bündnis brechen – danach giltst du ${DIPLOMACY.traitorTime / 60} Minuten als internationaler Verräter (−${DIPLOMACY.traitorDefense * 100} % Verteidigung)">Brechen</button>`;
      else if (!out && pending) btn = '<button disabled>Angebot läuft …</button>';
      else if (!out) {
        const wait = g.canAlly(me, p) ? 0 : Math.ceil(Math.max(truce ?? 0, g.allyCooldown.get(g.pairKey(me, p)) ?? 0) - g.time);
        btn = `<button data-act="offer" data-p="${p}"${wait ? ` disabled title="Nach einem Bündnis erst in ${wait} s wieder"` : ''}>${wait ? `in ${wait} s` : 'Bündnis anbieten'}</button>`;
      }
      return `<div class="diploRow${out ? ' out' : ''}"><span class="dot" style="background:${PLAYER_COLORS[p]}"></span>` +
        `<span class="who"><b>${PLAYER_NAMES[p]}</b><small>${status} · ${g.citiesOf(p).length} Städte · ${Math.round(g.share[p] * 100)} % Land</small></span>${btn}</div>`;
    });
    const note = `<p class="muted">Verbündete kämpfen nicht gegeneinander, nehmen sich kein Land und handeln mit Bonus. Bündnisse laufen nach ${DIPLOMACY.duration / 60} Minuten aus (angekündigt ${DIPLOMACY.warn} s vorher); wer bricht, ist ${DIPLOMACY.traitorTime / 60} Minuten internationaler Verräter (−${DIPLOMACY.traitorDefense * 100} % Verteidigung, keine neuen Bündnisse mit der KI). Nach jedem Bündnis folgen ${DIPLOMACY.truce} s Waffenruhe, in denen beide das Land des anderen räumen. Gewinnen kann nur eine Seite allein.${g.isTraitor(me) ? ' <b>Du bist gerade internationaler Verräter: −${DIPLOMACY.traitorDefense * 100} % Verteidigung, die KI lehnt Bündnisse ab.</b>' : ''}</p>`;
    const html = rows.join('') + note;
    if (html !== this.diploSig) { this.diploSig = html; $('diploBody').innerHTML = html; }
  },

  // --- Truppen ----------------------------------------------------------------------

  // Überblick wie die Armeeübersicht in HOI4: Armeen mit Divisionen und Front, Reserve,
  // Lücken an der Grenze. Antippen wählt den Verband und zeigt ihn
  updateTroops() {
    if (!this.game || this.ui.tab !== 'troops') return;
    const g = this.game, ob = g.orbat[this.human];
    const pct = (v) => `${Math.round(v * 100)} %`;
    const LEVEL = { good: ['gut besetzt', 'good'], thin: ['dünn', 'thin'], weak: ['zu dünn', 'weak'], none: ['ohne Grenze', 'none'] };
    const frontOf = (f) => {
      const hd = this.fronts.holdOf(f);
      if (!hd) return { text: 'ohne Front', tag: '' };
      const st = this.fronts.holdStatus(hd);
      if (hd.kind === 'line') return { text: 'Verteidigungslinie', tag: '' };
      const [name, cls] = LEVEL[st.level];
      return { text: `${st.km} km Front, ${st.units} Kp.`, tag: `<span class="tag ${cls}">${name}</span>` };
    };
    const divRow = (d, child) => {
      const units = unitsOf(d);
      if (!units.length) return '';
      const org = units.reduce((s, u) => s + u.org, 0) / units.reduce((s, u) => s + u.maxOrg, 0);
      const sup = units.reduce((s, u) => s + u.supply, 0) / units.length;
      const own = this.fronts.holdOf(d) ? ` · eigene Front: ${frontOf(d).text}` : d.front ? '' : ' · ohne Front';
      const chosen = units.some((u) => this.ui.selection.has(u)) ? 'sel' : '';
      return `<li class="${child ? 'child' : ''}"><button data-act="seldiv" data-id="${d.id}" class="${chosen}"><span class="sw" style="background:${divisionColor(d)}"></span>` +
        `<span class="nm">${d.name}</span><span class="muted">${strength(d)}/${DIVISION_MAX}</span>` +
        `<span class="sub">Organisation ${pct(org)} · Nachschub ${pct(sup)}${own}</span></button></li>`;
    };
    let h = '<h4>Armeen</h4>';
    const armies = ob.all(ARMY).filter((a) => unitsOf(a).length);
    if (!armies.length) h += '<p class="muted">Noch keine Armee. Divisionen auswählen und „＋ Armee“ tippen – eine Armee hält ihre Front als Ganzes.</p>';
    h += '<ul class="rows">' + armies.map((a) => {
      const fr = frontOf(a);
      const chosen = unitsOf(a).every((u) => this.ui.selection.has(u)) ? 'sel' : '';
      return `<li><button data-act="selarmy" data-id="${a.id}" class="${chosen}"><span class="sw" style="background:${armyColor(a)}"></span>` +
        `<span class="nm">${a.name}</span>${fr.tag}<span class="sub">${a.children.length} Divisionen · ${unitsOf(a).length} Kompanien · ${fr.text}</span></button></li>` +
        a.children.map((d) => divRow(d, true)).join('');
    }).join('') + '</ul>';
    const reserve = ob.all(DIVISION).filter((d) => !armyOf(d));
    const loose = g.units.filter((u) => u.owner === this.human && !u.regiment).length;
    h += '<h4>Reserve</h4>';
    if (reserve.length) h += '<ul class="rows">' + reserve.map((d) => divRow(d, false)).join('') + '</ul>';
    h += loose
      ? `<p class="muted">${loose} Kompanien ohne Division – frei verfügbar, aber ohne HQ und Front.</p><div class="buildRow"><button data-act="auto">Auto-Gliederung<small>nach ihrer Lage zu Divisionen zusammenfassen</small></button></div>`
      : reserve.length ? '' : '<p class="muted">Keine Reserve.</p>';
    const km = (n) => Math.round(n * (g.map.kmPerCell || 1));
    const all = this.fronts.frontInfo().list.length, gaps = this.fronts.openEntries().length;
    h += `<h4>Grenze</h4><p class="muted">${km(all)} km Grenze zum Gegner${gaps ? `, davon <b>${km(gaps)} km ohne Front</b>` : ', überall mit Front'}.</p>`;
    if (gaps) h += '<div class="buildRow"><button data-act="gap">Lücke zeigen<small>springt zur ersten Stelle ohne Front</small></button></div>';
    if (h !== this.troopSig) { this.troopSig = h; $('troopBody').innerHTML = h; }
  },

  troopAction(t) {
    const act = t.dataset.act, id = +t.dataset.id;
    if (act === 'selarmy') this.selectArmy(id);
    else if (act === 'seldiv') this.selectDivision(id);
    else if (act === 'auto') this.autoOrganize();
    else if (act === 'gap') this.showGap();
    this.troopSig = null;
    this.updateTroops();
  },

  // --- Logistik ---------------------------------------------------------------------

  // Nachschub im Überblick: Lage aller Kompanien, je Armee und Division Vorrat und
  // Lieferquote, je Versorgungsnetz (zusammenhängendes Gebiet) Depots und Auslastung
  updateLogistics() {
    if (!this.game || this.ui.tab !== 'logistics') return;
    const g = this.game, p = this.human, ob = g.orbat[p], prod = g.production;
    const pct = (v) => `${Math.round(v * 100)} %`;
    const own = g.units.filter((u) => u.owner === p);
    const cut = (u) => u.depot < 0 || !u.supplyEff;
    const count = { full: 0, low: 0, empty: 0, cut: 0 };
    for (const u of own) count[cut(u) ? 'cut' : u.supply >= 0.6 ? 'full' : u.supply >= 0.2 ? 'low' : 'empty']++;
    let h = '<h4>Versorgungslage</h4><div class="logiSum">' +
      `<span class="tag good">${count.full} voll</span><span class="tag thin">${count.low} knapp</span>` +
      `<span class="tag weak">${count.empty} leer</span><span class="tag none">${count.cut} abgeschnitten</span></div>` +
      `<div class="buildRow"><button data-act="layer" class="${this.ui.showSupply ? 'on' : ''}">Kartenebene Nachschub: ${this.ui.showSupply ? 'an' : 'aus'}<small>Lieferquote auf der Karte, Auslastung an den Städten (N)</small></button></div>`;
    const level = (units) => {
      const sup = units.reduce((s, u) => s + u.supply, 0) / units.length;
      const eff = units.reduce((s, u) => s + (u.supplyEff || 0), 0) / units.length;
      const cls = units.some(cut) ? 'none' : sup >= 0.6 ? 'good' : sup >= 0.2 ? 'thin' : 'weak';
      return { sup, eff, cls, text: units.some(cut) ? `${units.filter(cut).length} abgeschnitten` : sup >= 0.6 ? 'versorgt' : sup >= 0.2 ? 'knapp' : 'leer' };
    };
    const row = (f, act, color, child) => {
      const units = unitsOf(f);
      if (!units.length) return '';
      const l = level(units);
      return `<li class="${child ? 'child' : ''}"><button data-act="${act}" data-id="${f.id}"><span class="sw" style="background:${color}"></span>` +
        `<span class="nm">${f.name}</span><span class="tag ${l.cls}">${l.text}</span>` +
        `<span class="sub">Vorrat ${pct(l.sup)} · Lieferquote ${pct(l.eff)}</span></button></li>`;
    };
    h += '<h4>Armeen und Divisionen</h4><ul class="rows">' +
      ob.all(ARMY).map((a) => row(a, 'selarmy', armyColor(a), false) + a.children.map((d) => row(d, 'seldiv', divisionColor(d), true)).join('')).join('') +
      ob.all(DIVISION).filter((d) => !armyOf(d)).map((d) => row(d, 'seldiv', divisionColor(d), false)).join('') + '</ul>';
    // Versorgungsnetze: Städte im selben zusammenhängenden Gebiet teilen ihre Lieferleistung
    const net = g.supply.nets[p];
    const pools = new Map();
    for (const c of g.citiesOf(p)) {
      const k = net.pool[g.map.cellIndex(c.x, c.y)];
      if (!pools.has(k)) pools.set(k, []);
      pools.get(k).push(c);
    }
    h += '<h4>Depots</h4><p class="muted">Jede Stadt ist ein Depot. Städte in zusammenhängendem Gebiet bilden ein Netz und teilen sich ihre Lieferleistung; über 100 % Auslastung bekommen alle weniger. Ein Depot-Ausbau bringt +50 % je Stufe.</p>';
    [...pools.values()].sort((a, b) => b.length - a.length).forEach((cities, k) => {
      const load = Math.max(...cities.map((c) => c.supplyLoad || 0));
      const cls = load > 1 ? 'weak' : load > 0.8 ? 'thin' : 'good';
      h += `<p><b>Netz ${k + 1}</b> · ${cities.length} ${cities.length > 1 ? 'Städte' : 'Stadt'} <span class="tag ${cls}">Auslastung ${pct(load)}</span></p><ul class="rows">` +
        cities.sort((a, b) => b.buildings.depot - a.buildings.depot || a.name.localeCompare(b.name)).map((c) => {
          const next = prod.nextBuilding(c, 'depot');
          const busy = c.construction;
          const btn = next && !busy ? `<span class="tag good" data-act="depot" data-id="${c.id}" title="Depot Stufe ${c.buildings.depot + 1} bauen: ${next.cost.money}💰, ${Math.round(next.time)} s">＋ Depot</span>` : '';
          return `<li><button data-act="pickcity" data-id="${c.id}"><span class="sw" style="background:${PLAYER_COLORS[p]}"></span>` +
            `<span class="nm">${c.name}</span>${btn}<span class="sub">📦 Depot Stufe ${c.buildings.depot}${busy ? ` · baut ${BUILDINGS[busy.key].icon}` : ''}</span></button></li>`;
        }).join('') + '</ul>';
    });
    if (h !== this.logiSig) { this.logiSig = h; $('logiBody').innerHTML = h; }
  },

  logiAction(t) {
    const g = this.game, act = t.dataset.act, id = +t.dataset.id;
    if (act === 'layer') this.toggleSupply();
    else if (act === 'selarmy') this.selectArmy(id);
    else if (act === 'seldiv') this.selectDivision(id);
    else if (act === 'pickcity') this.focusOn([g.cities[id]]);
    else if (act === 'depot') {
      const c = g.cities[id];
      if (g.production.construct(this.human, id, 'depot')) this.toast(`${c.name}: Depot wird ausgebaut`);
      else this.toast('Dafür reicht das Geld nicht oder die Stadt baut schon');
    }
    this.logiSig = null;
    this.updateLogistics();
  },

  // Division per Ziehen umhängen: zu einer Armee (army), in die Reserve (null) oder in eine
  // neue Armee ('new'). Sie bringt ihre Front mit, die Armee teilt neu auf
  moveDivision(id, target) {
    const ob = this.game.orbat[this.human];
    const div = ob.all(DIVISION).find((d) => d.id === id);
    if (!div || armyOf(div) === target) return;
    if (target === 'new') {
      const army = ob.createArmy([div]);
      this.fronts.mergeInto(army);
      this.ui.openGroup = army.id;
      this.toast(`${army.name} gebildet aus ${div.name}`);
    } else if (target) {
      ob.addToArmy(target, [div]);
      this.fronts.mergeInto(target);
      this.toast(`${div.name} zur ${target.name}`);
    } else {
      ob.removeFromArmy([div]);
      this.toast(`${div.name} in der Reserve`);
    }
    this.afterOrbatChange();
  },

  // Kamera zum ersten Grenzstück ohne Front
  showGap() {
    const e = this.fronts.openEntries()[0];
    if (!e) { this.toast('Die ganze Grenze hat eine Front'); return; }
    if (!this.ui.showFronts) this.toggleShowFronts();
    this.focusOn([{ x: e.cx, y: e.cy }]);
  },

  // Meldungen in der oberen Leiste: Lücken an der Front, Nachschubmangel, Kompanien ohne
  // Division. Antippen springt hin bzw. öffnet die passende Ansicht
  updateAlerts() {
    const g = this.game;
    const list = [];
    const gaps = Math.round(this.fronts.openEntries().length * (g.map.kmPerCell || 1));
    if (gaps && this.game.orbat[this.human].all(DIVISION).length) list.push(['gap', 'bad', `⚠ ${gaps} km Front ohne Armee`, 'Zur ersten Lücke springen']);
    const hungry = g.units.filter((u) => u.owner === this.human && u.supply < 0.2).length;
    if (hungry) list.push(['supply', 'warn', `⛟ ${hungry} Kp. ohne Nachschub`, 'Kartenebene Nachschub zeigen']);
    const loose = g.units.filter((u) => u.owner === this.human && !u.regiment).length;
    if (loose) list.push(['loose', '', `${loose} Kp. ohne Division`, 'Reserve öffnen']);
    const html = list.map(([k, cls, text, title]) => `<button class="alert ${cls}" data-alert="${k}" title="${title}">${text}</button>`).join('');
    if (html !== this.alertSig) { this.alertSig = html; $('alerts').innerHTML = html; }
  },

  alertAction(k) {
    if (k === 'gap') this.showGap();
    else if (k === 'supply') { if (!this.ui.showSupply) this.toggleSupply(); this.setTab('logistics'); }
    else if (k === 'loose') { this.ui.openGroup = 'reserve'; this.divBarSig = null; this.updateDivBar(); }
  },

  diploAction(t) {
    const g = this.game, me = this.human, p = +t.dataset.p;
    if (t.dataset.act === 'offer') {
      if (g.offerAlliance(me, p)) this.toast(`Bündnis an ${PLAYER_NAMES[p]} angeboten – die Antwort kommt gleich`);
    } else if (t.dataset.act === 'break') this.confirmBreak = p;
    else if (t.dataset.act === 'breakNo') this.confirmBreak = 0;
    else if (t.dataset.act === 'breakYes') { this.confirmBreak = 0; g.breakAlliance(me, p); }
    this.diploSig = null;
    this.updateDiplo();
  },

  // --- Baumenü ---------------------------------------------------------------------

  toggleBuild(open = this.ui.tab !== 'build') {
    this.setTab(open ? 'build' : null);
  },

  // Eigene Stadt antippen: Reiter Städte für diese Stadt (oder Produktion, wenn er offen ist)
  openBuildFor(city) {
    this.ui.buildCity = city.id;
    this.setTab(this.ui.tab === 'build' ? 'build' : 'city');
  },

  // Stadt für die Ausbildung: die gewählte, sonst die Hauptstadt, sonst die größte eigene
  buildCity() {
    const g = this.game;
    const own = g.citiesOf(this.human);
    if (!own.length) return null;
    const chosen = own.find((c) => c.id === this.ui.buildCity);
    if (chosen) return chosen;
    return own.slice().sort((a, b) => g.citySize(b) - g.citySize(a))[0];
  },

  updateBuildPanel() {
    const tab = this.ui.tab;
    if (!this.game || (tab !== 'build' && tab !== 'city')) return;
    const body = $(TAB_BODIES[tab]);
    const g = this.game, p = this.human, e = g.eco[p], prod = g.production;
    const city = this.buildCity();
    const div = this.selectedDivision();
    const can = (c) => e.money >= c.money && e.manpower >= c.manpower;
    const orders = prod.ordersOf(p);
    const unitCost = (t) => UNIT_TYPES[t].cost;
    const costs = [unitCost('light'), unitCost('heavy'), ...TEMPLATES.map(templateCost),
      ...Object.values(UPGRADES).flatMap((u) => u.cost.map((m) => ({ money: m, manpower: 0 })))];
    const pend = div ? prod.pendingFor(div) : 0;
    const sig = [tab, city && city.id, g.citiesOf(p).map((c) => c.id + ':' + g.citySize(c) + (tab === 'city' ? Object.values(c.buildings).join('') + (c.construction ? c.construction.key : '') : '')).join(','),
      city ? Object.values(city.buildings).join('') + (city.construction ? city.construction.key : '-') : '',
      div ? `${div.id}:${strength(div)}:${pend}:${div.refill}:${div.equip.training}:${div.equip.artillery}` : '-',
      orders.map((o) => o.id).join(','), costs.map((c) => (can(c) ? 1 : 0)).join('')].join('|');
    if (sig !== this.buildSig) {
      this.buildSig = sig;
      const price = (c, s) => `${c.money}💰${c.manpower ? ` ${c.manpower}👥` : ''}${s ? ` · ${s} s` : ''}`;
      const sizeName = ['', 'Kleinstadt', 'Mittelstadt', 'Großstadt'];
      let h = '';
      if (!city) h += '<p class="muted">Ohne eigene Stadt ist keine Ausbildung möglich.</p>';
      else {
        h += `<h4>${tab === 'build' ? 'Ausbildung in' : 'Stadt'}</h4><select data-act="city">` + g.citiesOf(p)
          .sort((a, b) => g.citySize(b) - g.citySize(a) || a.name.localeCompare(b.name))
          .map((c) => `<option value="${c.id}"${c === city ? ' selected' : ''}>${c.name}${c.capitalOf === p ? ' ★' : ''} – ${sizeName[g.citySize(c)]}, ${prod.citySlots(c)} gleichzeitig</option>`).join('') + '</select>';
        const tanks = prod.canTrain(city, 'heavy');
        if (tab === 'build') h += '<h4>Kompanien</h4><div class="buildRow">' + ['light', 'heavy'].map((t) =>
          `<button data-act="unit" data-type="${t}"${can(unitCost(t)) && prod.canTrain(city, t) ? '' : ' disabled'}>${t === 'light' ? '＋ Infanterie' : '＋ Panzer'}<small>${prod.canTrain(city, t) ? price(unitCost(t), UNIT_TYPES[t].buildTime) : 'braucht eine Fabrik in der Stadt'}</small></button>`).join('') + '</div>';
        if (tab === 'build') h += '<h4>Divisionen</h4><div class="buildRow">' + TEMPLATES.map((t) =>
          `<button data-act="template" data-id="${t.id}"${can(templateCost(t)) && (tanks || !t.heavy) ? '' : ' disabled'}>${t.name}<small>${t.light} Inf. + ${t.heavy} Pz. · ${price(templateCost(t))}</small></button>`).join('') + '</div>';
        // Stadt ausbauen: je Gebäude Stufe, Wirkung und nächste Stufe
        const k = city.construction;
        if (tab === 'city') h += `<h4>${city.name} ausbauen</h4>`;
        if (tab === 'city' && k) h += `<ul class="queue"><li data-build="${city.id}"><span class="what">${BUILDINGS[k.key].icon} ${BUILDINGS[k.key].name} Stufe ${city.buildings[k.key] + 1} im Bau</span><span class="bar"><i></i></span><button data-act="unbuild" title="Bau abbrechen (Kosten zurück)">✕</button></li></ul>`;
        if (tab === 'city') h += '<div class="buildRow">' + Object.entries(BUILDINGS).filter(([, b]) => !b.coastal || city.coastal).map(([key, b]) => {
          const lvl = city.buildings[key], next = prod.nextBuilding(city, key);
          const label = `${b.icon} ${b.name}${lvl ? ` ${lvl}/${BUILDING_MAX}` : ''}`;
          if (!next) return `<button disabled>${label}<small>${b.effect} je Stufe · voll ausgebaut</small></button>`;
          return `<button data-act="build" data-key="${key}"${!k && can(next.cost) ? '' : ' disabled'}>${label}<small>${b.effect} je Stufe · ${next.cost.money}💰 · ${Math.round(next.time)} s</small></button>`;
        }).join('') + '</div>';
      }
      if (tab === 'city') {
        // Alle eigenen Städte mit Gebäuden; Antippen wählt die Stadt und zeigt sie
        h += '<h4>Deine Städte</h4><ul class="rows">' + g.citiesOf(p)
          .sort((a, b) => g.citySize(b) - g.citySize(a) || a.name.localeCompare(b.name))
          .map((c) => {
            const blds = Object.entries(BUILDINGS).filter(([key]) => c.buildings[key]).map(([key, b]) => `${b.icon}${c.buildings[key]}`).join(' ');
            const busy = c.construction ? ` · baut ${BUILDINGS[c.construction.key].icon}` : '';
            return `<li><button data-act="pickcity" data-id="${c.id}" class="${c === city ? 'sel' : ''}"><span class="sw" style="background:${PLAYER_COLORS[p]}"></span>` +
              `<span class="nm">${c.name}${c.capitalOf === p ? ' ★' : ''}</span><span class="muted">${sizeName[g.citySize(c)]}</span>` +
              `<span class="sub">${blds || 'keine Gebäude'}${busy} · ${prod.citySlots(c)} Ausbildungsplatz${prod.citySlots(c) > 1 ? 'e' : ''}</span></button></li>`;
          }).join('') + '</ul>';
      } else if (div) {
        const room = DIVISION_MAX - strength(div) - pend;
        h += `<h4>${div.name} ausbauen (${strength(div)}${pend ? ` +${pend}` : ''}/${DIVISION_MAX})</h4><div class="buildRow">` +
          ['light', 'heavy'].map((t) => `<button data-act="reinforce" data-type="${t}"${room > 0 && can(unitCost(t)) ? '' : ' disabled'}>＋ ${t === 'light' ? 'Infanterie' : 'Panzer'}<small>${price(unitCost(t))} · nächste Stadt</small></button>`).join('') +
          `<button data-act="refill" class="${div.refill ? 'on' : ''}">Auffüllen: ${div.refill ? 'an' : 'aus'}<small>bestellt Ersatz bis ${DIVISION_MAX} selbst</small></button>` +
          Object.entries(UPGRADES).map(([k, u]) => {
            const lvl = div.equip[k];
            if (lvl >= u.cost.length) return `<button disabled>${u.name} (höchste Stufe)<small>${u.effect} je Stufe</small></button>`;
            return `<button data-act="upgrade" data-key="${k}"${e.money >= u.cost[lvl] ? '' : ' disabled'}>${u.name} Stufe ${lvl + 1}<small>${u.effect} · ${u.cost[lvl]}💰</small></button>`;
          }).join('') + '</div>';
      } else {
        h += '<h4>Division ausbauen</h4><p class="muted">Eine Division auswählen, um sie zu verstärken oder auszurüsten.</p>';
      }
      const typeName = (t) => (t === 'heavy' ? 'Panzer' : 'Infanterie');
      if (tab === 'build') h += `<h4>Aufträge (${orders.length})</h4>` + (orders.length ? '<ul class="queue">' + orders.slice(0, 14).map((o) =>
        `<li data-order="${o.id}"><span class="what">${typeName(o.type)} · ${g.cities[o.city].name}${o.division ? ' → ' + o.division.name : o.group ? ' → neue Division' : ''}</span>` +
        `<span class="bar"><i></i></span><button data-act="cancel" data-id="${o.id}" title="Abbrechen (Kosten zurück)">✕</button></li>`).join('') + '</ul>' +
        (orders.length > 14 ? `<p class="muted">… und ${orders.length - 14} weitere</p>` : '') : '<p class="muted">Keine Aufträge.</p>');
      body.innerHTML = h;
    }
    // Fortschritt der Aufträge und des Baus
    const bl = body.querySelector('li[data-build]');
    if (bl && city && city.construction) bl.querySelector('i').style.width = `${Math.min(100, city.construction.timer / city.construction.time * 100)}%`;
    for (const li of body.querySelectorAll('li[data-order]')) {
      const o = orders.find((x) => x.id === +li.dataset.order);
      if (o) li.querySelector('i').style.width = `${Math.min(100, o.timer / UNIT_TYPES[o.type].buildTime * 100)}%`;
    }
  },

  // Klick im Baumenü
  buildAction(t) {
    const g = this.game, p = this.human, prod = g.production;
    const city = this.buildCity();
    const div = this.selectedDivision();
    const act = t.dataset.act;
    const poor = () => this.toast('Dafür reichen Geld oder Manpower nicht');
    if (act === 'unit' && city) { if (!prod.order(p, city.id, t.dataset.type)) poor(); }
    else if (act === 'template' && city) {
      if (prod.orderTemplate(p, city.id, t.dataset.id)) this.toast(`Division wird in ${city.name} ausgebildet – fertig nach der letzten Kompanie`);
      else poor();
    } else if (act === 'reinforce' && div) { if (!prod.reinforce(p, div, t.dataset.type)) poor(); }
    else if (act === 'refill' && div) this.toggleRefill(div.id);
    else if (act === 'upgrade' && div) {
      if (prod.upgrade(p, div, t.dataset.key)) this.toast(`${div.name}: ${UPGRADES[t.dataset.key].name} verbessert`, 'good');
      else poor();
    } else if (act === 'cancel') prod.cancel(+t.dataset.id);
    else if (act === 'build' && city) {
      if (prod.construct(p, city.id, t.dataset.key)) this.toast(`${city.name}: ${BUILDINGS[t.dataset.key].name} wird gebaut`);
      else poor();
    } else if (act === 'unbuild' && city) prod.cancelConstruction(city.id);
    else if (act === 'pickcity') {
      const c = g.cities[+t.dataset.id];
      this.ui.buildCity = c.id;
      this.focusOn([c]);
    }
    this.buildSig = null;
    this.updateHud();
  },

  setSelectMode(on) {
    this.ui.selectMode = on;
    $('selectBtn').classList.toggle('active', on);
  },

  // Bewegen zum Zielpunkt: dichte Aufstellung (siehe formationSlots); keep (Umschalt):
  // die Einheiten behalten ihre Abstände zueinander
  moveSelectionTo(w, keep = false) {
    // Zerschlagene nehmen keine Befehle an, sie ziehen sich zurück, bis sie sich erholt haben
    const all = this.ownSelection();
    const units = all.filter((u) => !u.broken);
    if (!units.length) {
      if (all.length) this.toast('Zerschlagene Kompanien nehmen keine Befehle an – sie ziehen sich erst zurück');
      return;
    }
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
  selectionTitle(sel, divs) {
    const army = armyOf(divs[0]);
    if (army && divs.length === army.children.length && divs.every((d) => armyOf(d) === army)) return army.name;
    if (divs.length === 1) return divs[0].name;
    if (divs.length > 1) return `${divs.length} Divisionen`;
    return `${sel.length} Kompanie${sel.length === 1 ? '' : 'n'} ohne Division`;
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
        this.divBarSig = null;
      } else if (ev.type === 'allianceFormed') {
        const other = ev.a === this.human ? ev.b : ev.b === this.human ? ev.a : 0;
        if (other) this.toast(`🤝 Bündnis mit ${PLAYER_NAMES[other]} geschlossen`, 'good');
        else this.toast(`🤝 ${PLAYER_NAMES[ev.a]} und ${PLAYER_NAMES[ev.b]} verbünden sich`);
        this.diploSig = null;
      } else if (ev.type === 'allianceDeclined' && ev.from === this.human) {
        this.toast(`${PLAYER_NAMES[ev.to]} lehnt das Bündnis ab`, 'bad');
        this.diploSig = null;
      } else if (ev.type === 'allianceBroken') {
        const truce = `${DIPLOMACY.truce} s Waffenruhe, beide räumen das Land des anderen`;
        const penalty = `${DIPLOMACY.traitorTime / 60} Minuten −${DIPLOMACY.traitorDefense * 100} % Verteidigung`;
        if (ev.by === this.human) this.toast(`Bündnis mit ${PLAYER_NAMES[ev.other]} gebrochen – du bist internationaler Verräter: ${penalty}. ${truce}`, 'bad');
        else if (ev.other === this.human) this.toast(`⚠ ${PLAYER_NAMES[ev.by]} hat das Bündnis gebrochen und ist internationaler Verräter (${penalty})! ${truce}`, 'bad');
        else this.toast(`${PLAYER_NAMES[ev.by]} bricht das Bündnis mit ${PLAYER_NAMES[ev.other]} – internationaler Verräter (${penalty})`);
        this.diploSig = null;
      } else if (ev.type === 'allianceEnding' && (ev.a === this.human || ev.b === this.human)) {
        this.toast(`⏳ Das Bündnis mit ${PLAYER_NAMES[ev.a === this.human ? ev.b : ev.a]} läuft in ${ev.left} s aus`);
        this.diploSig = null;
      } else if (ev.type === 'allianceExpired' && (ev.a === this.human || ev.b === this.human)) {
        this.toast(`Das Bündnis mit ${PLAYER_NAMES[ev.a === this.human ? ev.b : ev.a]} ist ausgelaufen – ${DIPLOMACY.truce} s Waffenruhe, deine Truppen räumen sein Land`);
        this.diploSig = null;
      } else if (ev.type === 'truceEnded' && (ev.a === this.human || ev.b === this.human)) {
        this.toast(`⚔ Waffenruhe mit ${PLAYER_NAMES[ev.a === this.human ? ev.b : ev.a]} vorbei – ab jetzt Krieg`, 'bad');
        this.diploSig = null;
      } else if (ev.type === 'convoyLost' && ev.owner === this.human) {
        // höchstens alle 20 s melden
        if (g.time - (this.lastConvoyToast || -99) > 20) {
          this.lastConvoyToast = g.time;
          this.toast('Eine Handelskolonne wurde überfallen – Straßen hinter der Front sichern', 'bad');
        }
      } else if (ev.type === 'built' && ev.city.owner === this.human) {
        this.toast(`${ev.city.name}: ${BUILDINGS[ev.key].name} Stufe ${ev.level} fertig`, 'good');
        this.buildSig = null;
      } else if (ev.type === 'divisionTrained' && ev.division.owner === this.human) {
        this.toast(`${ev.division.name} ist ausgebildet (${strength(ev.division)} Kompanien)`, 'good');
        this.divBarSig = null;
      }
      else if (ev.type === 'capture') {
        if (ev.owner === this.human) this.toast(ev.old ? 'Feindliche Stadt erobert!' : 'Neutrale Stadt eingenommen!', 'good');
        else if (ev.old === this.human) this.toast('Eine Stadt ist gefallen!', 'bad');
      } else if (ev.type === 'eliminated') {
        if (ev.player === this.human) { g.winner = -1; this.showEnd(0); } // ohne Städte und Truppen
        else this.toast(`${PLAYER_NAMES[ev.player]} ist ausgeschieden`, 'good');
      } else if (ev.type === 'gameover') this.showEnd(ev.winner);
    }
    g.events.length = 0;
    for (const ev of this.fronts.events) {
      if (ev.type === 'attackDone') this.toast(`${ev.front.division.name}: Angriffsziel erreicht – sie hält wieder ihren Frontabschnitt`, 'good');
      else if (ev.type === 'attackStalled') this.toast(`${ev.front.division.name}: Angriff kommt nicht voran (Ziel unerreichbar oder Gegner zu stark) – sie hält wieder ihren Abschnitt`, 'bad');
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
    const why = won
      ? (g.players.some((p) => p !== this.human && g.alive(p)) ? `Du hältst ${Math.round(g.share[this.human] * 100)} % des Landes.` : 'Alle Gegner sind ausgeschieden.')
      : winner > 0 ? `${PLAYER_NAMES[winner]} hält ${Math.round(g.share[winner] * 100)} % des Landes.` : 'Du hast keine Städte und Truppen mehr.';
    $('endStats').innerHTML =
      `${why}<br>Spielzeit: ${m}:${String(s).padStart(2, '0')}<br>` +
      `Einheiten gebaut: ${st.built} · verloren: ${st.lost}<br>` +
      `Städte erobert: ${st.captured}`;
    $('end').hidden = false;
  },

  // Armeeleiste wie in HOI4: unten je Armee eine Karte (Farbe, Name, Divisionen, Front mit
  // Ampel), dazu die Reserve (Divisionen ohne Armee, Kompanien ohne Division) und „＋ Armee“.
  // Darüber die Divisionen der offenen Armee bzw. der Reserve. Offen ist, wozu die Auswahl
  // gehört, sonst die zuletzt angetippte Karte
  updateDivBar() {
    const g = this.game;
    const ob = g.orbat[this.human];
    const divs = ob.all(DIVISION).map((f) => ({ f, units: unitsOf(f) })).filter((d) => d.units.length);
    const armies = ob.all(ARMY).map((a) => ({ a, units: unitsOf(a), divs: divs.filter((d) => armyOf(d.f) === a) }))
      .filter((x) => x.units.length);
    const reserve = divs.filter((d) => !armyOf(d.f));
    const sel = this.ownSelection();
    const selDivs = new Set(sel.map(divisionOf));
    const pickedDivs = [...selDivs].filter(Boolean);
    const loose = g.units.filter((u) => u.owner === this.human && !u.regiment).length;
    // Offene Gruppe folgt der Auswahl (nur wenn sie sich ändert, sonst gilt die angetippte Karte)
    const selKey = sel.length + ':' + pickedDivs.map((d) => d.id + (armyOf(d) ? '>' + armyOf(d).id : '')).join(',');
    if (selKey !== this.ui.selKey) {
      this.ui.selKey = selKey;
      const selArmies = new Set(pickedDivs.map(armyOf));
      if (pickedDivs.length && selArmies.size === 1) this.ui.openGroup = [...selArmies][0] ? [...selArmies][0].id : 'reserve';
      else if (sel.length && !pickedDivs.length) this.ui.openGroup = 'reserve';
    }
    if (this.ui.openGroup !== 'reserve' && !armies.some((x) => x.a.id === this.ui.openGroup)) this.ui.openGroup = null;
    const open = this.ui.openGroup;
    // „＋“ auf einer Division verschiebt Kompanien; nicht anbieten, wenn ganze Verbände
    // (mehrere Divisionen, z. B. eine Armee) ausgewählt sind
    const wholeDivs = pickedDivs.length > 1 && sel.every((u) => u.regiment);
    const canAdd = (d) => !wholeDivs && strength(d.f) < DIVISION_MAX && sel.some((u) => divisionOf(u) !== d.f);
    const canAddArmy = (x) => pickedDivs.some((d) => armyOf(d) !== x.a);
    const supplyOf = (units) => units.reduce((s, u) => s + u.supply, 0) / units.length;
    const orgOf = (units) => units.reduce((s, u) => s + u.org, 0) / units.reduce((s, u) => s + u.maxOrg, 0);
    const stats = (units) => Math.round(strengthOf(units) * 20) + ':' + Math.round(supplyOf(units) * 20) + ':' + Math.round(orgOf(units) * 20);
    const holdInfo = (f) => {
      const hd = this.fronts.holdOf(f);
      return hd ? { hd, st: this.fronts.holdStatus(hd) } : null;
    };
    const holdSig = (f) => { const h = holdInfo(f); return h ? `${h.st.km}${h.st.level}` : '-'; };
    const sig = divs.map((d) => d.f.id + ':' + d.units.length + ':' + stats(d.units) + ':' + (armyOf(d.f) ? armyOf(d.f).id : '-') + ':' +
      (d.units.some((u) => this.ui.selection.has(u)) ? 1 : 0) + (canAdd(d) ? 1 : 0) + (d.f.refill ? 1 : 0) + (d.f.front ? 1 : 0) + holdSig(d.f)).join('|') +
      '#' + armies.map((x) => x.a.id + ':' + stats(x.units) + (canAddArmy(x) ? 1 : 0) + holdSig(x.a) + (x.units.every((u) => this.ui.selection.has(u)) ? 's' : '')).join('|') +
      `#${sel.length}:${loose}:${open}:${pickedDivs.length}`;
    if (sig === this.divBarSig) return;
    this.divBarSig = sig;
    const bars = (units) => {
      const sup = supplyOf(units), org = orgOf(units);
      return `<span class="str" title="Stärke"><i style="width:${Math.round(strengthOf(units) * 100)}%"></i></span>` +
        `<span class="org" title="Organisation ${Math.round(org * 100)} %"><i style="width:${Math.round(org * 100)}%"></i></span>` +
        `<span class="sup${sup < SUPPLY.warnBelow ? ' low' : ''}" title="Nachschub ${Math.round(sup * 100)} %"><i style="width:${Math.round(sup * 100)}%"></i></span>`;
    };
    const divCard = (d) => {
      const heavy = d.units.filter((u) => u.type === 'heavy').length / d.units.length;
      const regs = d.f.children.map((reg) => {
        const alive = reg.units.filter((u) => u.hp > 0).length;
        return natoIcon(reg.type === 'heavy' ? 1 : 0, 16, 11, alive ? 0.35 + 0.65 * alive / REGIMENT_MAX : 0.15, '', divisionColor(d.f));
      });
      const chosen = d.units.some((u) => this.ui.selection.has(u)) ? ' sel' : '';
      const add = canAdd(d) ? `<span class="add" data-act="add" data-id="${d.f.id}" title="Auswahl zur ${d.f.name} hinzufügen">＋</span>` : '';
      const own = holdInfo(d.f) ? ' · eigene Front' : '';
      return `<button class="divcard${chosen}${d.f.refill ? ' refill' : ''}${add ? ' can-add' : ''}" data-id="${d.f.id}" title="${d.f.name}: ${d.units.length} Kompanien${own}">${add}` +
        `<span class="sym">${natoIcon(heavy, 26, 18, 1, 'XX', divisionColor(d.f))}</span>` +
        `<span class="name">${d.f.name}${d.f.front ? ' <span class="fr" title="hält eine Front">〰</span>' : ''}</span>` +
        bars(d.units) + `<span class="regs">${regs.join('')}</span></button>`;
    };
    const LEVEL_NAMES = { good: 'gut besetzt', thin: 'dünn besetzt', weak: 'zu dünn besetzt', none: 'ohne Grenze' };
    const LEVEL_COLORS = { good: 'var(--good)', thin: 'var(--accent)', weak: 'var(--bad)', none: 'var(--grey)' };
    const armyCard = (x) => {
      const heavy = x.units.filter((u) => u.type === 'heavy').length / x.units.length;
      const chosen = x.units.every((u) => this.ui.selection.has(u)) ? ' sel' : '';
      const add = canAddArmy(x) ? `<span class="add" data-act="armyadd" data-id="${x.a.id}" title="Ausgewählte Divisionen zur ${x.a.name}">＋</span>` : '';
      const h = holdInfo(x.a);
      const front = !h ? 'ohne Front' : h.hd.falling ? 'Auffanglinie' : `${h.st.km} km<span class="dot" style="background:${LEVEL_COLORS[h.st.level]}" title="${LEVEL_NAMES[h.st.level]}"></span>`;
      return `<button class="divcard armycard${chosen}${open === x.a.id ? ' open' : ''}${add ? ' can-add' : ''}" data-army="${x.a.id}" style="border-left-color:${armyColor(x.a)}" title="${x.a.name}: ${x.divs.length} Divisionen, ${x.units.length} Kompanien">${add}` +
        `<span class="sym">${natoIcon(heavy, 30, 18, 1, 'XXXX', armyColor(x.a))}</span>` +
        `<span class="name">${x.a.name}</span><span class="meta">${x.divs.length} Div · ${front}</span>` +
        bars(x.units) + '</button>';
    };
    let bar = armies.map(armyCard).join('');
    if (reserve.length || loose) {
      bar += `<button class="divcard armycard reserve${open === 'reserve' ? ' open' : ''}" data-reserve="1" style="border-left-color:var(--grey)" title="Divisionen ohne Armee und Kompanien ohne Division">` +
        `<span class="sym">${natoIcon(0, 30, 18, 1, '', '#c9d2dc')}</span><span class="name">Reserve</span>` +
        `<span class="meta">${reserve.length} Div${loose ? ` · ${loose} Kp.` : ''}</span></button>`;
    }
    if (divs.length) bar += '<button class="divcard newarmy" data-act="newarmy" title="Neue Armee aus den ausgewählten Divisionen – oder eine Division hierher ziehen">＋ Armee</button>';
    $('divBar').innerHTML = bar;
    let row = '';
    if (open === 'reserve') {
      row = reserve.map(divCard).join('');
      if (loose) row += `<button class="divtool" data-act="auto" title="Kompanien ohne Division nach ihrer Lage zu Divisionen zusammenfassen">Auto-Gliederung (${loose} Kp.)</button>`;
    } else if (open) {
      const x = armies.find((y) => y.a.id === open);
      if (x) row = x.divs.map(divCard).join('');
    }
    $('divRow').innerHTML = row;
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
    const myC = g.citiesOf(this.human).length;
    const neutral = g.cities.filter((c) => !c.owner).length;
    const myU = g.unitsOf(this.human).length;
    // Je Seite: Städte und Landanteil; ausgeschiedene durchgestrichen
    const side = (p) => `<span class="side${g.alive(p) ? '' : ' out'}" title="${PLAYER_NAMES[p]}: ${Math.round(g.share[p] * 100)} % des Landes">` +
      `<span class="dot" style="background:${PLAYER_COLORS[p]}"></span>${g.allied(this.human, p) ? '🤝' : g.inTruce(this.human, p) ? '🕊' : ''}${g.citiesOf(p).length}` +
      `<small class="muted">·${Math.round(g.share[p] * 100)}%</small></span>`;
    $('hudCities').innerHTML = side(this.human) + ' <span class="muted">Städte</span> ' +
      g.players.filter((p) => p !== this.human).map(side).join(' ') +
      (neutral ? ` <span class="dot grey"></span>${neutral}` : '');
    $('hudUnits').innerHTML = `${myU}<span class="muted"> Einheiten</span>`;
    const e = g.eco[this.human];
    const k = (v) => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.floor(v)}`);
    $('hudEco').innerHTML =
      `<span title="Geld: Städte (nach Größe), Gebäude und Land bringen ${e.income.toFixed(1)}/s, der Handel zuletzt etwa ${e.tradeRate.toFixed(1)}/s. Kompanien und Gebäude kosten Geld.">💰 ${k(e.money)}<small class="muted"> +${(e.income + e.tradeRate).toFixed(1)}/s</small></span> ` +
      `<span title="Manpower: wächst aus der Bevölkerung deiner Städte (Vorrat höchstens ${k(e.mpCap)}), Kompanien kosten Manpower">👥 ${k(e.manpower)}<small class="muted"> +${e.mpRate.toFixed(0)}/s</small></span>`;
    const m = Math.floor(g.time / 60), s = Math.floor(g.time % 60);
    $('hudTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.updateCommands();
    this.updateTab();
    this.updateAlerts();
    // Höhe der oberen Leiste (bricht auf dem Handy um) für die Lage der übrigen Teile
    const top = $('topbar').offsetHeight;
    if (top !== this.topHeight) { this.topHeight = top; document.documentElement.style.setProperty('--top', `${top}px`); }
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

app.input = new Input(canvas, app);

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
        for (const ai of app.ais) ai.update(STEP);
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
$('mapChoice').innerHTML = MAPS.map((m) => `<button data-value="${m.id}">${m.name}</button>`).join('');
setupChoice('mapChoice', MAPS.some((m) => m.id === app.settings.map) ? app.settings.map : MAPS[0].id);
setupChoice('oppChoice', String(app.settings.opponents || 1));
// Handys spielen quer: beim Start Vollbild und Querformat sperren (geht auf Android). Wo das
// nicht geht (iPhone), bittet im Hochformat ein Hinweis ums Drehen (#rotateHint) und das
// laufende Spiel hält an.
const isPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
function lockLandscape() {
  if (!isPhone() || !screen.orientation?.lock) return;
  const el = document.documentElement;
  const full = document.fullscreenElement || !el.requestFullscreen ? null : el.requestFullscreen({ navigationUI: 'hide' });
  Promise.resolve(full).then(() => screen.orientation.lock('landscape')).catch(() => { /* nicht unterstützt */ });
}
const portrait = matchMedia('(orientation: portrait) and (pointer: coarse) and (max-width: 600px)');
portrait.addEventListener('change', () => {
  if (portrait.matches && app.game && !app.paused && $('menu').hidden) app.togglePause();
});
$('startBtn').onclick = () => {
  lockLandscape();
  app.start(randomSeed(), choice('mapChoice'), choice('diffChoice'), +choice('oppChoice'));
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
  $('menu').hidden = false;
  $('resumeBtn').hidden = false;
};
$('resumeBtn').onclick = () => { lockLandscape(); $('menu').hidden = true; if (app.paused) app.togglePause(); };
$('selectBtn').onclick = () => app.setSelectMode(!app.ui.selectMode);
for (const b of document.querySelectorAll('#topbar .tabs button')) b.onclick = () => app.toggleTab(b.dataset.tab);
$('sideClose').onclick = () => app.setTab(null);
$('alerts').onclick = (e) => { const t = e.target.closest('[data-alert]'); if (t && app.game) app.alertAction(t.dataset.alert); };
$('logiBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (t && app.game) app.logiAction(t);
});
$('troopBody').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-act]');
  if (t && app.game) app.troopAction(t);
});
$('diploBody').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-act]');
  if (t && !t.disabled && app.game) app.diploAction(t);
});
$('offerYes').onclick = () => { if (app.game) { app.game.answerOffer(app.offerId, true); app.updateDiplo(); } };
$('offerNo').onclick = () => { if (app.game) { app.game.answerOffer(app.offerId, false); app.updateDiplo(); } };
for (const id of ['buildBody', 'cityBody']) {
  $(id).addEventListener('click', (e) => {
    const t = e.target.closest('button[data-act]');
    if (t && !t.disabled && app.game) app.buildAction(t);
  });
  $(id).addEventListener('change', (e) => {
    if (e.target.dataset.act === 'city') { app.ui.buildCity = +e.target.value; app.buildSig = null; app.updateBuildPanel(); }
  });
}
$('allBtn').onclick = () => app.selectAll();
// Armeeleiste und Divisionsreihe
function onBarClick(e) {
  if (!app.game) return;
  const tool = e.target.closest('[data-act]');
  if (tool) {
    const id = +tool.dataset.id;
    const act = tool.dataset.act;
    if (act === 'add') app.addToDivision(id);
    else if (act === 'armyadd') app.addToArmy(id);
    else if (act === 'newarmy') app.newArmy();
    else if (act === 'auto') app.autoOrganize();
    return;
  }
  const army = e.target.closest('[data-army]');
  if (army) { app.ui.openGroup = +army.dataset.army; app.selectArmy(+army.dataset.army); return; }
  if (e.target.closest('[data-reserve]')) {
    app.ui.openGroup = app.ui.openGroup === 'reserve' ? null : 'reserve';
    app.divBarSig = null;
    app.updateDivBar();
    return;
  }
  const card = e.target.closest('.divcard');
  if (card) app.selectDivision(+card.dataset.id);
}
$('divBar').onclick = onBarClick;
$('divRow').onclick = onBarClick;

// Divisionskarten ziehen: aus der Divisionsreihe auf eine Armeekarte, die Reserve oder
// „＋ Armee“. Waagrecht scrollt die Reihe weiter; erst ein Zug nach oben oder unten hebt
// die Karte an
let cardDrag = null;
const dropTarget = (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el && el.closest('#divBar [data-army], #divBar [data-reserve], #divBar [data-act="newarmy"]');
};
$('divRow').addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.divcard[data-id]');
  if (!card || e.target.closest('[data-act]') || e.button > 0 || !app.game) return;
  cardDrag = { card, id: +card.dataset.id, x: e.clientX, y: e.clientY, pointer: e.pointerId, ghost: null, over: null };
});
window.addEventListener('pointermove', (e) => {
  const d = cardDrag;
  if (!d || e.pointerId !== d.pointer) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (!d.ghost) {
    if (Math.abs(dy) < 10 || Math.abs(dy) < Math.abs(dx)) { if (Math.abs(dx) > 10) cardDrag = null; return; }
    d.ghost = d.card.cloneNode(true);
    d.ghost.classList.add('dragghost');
    document.body.appendChild(d.ghost);
    d.card.classList.add('lifted');
  }
  d.ghost.style.left = `${e.clientX - d.ghost.offsetWidth / 2}px`;
  d.ghost.style.top = `${e.clientY - d.ghost.offsetHeight / 2}px`;
  const over = dropTarget(e);
  if (over !== d.over) {
    if (d.over) d.over.classList.remove('drop');
    if (over) over.classList.add('drop');
    d.over = over;
  }
});
const endDrag = (e, drop) => {
  const d = cardDrag;
  if (!d || e.pointerId !== d.pointer) return;
  cardDrag = null;
  if (!d.ghost) return;
  d.ghost.remove();
  d.card.classList.remove('lifted');
  if (d.over) d.over.classList.remove('drop');
  if (!drop || !d.over) return;
  const t = d.over;
  const army = t.dataset.army && app.game.orbat[app.human].all(ARMY).find((a) => a.id === +t.dataset.army);
  app.moveDivision(d.id, army || (t.dataset.reserve ? null : 'new'));
};
window.addEventListener('pointerup', (e) => endDrag(e, true));
window.addEventListener('pointercancel', (e) => endDrag(e, false));
$('showFrontsBtn').onclick = () => app.toggleShowFronts();
$('supplyBtn').onclick = () => app.toggleSupply();
$('planBar').querySelector('.tools').onclick = (e) => { const t = e.target.closest('[data-tool]'); if (t && !t.disabled) app.toggleTool(t.dataset.tool); };
$('execBtn').onclick = () => app.execute();
$('rotateBtn').onclick = () => {
  const fs = app.panelFronts(), on = !fs.every((f) => f.rotate);
  for (const f of fs) { f.rotate = on; f.hold.rotate = on; }
  app.updateCommands();
};
$('rejoinBtn').onclick = () => { for (const f of app.panelFronts()) app.fronts.rejoin(f); app.updateCommands(); };
$('pickRandom').onclick = () => app.pickStart(null);
$('toolDone').onclick = () => app.setFrontMode(null);
$('toolOpts').onclick = (e) => { const t = e.target.closest('[data-opt]'); if (t && app.game) app.toolOption(t.dataset.opt, t); };
$('cmdClose').onclick = () => { app.ui.selection.clear(); app.selectFront(null); app.updateSelectionInfo(); };
$('haltBtn').onclick = () => app.stopSelection();
$('newDivBtn').onclick = () => app.newDivision();
$('unDivBtn').onclick = () => app.removeFromDivision();
$('refillBtn').onclick = () => { const d = app.selectedDivision(); if (d) app.toggleRefill(d.id); };
$('newArmyBtn').onclick = () => app.newArmy();
$('unArmyBtn').onclick = () => app.removeFromArmy();
$('centerBtn').onclick = () => app.fitCamera();
$('againBtn').onclick = () => { lockLandscape(); app.start(app.current.seed, app.current.map, app.current.difficulty, app.current.opponents); };
$('newBtn').onclick = () => { lockLandscape(); app.start(randomSeed(), app.current.map, app.current.difficulty, app.current.opponents); };
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
