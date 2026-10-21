import { loadMap, MAPS } from './map.js?v=100';
import { Game } from './game.js?v=100';
import { AI } from './ai.js?v=100';
import { Renderer, isFrontShown } from './render.js?v=100';
import { Input } from './input.js?v=100';
import { formationSlots } from './formation.js?v=100';
import { FrontManager, chainLength, frontBadge } from './fronts.js?v=100';
import { DIVISION, ARMY, DIVISION_MAX, REGIMENT_MAX, unitsOf, divisionColor, divisionOf, armyOf, armyColor, strength } from './orbat.js?v=100';
import { DIFFICULTY, SUPPLY, KM, CELL, PLAYER_COLORS, PLAYER_NAMES, CITY_RADIUS, UNIT_TYPES, TEMPLATES, UPGRADES, BUILDINGS, BUILDING_MAX, DIPLOMACY } from './config.js?v=100';
import { templateCost } from './production.js?v=100';

const STEP = 1 / 30;
const $ = (id) => document.getElementById(id);
const VERSION = '100'; // für Kartendaten, siehe scripts/bump-version.sh

const app = {
  game: null,
  ais: [],
  renderer: null,
  human: 1,
  cam: { x: 0, y: 0, zoom: 1, min: 0.2, max: 6 },
  ui: { selection: new Set(), drawPath: null, box: null, revealAll: false, selectMode: false, frontMode: null, front: null, showFronts: false, showSupply: false, armyClosed: new Set(), hover: null },
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
    this.ui.showFronts = false;
    $('showFrontsBtn').classList.remove('active');
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
      ? this.fronts.shareBorder(divs, anchors)
      : (divs.length > 1 ? this.fronts.splitLine(divs, line) : [this.fronts.assign(divs[0], 'line', line)]);
    if (made.length === 1) this.selectFront(made[0]);
    this.divBarSig = null;
    this.updateSelectionInfo();
    const what = anchors ? 'den Grenzabschnitt' : 'die neue Front';
    const n = Math.max(divs.length, made.length); // Divisionen, die dort schon standen, teilen mit
    this.toast(n > 1 ? `${n} Divisionen teilen sich ${what}` : `${divs[0].name} hält ${what}`);
  },

  // Grenze: die ausgewählten Divisionen kommen zu denen an der Grenze dazu, alle teilen sie
  // sich nach Stärke (eine Division allein hält die ganze Grenze)
  borderFront() {
    const divs = this.frontDivisions();
    if (!divs) return;
    // Wer schon an der Grenze steht, bleibt dort; die Grenze wird unter allen neu aufgeteilt
    const made = this.fronts.shareBorder(divs);
    if (made.length === 1) this.selectFront(made[0]);
    this.divBarSig = null;
    this.updateSelectionInfo();
    if (!made.length || !made.some((f) => f.chains.length)) this.toast('Keine Grenze zum Gegner gefunden');
    else if (made.length > divs.length) this.toast(`${made.length} Divisionen teilen sich jetzt die Grenze`);
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

  // --- Diplomatie -------------------------------------------------------------------

  toggleDiplo(open = $('diploPanel').hidden) {
    $('diploPanel').hidden = !open;
    $('diploBtn').classList.toggle('active', open);
    this.diploSig = null;
    if (open) this.updateDiplo();
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
    if ($('diploPanel').hidden) return;
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const rows = g.players.filter((p) => p !== me).map((p) => {
      const ally = g.allied(me, p), out = !g.alive(p);
      const since = g.allySince.get(g.pairKey(me, p));
      const pending = g.offers.some((o) => o.from === me && o.to === p);
      let status = out ? 'ausgeschieden' : ally ? `verbündet${since !== undefined ? ` · noch ${mmss(DIPLOMACY.duration - (g.time - since))}` : ''}` : 'Krieg';
      if (!out && g.isTraitor(p)) status += ' · Verräter';
      let btn = '';
      if (!out && ally) btn = `<button data-act="break" data-p="${p}" title="Bündnis brechen – danach giltst du ${DIPLOMACY.traitorTime / 60} Minuten als Verräter">Brechen</button>`;
      else if (!out && pending) btn = '<button disabled>Angebot läuft …</button>';
      else if (!out) {
        const wait = g.canAlly(me, p) ? 0 : Math.ceil(g.allyCooldown.get(g.pairKey(me, p)) - g.time);
        btn = `<button data-act="offer" data-p="${p}"${wait ? ` disabled title="Nach einem ausgelaufenen Bündnis erst in ${wait} s wieder"` : ''}>${wait ? `in ${wait} s` : 'Bündnis anbieten'}</button>`;
      }
      return `<div class="diploRow${out ? ' out' : ''}"><span class="dot" style="background:${PLAYER_COLORS[p]}"></span>` +
        `<span class="who"><b>${PLAYER_NAMES[p]}</b><small>${status} · ${g.citiesOf(p).length} Städte · ${Math.round(g.share[p] * 100)} % Land</small></span>${btn}</div>`;
    });
    const note = `<p class="muted">Verbündete kämpfen nicht gegeneinander, nehmen sich kein Land und handeln mit Bonus. Bündnisse laufen nach ${DIPLOMACY.duration / 60} Minuten aus; wer bricht, gilt ${DIPLOMACY.traitorTime / 60} Minuten als Verräter. Gewinnen kann nur eine Seite allein.${g.isTraitor(me) ? ' <b>Du giltst gerade als Verräter – die KI lehnt Bündnisse ab.</b>' : ''}</p>`;
    const html = rows.join('') + note;
    if (html !== this.diploSig) { this.diploSig = html; $('diploBody').innerHTML = html; }
  },

  diploAction(t) {
    const g = this.game, me = this.human, p = +t.dataset.p;
    if (t.dataset.act === 'offer') {
      if (g.offerAlliance(me, p)) this.toast(`Bündnis an ${PLAYER_NAMES[p]} angeboten – die Antwort kommt gleich`);
    } else if (t.dataset.act === 'break') g.breakAlliance(me, p);
    this.diploSig = null;
    this.updateDiplo();
  },

  // --- Baumenü ---------------------------------------------------------------------

  toggleBuild(open = $('buildPanel').hidden) {
    $('buildPanel').hidden = !open;
    $('buildBtn').classList.toggle('active', open);
    this.buildSig = null;
    if (open) this.updateBuildPanel();
  },

  // Eigene Stadt antippen: dort ausbilden
  openBuildFor(city) {
    this.ui.buildCity = city.id;
    this.toggleBuild(true);
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
    if (!this.game || $('buildPanel').hidden) return;
    const g = this.game, p = this.human, e = g.eco[p], prod = g.production;
    const city = this.buildCity();
    const div = this.selectedDivision();
    const can = (c) => e.money >= c.money && e.manpower >= c.manpower;
    const orders = prod.ordersOf(p);
    const unitCost = (t) => UNIT_TYPES[t].cost;
    const costs = [unitCost('light'), unitCost('heavy'), ...TEMPLATES.map(templateCost),
      ...Object.values(UPGRADES).flatMap((u) => u.cost.map((m) => ({ money: m, manpower: 0 })))];
    const pend = div ? prod.pendingFor(div) : 0;
    const sig = [city && city.id, g.citiesOf(p).map((c) => c.id + ':' + g.citySize(c)).join(','),
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
        h += '<h4>Stadt</h4><select data-act="city">' + g.citiesOf(p)
          .sort((a, b) => g.citySize(b) - g.citySize(a) || a.name.localeCompare(b.name))
          .map((c) => `<option value="${c.id}"${c === city ? ' selected' : ''}>${c.name}${c.capitalOf === p ? ' ★' : ''} – ${sizeName[g.citySize(c)]}, ${prod.citySlots(c)} gleichzeitig</option>`).join('') + '</select>';
        const tanks = prod.canTrain(city, 'heavy');
        h += '<h4>Kompanien</h4><div class="buildRow">' + ['light', 'heavy'].map((t) =>
          `<button data-act="unit" data-type="${t}"${can(unitCost(t)) && prod.canTrain(city, t) ? '' : ' disabled'}>${t === 'light' ? '＋ Infanterie' : '＋ Panzer'}<small>${prod.canTrain(city, t) ? price(unitCost(t), UNIT_TYPES[t].buildTime) : 'braucht eine Fabrik in der Stadt'}</small></button>`).join('') + '</div>';
        h += '<h4>Divisionen</h4><div class="buildRow">' + TEMPLATES.map((t) =>
          `<button data-act="template" data-id="${t.id}"${can(templateCost(t)) && (tanks || !t.heavy) ? '' : ' disabled'}>${t.name}<small>${t.light} Inf. + ${t.heavy} Pz. · ${price(templateCost(t))}</small></button>`).join('') + '</div>';
        // Stadt ausbauen: je Gebäude Stufe, Wirkung und nächste Stufe
        const k = city.construction;
        h += `<h4>${city.name} ausbauen</h4>`;
        if (k) h += `<ul class="queue"><li data-build="${city.id}"><span class="what">${BUILDINGS[k.key].icon} ${BUILDINGS[k.key].name} Stufe ${city.buildings[k.key] + 1} im Bau</span><span class="bar"><i></i></span><button data-act="unbuild" title="Bau abbrechen (Kosten zurück)">✕</button></li></ul>`;
        h += '<div class="buildRow">' + Object.entries(BUILDINGS).filter(([, b]) => !b.coastal || city.coastal).map(([key, b]) => {
          const lvl = city.buildings[key], next = prod.nextBuilding(city, key);
          const label = `${b.icon} ${b.name}${lvl ? ` ${lvl}/${BUILDING_MAX}` : ''}`;
          if (!next) return `<button disabled>${label}<small>${b.effect} je Stufe · voll ausgebaut</small></button>`;
          return `<button data-act="build" data-key="${key}"${!k && can(next.cost) ? '' : ' disabled'}>${label}<small>${b.effect} je Stufe · ${next.cost.money}💰 · ${Math.round(next.time)} s</small></button>`;
        }).join('') + '</div>';
      }
      if (div) {
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
      h += `<h4>Aufträge (${orders.length})</h4>` + (orders.length ? '<ul class="queue">' + orders.slice(0, 14).map((o) =>
        `<li data-order="${o.id}"><span class="what">${typeName(o.type)} · ${g.cities[o.city].name}${o.division ? ' → ' + o.division.name : o.group ? ' → neue Division' : ''}</span>` +
        `<span class="bar"><i></i></span><button data-act="cancel" data-id="${o.id}" title="Abbrechen (Kosten zurück)">✕</button></li>`).join('') + '</ul>' +
        (orders.length > 14 ? `<p class="muted">… und ${orders.length - 14} weitere</p>` : '') : '<p class="muted">Keine Aufträge.</p>');
      $('buildBody').innerHTML = h;
    }
    // Fortschritt der Aufträge und des Baus
    const bl = $('buildBody').querySelector('li[data-build]');
    if (bl && city && city.construction) bl.querySelector('i').style.width = `${Math.min(100, city.construction.timer / city.construction.time * 100)}%`;
    for (const li of $('buildBody').querySelectorAll('li[data-order]')) {
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
        if (ev.by === this.human) this.toast(`Bündnis mit ${PLAYER_NAMES[ev.other]} gebrochen – ${DIPLOMACY.traitorTime / 60} Minuten giltst du als Verräter`, 'bad');
        else if (ev.other === this.human) this.toast(`⚠ ${PLAYER_NAMES[ev.by]} hat das Bündnis gebrochen!`, 'bad');
        else this.toast(`${PLAYER_NAMES[ev.by]} bricht das Bündnis mit ${PLAYER_NAMES[ev.other]}`);
        this.diploSig = null;
      } else if (ev.type === 'allianceExpired' && (ev.a === this.human || ev.b === this.human)) {
        this.toast(`Das Bündnis mit ${PLAYER_NAMES[ev.a === this.human ? ev.b : ev.a]} ist ausgelaufen`);
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
    const why = won
      ? (g.players.some((p) => p !== this.human && g.alive(p)) ? `Du hältst ${Math.round(g.share[this.human] * 100)} % des Landes.` : 'Alle Gegner sind ausgeschieden.')
      : winner > 0 ? `${PLAYER_NAMES[winner]} hält ${Math.round(g.share[winner] * 100)} % des Landes.` : 'Du hast keine Städte und Truppen mehr.';
    $('endStats').innerHTML =
      `${why}<br>Spielzeit: ${m}:${String(s).padStart(2, '0')}<br>` +
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
    const myC = g.citiesOf(this.human).length;
    const neutral = g.cities.filter((c) => !c.owner).length;
    const myU = g.unitsOf(this.human).length;
    // Je Seite: Städte und Landanteil; ausgeschiedene durchgestrichen
    const side = (p) => `<span class="side${g.alive(p) ? '' : ' out'}" title="${PLAYER_NAMES[p]}: ${Math.round(g.share[p] * 100)} % des Landes">` +
      `<span class="dot" style="background:${PLAYER_COLORS[p]}"></span>${g.allied(this.human, p) ? '🤝' : ''}${g.citiesOf(p).length}` +
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
    this.updateBuildPanel();
    this.updateDiplo();
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
$('buildBtn').onclick = () => app.toggleBuild();
$('diploBtn').onclick = () => app.toggleDiplo();
$('diploClose').onclick = () => app.toggleDiplo(false);
$('diploBody').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-act]');
  if (t && !t.disabled && app.game) app.diploAction(t);
});
$('offerYes').onclick = () => { if (app.game) { app.game.answerOffer(app.offerId, true); app.updateDiplo(); } };
$('offerNo').onclick = () => { if (app.game) { app.game.answerOffer(app.offerId, false); app.updateDiplo(); } };
$('buildClose').onclick = () => app.toggleBuild(false);
$('buildBody').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-act]');
  if (t && !t.disabled && app.game) app.buildAction(t);
});
$('buildBody').addEventListener('change', (e) => {
  if (e.target.dataset.act === 'city') { app.ui.buildCity = +e.target.value; app.buildSig = null; app.updateBuildPanel(); }
});
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
$('pickRandom').onclick = () => app.pickStart(null);
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
$('againBtn').onclick = () => { lockLandscape(); app.start(app.current.seed, app.current.map, app.current.difficulty, app.current.opponents); };
$('newBtn').onclick = () => { lockLandscape(); app.start(randomSeed(), app.current.map, app.current.difficulty, app.current.opponents); };
$('endMenuBtn').onclick = () => { $('end').hidden = true; $('menu').hidden = false; $('resumeBtn').hidden = true; };

