import { CELL, T, UNIT_TYPES, PLAYER_COLORS, PLAYER_RGB, CITY_RADIUS } from './config.js';
import { classify } from './map.js';

const TERRAIN_RGB = {
  [T.DEEP]: [38, 92, 150],
  [T.WATER]: [78, 150, 205],
  [T.PLAINS]: [138, 186, 92],
  [T.FOREST]: [62, 122, 62],
  [T.HILL]: [168, 154, 112],
  [T.MOUNTAIN]: [122, 114, 108],
};

const PX_PER_CELL = 5;  // Auflösung des Geländebilds
const TERR_PX = 3;      // Auflösung der Gebietsfarben

export class Renderer {
  constructor(canvas, game, human) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.human = human;
    this.terrain = this.buildTerrain();
    const { w, h } = game.map;
    this.terrCanvas = makeCanvas(w * TERR_PX, h * TERR_PX);
    this.fogCanvas = makeCanvas(w, h);
    this.terrImg = this.terrCanvas.getContext('2d').createImageData(w * TERR_PX, h * TERR_PX);
    this.ownMask = [null, new Float32Array(w * h), new Float32Array(w * h)];
    this.fogImg = this.fogCanvas.getContext('2d').createImageData(w, h);
    this.terrVersion = -1;
    this.fogVersion = -1;
  }

  buildTerrain() {
    const map = this.game.map;
    const W = map.w * PX_PER_CELL, H = map.h * PX_PER_CELL;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const step = CELL / PX_PER_CELL;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const wx = (px + 0.5) * step, wy = (py + 0.5) * step;
        const hgt = map.sample(map.height, wx, wy);
        const f = map.sample(map.forest, wx, wy);
        const t = classify(hgt, f);
        let [r, g, b] = TERRAIN_RGB[t];
        if (t === T.DEEP || t === T.WATER) {
          // Nur in Küstennähe heller, offenes Meer einheitlich
          const k = t === T.WATER ? 1 + (hgt - 0.33) * 2 : 0.85 + Math.max(0, Math.min(1, (hgt - 0.2) / 0.1)) * 0.2;
          r *= k; g *= k; b *= k;
        } else {
          // Schummerung durch Lichteinfall von links oben
          const dh = map.sample(map.height, wx - 6, wy - 6) - map.sample(map.height, wx + 6, wy + 6);
          let k = 1 + dh * 4;
          if (t === T.MOUNTAIN && hgt > 0.88) { r = 235; g = 235; b = 240; }
          if (t === T.FOREST) {
            const n = hash(px, py);
            if (n < 0.18) k *= 0.8;
          }
          k = Math.max(0.7, Math.min(1.3, k));
          r *= k; g *= k; b *= k;
        }
        const o = (py * W + px) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Weiche Küstenlinie
    ctx.globalAlpha = 0.25;
    ctx.filter = 'blur(1px)';
    ctx.drawImage(c, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    return c;
  }

  updateOverlays() {
    const g = this.game;
    const { w, h } = g.map;
    if (this.terrVersion !== g.territoryVersion) {
      this.terrVersion = g.territoryVersion;
      // Besitz je Spieler bilinear interpolieren, damit die Grenzen rund werden
      const tr = g.territory;
      for (let p = 1; p <= 2; p++) {
        const m = this.ownMask[p];
        for (let i = 0; i < w * h; i++) m[i] = tr[i] === p ? 1 : 0;
      }
      const W = w * TERR_PX, H = h * TERR_PX;
      const d = this.terrImg.data;
      d.fill(0);
      for (let py = 0; py < H; py++) {
        let cy = (py + 0.5) / TERR_PX - 0.5;
        if (cy < 0) cy = 0; else if (cy > h - 1) cy = h - 1;
        const y0 = Math.floor(cy), y1 = Math.min(h - 1, y0 + 1), fy = cy - y0;
        for (let px = 0; px < W; px++) {
          let cx = (px + 0.5) / TERR_PX - 0.5;
          if (cx < 0) cx = 0; else if (cx > w - 1) cx = w - 1;
          const x0 = Math.floor(cx), x1 = Math.min(w - 1, x0 + 1), fx = cx - x0;
          const a = y0 * w + x0, b = y0 * w + x1, c = y1 * w + x0, e = y1 * w + x1;
          if (!tr[a] && !tr[b] && !tr[c] && !tr[e]) continue;
          for (let p = 1; p <= 2; p++) {
            const m = this.ownMask[p];
            const v = (m[a] * (1 - fx) + m[b] * fx) * (1 - fy) + (m[c] * (1 - fx) + m[e] * fx) * fy;
            if (v < 0.5) continue;
            const o = (py * W + px) * 4;
            const [r, gg, bb] = PLAYER_RGB[p];
            d[o] = r; d[o + 1] = gg; d[o + 2] = bb;
            d[o + 3] = v < 0.68 ? 190 : 50;
          }
        }
      }
      this.terrCanvas.getContext('2d').putImageData(this.terrImg, 0, 0);
    }
    if (this.fogVersion !== g.visionVersion) {
      this.fogVersion = g.visionVersion;
      const d = this.fogImg.data;
      const vis = g.vision[this.human];
      const cells = g.map.cells;
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        d[o] = 10; d[o + 1] = 14; d[o + 2] = 24; d[o + 3] = vis[i] || cells[i] === T.DEEP ? 0 : 95;
      }
      this.fogCanvas.getContext('2d').putImageData(this.fogImg, 0, 0);
    }
  }

  draw(cam, ui) {
    const { ctx, canvas, game } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#204e80';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, -cam.x * cam.zoom * dpr, -cam.y * cam.zoom * dpr);
    const { worldW, worldH } = game.map;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain, 0, 0, worldW, worldH);
    this.updateOverlays();
    ctx.drawImage(this.terrCanvas, 0, 0, worldW, worldH);
    ctx.drawImage(this.fogCanvas, 0, 0, worldW, worldH);

    const px = 1 / cam.zoom; // eine Bildschirm-Einheit in Weltkoordinaten
    const me = this.human;
    const visible = (u) => u.owner === me || ui.revealAll || game.isVisible(me, u.x, u.y);

    // Geplante Wege eigener Einheiten
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([4 * px, 4 * px]);
    for (const u of game.units) {
      if (u.owner !== me || !u.path.length) continue;
      ctx.strokeStyle = ui.selection.has(u) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(u.x, u.y);
      for (const p of u.path) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Städte
    for (const c of game.cities) this.drawCity(c, px, ui);

    // Kampflinien
    ctx.lineWidth = 1.2 * px;
    for (const u of game.units) {
      if (!u.target || !visible(u)) continue;
      ctx.strokeStyle = u.owner === me ? 'rgba(200,225,255,0.55)' : 'rgba(255,200,190,0.55)';
      ctx.beginPath();
      ctx.moveTo(u.x, u.y);
      ctx.lineTo(u.x + (u.target.x - u.x) * 0.6, u.y + (u.target.y - u.y) * 0.6);
      ctx.stroke();
    }

    // Einheiten
    const flash = (game.time * 4) % 1 < 0.5;
    for (const u of game.units) {
      if (!visible(u)) continue;
      const r = u.r;
      ctx.beginPath();
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_COLORS[u.owner];
      ctx.fill();
      ctx.lineWidth = Math.max(0.8, 1.2 * px);
      ctx.strokeStyle = u.starving && flash ? '#ffd23f' : 'rgba(0,0,0,0.6)';
      ctx.stroke();
      if (u.type === 'heavy') {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
      }
      const frac = u.hp / u.maxHp;
      if (frac < 0.999) {
        // Fehlende Lebenspunkte als dunkler Kreissektor
        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.arc(u.x, u.y, r - 0.6, -Math.PI / 2 + frac * Math.PI * 2, Math.PI * 1.5);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fill();
      }
      if (ui.selection.has(u)) {
        ctx.beginPath();
        ctx.arc(u.x, u.y, r + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, 1.6 * px);
        ctx.stroke();
      }
    }

    // Weg, der gerade gezeichnet wird
    if (ui.drawPath && ui.drawPath.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2.5 * px;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ui.drawPath[0].x, ui.drawPath[0].y);
      for (const p of ui.drawPath) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ui.box) {
      const b = ui.box;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = dpr;
      const x = Math.min(b.x0, b.x1) * dpr, y = Math.min(b.y0, b.y1) * dpr;
      const w = Math.abs(b.x1 - b.x0) * dpr, h = Math.abs(b.y1 - b.y0) * dpr;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }

  drawCity(c, px, ui) {
    const { ctx, game } = this;
    const me = this.human;
    const R = CITY_RADIUS;
    const known = c.owner === me || ui.revealAll || game.isVisible(me, c.x, c.y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.fillStyle = '#f2c94c';
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * px);
    ctx.strokeStyle = 'rgba(60,40,0,0.85)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[c.owner];
    ctx.fill();

    if (c.owner && known) {
      const build = UNIT_TYPES[c.prodType].buildTime;
      ctx.beginPath();
      ctx.arc(c.x, c.y, R + 3, -Math.PI / 2, -Math.PI / 2 + Math.min(1, c.timer / build) * Math.PI * 2);
      ctx.strokeStyle = PLAYER_COLORS[c.owner];
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
    if (c.capProgress > 0 && (known || c.capOwner === me)) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, R + 6.5, -Math.PI / 2, -Math.PI / 2 + c.capProgress * Math.PI * 2);
      ctx.strokeStyle = PLAYER_COLORS[c.capOwner];
      ctx.lineWidth = 3;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (c.owner === me) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.prodType === 'heavy' ? 'S' : 'L', c.x, c.y + 0.5);
    }
  }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hash(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
