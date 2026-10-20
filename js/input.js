import { CITY_RADIUS } from './config.js?v=54';

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

  pickOwnUnit(w) {
    const { game, human, cam } = this.app;
    const tol = Math.max(10, 16 / cam.zoom);
    let best = null, bd = Infinity;
    for (const u of game.units) {
      if (u.owner !== human) continue;
      const d = Math.hypot(u.x - w.x, u.y - w.y) - u.r;
      if (d < tol && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // Herausgezoomt: ganze Division unter dem Finger
  pickOwnDivision(w) {
    const r = this.app.renderer;
    if (!r || !r.divHits || !r.divHits.length) return null;
    let best = null, bd = Infinity;
    for (const h of r.divHits) {
      const d = Math.hypot(h.x - w.x, h.y - w.y);
      if (d < h.r * 1.4 && d < bd) { bd = d; best = h; }
    }
    return best;
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
    if (mouse && (e.button === 1 || e.button === 2)) {
      this.gesture = { kind: 'pan', moved: false, button: e.button };
      return;
    }
    if (this.ui.frontMode) {
      this.gesture = { kind: 'front', moved: false };
      this.ui.drawPath = [w];
      return;
    }
    const badge = this.app.pickFrontBadge(w);
    const div = badge ? null : this.pickOwnDivision(w);
    const u = badge ? null : div ? div.members[0] : this.pickOwnUnit(w);
    if (u) {
      this.gesture = { kind: 'path', unit: u, members: div ? div.members : null, moved: false, shift: e.shiftKey };
      this.ui.drawPath = [{ x: u.x, y: u.y }];
      return;
    }
    const boxMode = mouse || this.ui.selectMode;
    this.gesture = { kind: boxMode ? 'box' : 'pan', moved: false, city: this.pickOwnCity(w), world: w, shift: e.shiftKey, badge };
  }

  move(e) {
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
    } else if (g.kind === 'path' || g.kind === 'front') {
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
    if (g.kind === 'path') {
      const path = this.ui.drawPath || [];
      this.ui.drawPath = null;
      if (!g.moved || path.length < 2) {
        // Antippen einer Einheit oder Division: Auswahl umschalten
        const tapped = g.members || [g.unit];
        if (tapped.every((u) => sel.has(u))) for (const u of tapped) sel.delete(u);
        else {
          if (e.pointerType === 'mouse' && !g.shift) sel.clear();
          for (const u of tapped) sel.add(u);
        }
      } else {
        const own = g.members || [g.unit];
        const group = own.some((u) => sel.has(u)) && sel.size > 1 ? [...new Set([...sel, ...own])] : own;
        for (const u of group) {
          this.app.release(u);
          const ox = u.x - g.unit.x, oy = u.y - g.unit.y;
          u.path = path.slice(1).map((q) => ({ x: q.x + ox, y: q.y + oy }));
          u.stuck = 0;
        }
      }
    } else if (g.kind === 'front') {
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
        if (g.button === 2) sel.clear();
        else if (g.button === undefined) this.tap(g, e);
      }
    }
    this.app.updateSelectionInfo();
  }

  tap(g, e) {
    const sel = this.ui.selection;
    const f = g.badge || this.app.pickFront(g.world);
    if (f && (g.badge || !sel.size || f === this.ui.front)) {
      // Front antippen = ihre Division auswählen (öffnet das Frontmenü)
      if (f === this.ui.front) { sel.clear(); this.app.selectFront(null); }
      else this.app.selectDivision(f.division.id, false);
      return;
    }
    if (g.city && !sel.size) {
      g.city.prodType = g.city.prodType === 'light' ? 'heavy' : 'light';
      this.app.toast(g.city.prodType === 'heavy' ? 'Stadt baut jetzt: Panzer (schwer)' : 'Stadt baut jetzt: Infanterie (leicht)');
      return;
    }
    if (sel.size) this.app.moveSelectionTo(g.world);
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
    } else if (k === 'f') app.toggleFrontMode();
    else if (k === 'g') app.borderFront();
    else if (k === 'v') app.toggleShowFronts();
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