// Fenster (Befehlsfeld, Baumenü) verschieben (Titelzeile ziehen) und größer oder kleiner
// machen (Griff unten rechts); Doppelklick bzw. Doppeltippen auf die Titelzeile setzt beides
// zurück. Lage und Größe bleiben gespeichert, das Fenster bleibt immer ganz im Bild.
// base/origin: Verschiebung und Bezugspunkt der Grundstellung aus dem CSS
const PANEL_SCALE = [0.6, 1.6];
function makeMovable(panel, key, base, origin) {
  const head = panel.querySelector('.cmdHead');
  const grip = panel.querySelector('.cmdResize');
  let pos = (() => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(key, JSON.stringify(pos)); } catch { /* egal */ } };

  function place() {
    const st = panel.style;
    const s = pos.scale || 1;
    if (pos.x === undefined) {
      st.left = st.top = st.bottom = st.right = '';
      st.transformOrigin = origin;
      st.transform = s === 1 ? '' : `${base}scale(${s})`;
      return;
    }
    st.transformOrigin = '0 0';
    st.transform = `scale(${s})`;
    st.bottom = st.right = 'auto';
    st.left = pos.x + 'px';
    st.top = pos.y + 'px';
    if (panel.hidden) return;
    const r = panel.getBoundingClientRect();
    const x = Math.max(0, Math.min(pos.x, window.innerWidth - r.width));
    const y = Math.max(0, Math.min(pos.y, window.innerHeight - r.height));
    if (x !== pos.x || y !== pos.y) {
      pos.x = x; pos.y = y;
      st.left = x + 'px'; st.top = y + 'px';
    }
  }

  // Ab dem ersten Verschieben oder Skalieren gilt eine feste Lage (linke obere Ecke)
  function pin() {
    if (pos.x !== undefined) return;
    const r = panel.getBoundingClientRect();
    pos.x = r.left; pos.y = r.top;
    place();
  }

  function drag(handle, onMove) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, select') || e.button > 0) return;
      e.preventDefault();
      pin();
      handle.setPointerCapture(e.pointerId);
      const start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, s: pos.scale || 1, r: panel.getBoundingClientRect() };
      panel.classList.add('dragging');
      const move = (ev) => { onMove(ev, start); place(); };
      const up = () => {
        panel.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // Doppelklick/Doppeltippen (vor dem Ziehen geprüft, damit es kein Ziehen startet)
  let lastTap = 0;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select')) return;
    const now = performance.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      pos = {};
      place();
      save();
      e.stopImmediatePropagation();
      return;
    }
    lastTap = now;
  });
  drag(head, (ev, st) => {
    pos.x = st.x + ev.clientX - st.px;
    pos.y = st.y + ev.clientY - st.py;
  });
  drag(grip, (ev, st) => {
    // Neue Breite bis zum Zeiger, Höhe wächst im gleichen Verhältnis mit
    const k = Math.max((ev.clientX - st.r.left) / st.r.width, (ev.clientY - st.r.top) / st.r.height);
    pos.scale = Math.max(PANEL_SCALE[0], Math.min(PANEL_SCALE[1], Math.round(st.s * k * 100) / 100));
  });
  new ResizeObserver(() => place()).observe(panel);
  window.addEventListener('resize', place);
  place();
}
makeMovable($('cmdPanel'), 'wod-cmdpanel', 'translateX(-50%) ', '50% 100%');
makeMovable($('buildPanel'), 'wod-buildpanel', '', '100% 0');
makeMovable($('diploPanel'), 'wod-diplopanel', '', '100% 0');

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
