import { CITY_RADIUS } from './config.js?v=69';
import { divisionOf, unitsOf } from './orbat.js?v=69';

const TAP_SLOP = 8; // Pixel, bis eine Berührung als Ziehen gilt

export class Input {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.pointers = new Map();
    this.gesture = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.cancel(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e));
  }

  get ui() { return this.app.ui; }

  toWorld(sx, sy) {
    const cam = this.app.cam;
    return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
  }

  // Eigene Truppen unter dem Zeiger: Trefferfläche ist das gezeichnete Symbol (siehe
  // Renderer.hits), einzelne Kompanien vor Gruppen; am Handy mindestens fingerbreit
  pickHit(w, touch) {
    const r = this.app.renderer;
    if (!r || !r.hits) return null;
    const px = 1 / this.app.cam.zoom;
    const min = (touch ? 11 : 5) * px;
    let best = null, bd = Infinity;
    for (const h of r.hits) {
      const ax = Math.max(h.hw, min), ay = Math.max(h.hh, min);
      const dx = Math.abs(w.x - h.x), dy = Math.abs(w.y - h.y);
      if (dx > ax || dy > ay) continue;
      const d = Math.hypot(dx / ax, dy / ay) - (h.single ? 1 : 0);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  // Klickfolge auf eigene Truppen: Gruppe -> ganze Division -> einzelne Kompanie unter dem
  // Zeiger -> wieder die Gruppe. Stufen mit derselben Auswahl werden übersprungen;
  // mit Umschalt kommt die Gruppe zur Auswahl hinzu
  clickTroops(hit, w, additive) {
    const sel = this.ui.selection;
    const dist = (u) => Math.hypot(u.x - w.x, u.y - w.y);
    const near = hit.members.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    const div = divisionOf(near);
    const steps = [hit.members, div ? unitsOf(div) : null, [near]].filter(Boolean);
    const same = (a, b) => a.length === b.length && a.every((u) => b.includes(u));
    const uniq = steps.filter((st, i) => !steps.slice(0, i).some((t) => same(st, t)));
    if (additive) { for (const u of uniq[0]) sel.add(u); return; }
    const k = uniq.findIndex((st) => same(st, [...sel]));
    sel.clear();
    if (k < 0) { for (const u of uniq[0]) sel.add(u); return; }
    if (uniq.length === 1) return; // einzelne Kompanie erneut angeklickt: Auswahl aufheben
    for (const u of uniq[(k + 1) % uniq.length]) sel.add(u);
  }

  pickOwnCity(w) {
    const { game, human, cam } = this.app;
    const tol = CITY_RADIUS + Math.max(2, 6 / cam.zoom);
    return game.cities.find((c) => c.owner === human && Math.hypot(c.x - w.x, c.y - w.y) < tol) || null;
  }

  down(e) {
    if (!this.app.game) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, sx: e.offsetX, sy: e.offsetY });
    if (this.pointers.size === 2) {
      // Zwei Finger: zoomen und verschieben, laufende Geste abbrechen
      this.ui.drawPath = null;
      this.ui.box = null;
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }
    if (this.pointers.size > 2) return;
    const w = this.toWorld(e.offsetX, e.offsetY);
    const mouse = e.pointerType === 'mouse';
    // PC: rechte Taste bewegt (Klick) oder verschiebt die Karte (Ziehen), mittlere verschiebt
    if (mouse && (e.button === 1 || e.button === 2)) {
      this.gesture = { kind: 'pan', moved: false, button: e.button, world: w, shift: e.shiftKey };
      return;
    }
    if (this.ui.frontMode) {
      this.gesture = { kind: 'front', moved: false };
      this.ui.drawPath = [w];
      return;
    }
    // PC: Linksziehen zieht immer einen Rahmen; Handy: ein Finger verschiebt die Karte
    // (Rahmen über „▢ Auswahl“). Ein Klick bzw. Antippen ohne Ziehen wählt aus oder bewegt.
    const boxMode = mouse || this.ui.selectMode;
    this.gesture = { kind: boxMode ? 'box' : 'pan', moved: false, world: w, shift: e.shiftKey, touch: !mouse };
  }

  move(e) {
    // PC: zeigen, was ein Klick auswählen würde
    if (!this.gesture && e.pointerType === 'mouse' && this.app.game) {
      const hit = this.pickHit(this.toWorld(e.offsetX, e.offsetY), false);
      this.ui.hover = hit ? hit.members : null;
      this.canvas.style.cursor = hit ? 'pointer' : '';
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.gesture) return;
    const lx = p.x, ly = p.y;
    p.x = e.offsetX; p.y = e.offsetY;
    const g = this.gesture;
    const cam = this.app.cam;
    if (g.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.app.zoomAt(g.mid.x, g.mid.y, dist / g.dist);
      cam.x -= (mid.x - g.mid.x) / cam.zoom;
      cam.y -= (mid.y - g.mid.y) / cam.zoom;
      this.app.clampCamera();
      g.dist = dist; g.mid = mid;
      return;
    }
    if (!g.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_SLOP) g.moved = true;
    if (g.kind === 'pan') {
      cam.x -= (p.x - lx) / cam.zoom;
      cam.y -= (p.y - ly) / cam.zoom;
      this.app.clampCamera();
    } else if (g.kind === 'front') {
      const w = this.toWorld(p.x, p.y);
      const path = this.ui.drawPath;
      const last = path[path.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) >= Math.max(5, 8 / cam.zoom)) path.push(w);
    } else if (g.kind === 'box' && g.moved) {
      this.ui.box = { x0: p.sx, y0: p.sy, x1: p.x, y1: p.y };
    }
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!p || !g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    this.gesture = null;
    const sel = this.ui.selection;
    if (g.kind === 'front') {
      const path = this.ui.drawPath || [];
      this.ui.drawPath = null;
      if (g.moved && path.length >= 2) this.app.finishFront(path);
    } else if (g.kind === 'box') {
      this.ui.box = null;
      if (g.moved) {
        const a = this.toWorld(Math.min(p.sx, p.x), Math.min(p.sy, p.y));
        const b = this.toWorld(Math.max(p.sx, p.x), Math.max(p.sy, p.y));
        if (!g.shift) sel.clear();
        for (const u of this.app.game.units) {
          if (u.owner === this.app.human && u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) sel.add(u);
        }
        if (this.ui.selectMode && e.pointerType !== 'mouse') this.app.setSelectMode(false);
      } else this.tap(g, e);
    } else if (g.kind === 'pan') {
      if (!g.moved) {
        if (g.button === 2) this.app.moveSelectionTo(g.world, g.shift); // Rechtsklick: dorthin
        else if (g.button === undefined) this.tap(g, e);
      }
    }
    this.app.updateSelectionInfo();
  }

  // Klick (PC, links) bzw. Antippen (Handy) ohne Ziehen
  tap(g, e) {
    const sel = this.ui.selection;
    const hit = this.pickHit(g.world, g.touch);
    if (hit) { this.clickTroops(hit, g.world, g.shift); return; }
    const badge = this.app.pickFrontBadge(g.world);
    const f = badge || this.app.pickFront(g.world);
    if (f && (badge || !sel.size || f === this.ui.front)) {
      // Front antippen = ihre Division auswählen (öffnet das Frontmenü)
      if (f === this.ui.front) { sel.clear(); this.app.selectFront(null); }
      else this.app.selectDivision(f.division.id, false);
      return;
    }
    const city = this.pickOwnCity(g.world);
    if (city && !sel.size) {
      city.prodType = city.prodType === 'light' ? 'heavy' : 'light';
      this.app.toast(city.prodType === 'heavy' ? 'Stadt baut jetzt: Panzer (schwer)' : 'Stadt baut jetzt: Infanterie (leicht)');
      return;
    }
    if (!sel.size) return;
    if (g.touch) this.app.moveSelectionTo(g.world, false); // Handy: Antippen bewegt die Auswahl
    else if (!g.shift) sel.clear();                         // PC: Klick ins Leere hebt sie auf
  }

  cancel(e) {
    this.pointers.delete(e.pointerId);
    this.gesture = null;
    this.ui.drawPath = null;
    this.ui.box = null;
  }

  wheel(e) {
    e.preventDefault();
    if (!this.app.game) return;
    this.app.zoomAt(e.offsetX, e.offsetY, Math.pow(1.0015, -e.deltaY));
  }

  key(e) {
    const app = this.app;
    if (!app.game || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'p') { e.preventDefault(); app.togglePause(); }
    else if (k === 'escape') {
      this.ui.selection.clear();
      app.setFrontMode(null);
      app.selectFront(null);
      app.updateSelectionInfo();
    } else if (k === 'f') {
      // Front und Grenze nur, wenn sie angeboten werden (Divisionen ausgewählt)
      if (this.ui.frontMode || app.selectedDivisions().length) app.toggleFrontMode();
    } else if (k === 'g') {
      if (app.selectedDivisions().length) app.borderFront();
    }
    else if (k === 'v') app.toggleShowFronts();
    else if (k === 'n') app.toggleSupply();
    else if (k === 'd') {
      if (e.shiftKey) app.removeFromDivision();
      else app.newDivision();
    }
    else if (k === 'a' && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      app.selectAll();
    } else if (k === 's') app.stopSelection();
    else if (k === '1' || k === '2' || k === '3') app.setSpeed(+k);
  }
}
