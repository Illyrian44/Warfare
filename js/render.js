import { CELL, T, UNIT_TYPES, PLAYER_COLORS, PLAYER_RGB, CITY_RADIUS } from './config.js?v=53';
import { classify } from './map.js?v=53';
import { frontBadge, pointAt } from './fronts.js?v=53';
import { LEVELS, REGIMENT, DIVISION, formationOf, divisionColor, unitsOf } from './orbat.js?v=53';

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

  // Straßen als Vektorpfade vorbereiten, damit sie in jeder Zoomstufe scharf bleiben
  buildRoads() {
    const map = this.game.map;
    this.roadPath = new Path2D();
    this.bridgePath = new Path2D();
    for (const line of map.roadLines) {
      if (line.length < 2) continue;
      this.roadPath.moveTo(line[0].x, line[0].y);
      for (const p of line) this.roadPath.lineTo(p.x, p.y);
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const t = map.terrainAt((a.x + b.x) / 2, (a.y + b.y) / 2);
        if (t !== T.WATER && t !== T.DEEP) continue;
        this.bridgePath.moveTo(a.x, a.y);
        this.bridgePath.lineTo(b.x, b.y);
      }
    }
  }

  drawRoads(px) {
    const { ctx } = this;
    if (!this.roadPath) this.buildRoads();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#4a3b2c';
    ctx.lineWidth = Math.max(8, 3.5 * px);
    ctx.stroke(this.bridgePath);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(70,52,30,0.6)';
    ctx.lineWidth = Math.max(5, 2.6 * px);
    ctx.stroke(this.roadPath);
    ctx.strokeStyle = '#e6d6a8';
    ctx.lineWidth = Math.max(3, 1.4 * px);
    ctx.stroke(this.roadPath);
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

  draw(cam, ui, fronts, enemyFronts) {
    const { ctx, canvas, game } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#204e80';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, -cam.x * cam.zoom * dpr, -cam.y * cam.zoom * dpr);
    const { worldW, worldH } = game.map;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain, 0, 0, worldW, worldH);
    this.drawRoads(1 / cam.zoom);
    this.updateOverlays();
    ctx.drawImage(this.terrCanvas, 0, 0, worldW, worldH);
    ctx.drawImage(this.fogCanvas, 0, 0, worldW, worldH);

    const px = 1 / cam.zoom; // eine Bildschirm-Einheit in Weltkoordinaten
    const me = this.human;
    const visible = (u) => u.owner === me || ui.revealAll || game.isVisible(me, u.x, u.y);

    if (enemyFronts) for (const f of enemyFronts.fronts) this.drawFront(f, px, false, !ui.revealAll);
    if (fronts) for (const f of fronts.fronts) this.drawFront(f, px, f === ui.front);

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

    // Einheiten als NATO-Symbole (APP-6); herausgezoomt Divisionen statt Kompanien
    const flash = (game.time * 4) % 1 < 0.5;
    const highlightOf = (u) => (ui.selection.has(u) ? '#fff' : ui.front && u.front === ui.front ? '#f2c94c' : null);
    // Gruppierung nur nach Überlappung auf dem Bildschirm, unabhängig vom Zoom:
    // Kompanien, deren Symbole sich überdecken würden, werden zu einem Verband zusammengefasst
    this.divHits = [];
    const drawn = new Set();
    for (let p = 1; p <= 2; p++) {
      // Nur innerhalb derselben Division zusammenfassen; marschierende Kompanien bleiben einzeln
      const byDiv = new Map();
      for (const u of game.units) {
        if (u.owner !== p || !visible(u) || marching(u)) continue;
        const d = formationOf(u, DIVISION);
        if (!byDiv.has(d)) byDiv.set(d, []);
        byDiv.get(d).push(u);
      }
      const groups = [];
      for (const list of byDiv.values()) groups.push(...groupByOverlap(list, px));
      // Gruppenzugehörigkeit merken (Hysterese im nächsten Bild)
      let gid = 0;
      for (const g of groups) { gid++; for (const u of g.members) u.drawGroup = g.members.length > 1 ? p * 100000 + gid : 0; }
      for (const group of groups) {
        if (group.members.length < 2) continue;
        const sel = group.members.some((u) => ui.selection.has(u));
        const inFront = ui.front && group.members.some((u) => u.front === ui.front);
        const hw = drawFormationSymbol(ctx, group.x, group.y, group.members, p === me, px,
          sel ? '#fff' : inFront ? '#f2c94c' : null, group.members.some((u) => u.starving) && flash,
          labelFor(group.members));
        for (const u of group.members) drawn.add(u);
        if (p === me) this.divHits.push({ x: group.x, y: group.y, r: hw, members: group.members });
      }
    }
    for (const u of game.units) {
      if (drawn.has(u) || !visible(u)) continue;
      drawNatoSymbol(ctx, u, u.owner === me, px, highlightOf(u), u.starving && flash);
    }

    // Divisions-HQs hinter der Linie (keine Kampfeinheiten)
    if (game.hq) {
      // Funkverkehr: gestrichelte Verbindung zwischen sprechenden HQs, verblasst nach 3 s
      for (const m of game.hq.messages) {
        const age = game.time - m.time;
        if (age > 3 || m.from === m.to || (m.owner !== me && !ui.revealAll)) continue;
        ctx.globalAlpha = 1 - age / 3;
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.beginPath();
        ctx.moveTo(m.from.x, m.from.y);
        ctx.lineTo(m.to.x, m.to.y);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 * px;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      for (const hq of game.hq.hqs) {
        if (hq.owner !== me && !ui.revealAll && !game.isVisible(me, hq.x, hq.y)) continue;
        drawHQSymbol(ctx, hq, hq.owner === me, px);
      }
    }

    // Weg oder Front, die gerade gezeichnet wird
    if (ui.drawPath && ui.drawPath.length > 1) {
      ctx.strokeStyle = ui.frontMode ? PLAYER_COLORS[me] : 'rgba(255,255,255,0.95)';
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

  // Frontlinie wie in Hearts of Iron: dicke Linie mit Zacken Richtung Feind
  drawFront(f, px, selected, fogged = false) {
    const { ctx, game } = this;
    const color = PLAYER_COLORS[f.owner || this.human];
    // Angriffspläne des Gegners bleiben geheim: weder Pfeil noch Ziellinie zeigen
    if (fogged && (f.attack || f.plan)) return;
    if (fogged) {
      // Fremde Fronten nur in eigener Sichtweite zeigen: Linie an unsichtbaren Stellen auftrennen
      const seen = (p) => game.isVisible(this.human, p.x, p.y);
      const parts = [];
      for (const c of f.chains) {
        let cur = [];
        for (const p of c) {
          if (seen(p)) cur.push(p);
          else { if (cur.length >= 2) parts.push(cur); cur = []; }
        }
        if (cur.length >= 2) parts.push(cur);
      }
      if (!parts.length) return;
      f = { ...f, chains: parts, hideBadge: true };
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const c of f.chains) {
      if (c.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(c[0].x, c[0].y);
      for (const p of c) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.55)';
      ctx.lineWidth = (selected ? 10 : 9) * px;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 5.5 * px;
      ctx.stroke();

      // Zacken in festen Bildschirmabständen
      const step = 16 * px, tooth = 8 * px, half = 5 * px;
      ctx.fillStyle = color;
      ctx.beginPath();
      let carry = step / 2;
      for (let i = 1; i < c.length; i++) {
        const a = c[i - 1], b = c[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const seg = Math.hypot(dx, dy);
        if (!seg) continue;
        const tx = dx / seg, ty = dy / seg;
        // Normale zur Feindseite ausrichten
        let nx = -ty, ny = tx;
        const fx = (a.nx + b.nx), fy = (a.ny + b.ny);
        if (nx * fx + ny * fy < 0) { nx = -nx; ny = -ny; }
        let d = carry;
        while (d < seg) {
          const x = a.x + tx * d, y = a.y + ty * d;
          ctx.moveTo(x - tx * half, y - ty * half);
          ctx.lineTo(x + nx * tooth, y + ny * tooth);
          ctx.lineTo(x + tx * half, y + ty * half);
          d += step;
        }
        carry = d - seg;
      }
      ctx.fill();
    }

    // NATO-Führungszeichen: Phasenlinie als Ziel und Hauptangriffsachse.
    // Geplant = gestrichelt, laufend = durchgezogen (wie in APP-6)
    if (!fogged && (f.plan || f.attack)) {
      const order = f.plan || f.attack;
      const planned = !!f.plan;
      drawPhaseLine(ctx, order.line, order.name, px, color, planned);
      const active = f.units.filter((u) => !u.rotating);
      const from = active.length && f.attack
        ? { x: active.reduce((a, u) => a + u.x, 0) / active.length, y: active.reduce((a, u) => a + u.y, 0) / active.length }
        : frontBadge(f);
      const to = polylineMid(order.line);
      if (from && to && Math.hypot(to.x - from.x, to.y - from.y) > 50 * px) {
        drawAxisOfAdvance(ctx, from, to, px, color, planned);
      }
    }

    // Grenzen der Divisionsabschnitte als Querstriche, darunter Farbband der Division
    if (!fogged && f.sections && f.sections.length) {
      for (const sec of f.sections) {
        if (!sec.div) continue;
        ctx.beginPath();
        const steps = Math.max(2, Math.ceil((sec.to - sec.from) / 6));
        let lx = null, ly = null;
        for (let k = 0; k <= steps; k++) {
          const p = pointAt(f.chains, sec.from + (sec.to - sec.from) * k / steps);
          if (!p) continue;
          const off = -7 * px; // hinter der Linie
          const x = p.x + (p.nx || 0) * off, y = p.y + (p.ny || 0) * off;
          // Sprung zwischen getrennten Teillinien nicht verbinden
          if (lx === null || Math.hypot(x - lx, y - ly) > 20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          lx = x; ly = y;
        }
        ctx.strokeStyle = divisionColor(sec.div);
        ctx.lineWidth = 4 * px;
        ctx.stroke();
      }
      for (let i = 1; i < f.sections.length; i++) {
        const p = pointAt(f.chains, f.sections[i].from);
        if (!p) continue;
        ctx.beginPath();
        ctx.moveTo(p.x - (p.nx || 0) * 13 * px, p.y - (p.ny || 0) * 13 * px);
        ctx.lineTo(p.x + (p.nx || 0) * 9 * px, p.y + (p.ny || 0) * 9 * px);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3 * px;
        ctx.stroke();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.4 * px;
        ctx.stroke();
      }
    }

    // Enden eines Grenzabschnitts: Querstrich wie an Divisionsgrenzen
    if (!fogged && f.kind === 'segment') {
      const chains = f.chains.filter((c) => c.length >= 2);
      if (chains.length) {
        const first = chains[0], last = chains[chains.length - 1];
        for (const p of [first[0], last[last.length - 1]]) {
          ctx.beginPath();
          ctx.moveTo(p.x - (p.nx || 0) * 15 * px, p.y - (p.ny || 0) * 15 * px);
          ctx.lineTo(p.x + (p.nx || 0) * 11 * px, p.y + (p.ny || 0) * 11 * px);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 3.5 * px;
          ctx.stroke();
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.6 * px;
          ctx.stroke();
        }
      }
    }

    const b = f.hideBadge ? null : frontBadge(f);
    if (!b) return;
    const r = 12 * px;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = selected ? '#f2c94c' : '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${12 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(f.units.length), b.x, b.y + 0.5 * px);
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
      // Produktion als NATO-Zeichen: X = Infanterie, Oval = Panzer
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (c.prodType === 'heavy') ctx.ellipse(c.x, c.y, 4.2, 2.4, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(c.x - 3.2, c.y - 3.2); ctx.lineTo(c.x + 3.2, c.y + 3.2);
        ctx.moveTo(c.x + 3.2, c.y - 3.2); ctx.lineTo(c.x - 3.2, c.y + 3.2);
      }
      ctx.stroke();
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

const NATO_FRIEND = '#80e0ff';
const NATO_HOSTILE = '#ff8080';
const LOOSE_FRIEND = '#c9d2dc';  // Kompanien ohne Division: grau
const LOOSE_HOSTILE = '#dcc6c6';

// Füllfarbe nach Division der Kompanie(n): Farbe der häufigsten Division, ohne Division grau
function fillFor(members, friend) {
  const count = new Map();
  for (const u of members) {
    const f = formationOf(u, DIVISION);
    if (f) count.set(f, (count.get(f) || 0) + 1);
  }
  let best = null, bc = 0;
  for (const [f, c] of count) if (c > bc) { bc = c; best = f; }
  return best ? divisionColor(best) : friend ? LOOSE_FRIEND : LOOSE_HOSTILE;
}

// Rahmen nach APP-6: Rechteck für eigene, Raute für feindliche Einheiten
function symbolPath(ctx, x, y, hw, hh, friend) {
  ctx.beginPath();
  if (friend) {
    ctx.rect(x - hw, y - hh, hw * 2, hh * 2);
  } else {
    ctx.moveTo(x, y - hw);
    ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hw);
    ctx.lineTo(x - hw, y);
    ctx.closePath();
  }
}

export function drawNatoSymbol(ctx, u, friend, px, highlight, starving) {
  // Mindestgröße auf dem Bildschirm, damit die Symbole auch herausgezoomt lesbar bleiben
  const base = u.type === 'heavy' ? 1.25 : 1;
  const hw = Math.max(u.r * 1.45, 7 * px * base);
  const hh = hw * 0.68;
  const d = hw * 0.95; // halbe Diagonale der Raute
  const { x, y } = u;
  const line = Math.max(0.5, 1.1 * px);

  if (highlight) {
    symbolPath(ctx, x, y, friend ? hw : d, hh, friend);
    ctx.strokeStyle = highlight;
    ctx.lineWidth = line * 4;
    ctx.stroke();
  }

  symbolPath(ctx, x, y, friend ? hw : d, hh, friend);
  ctx.fillStyle = fillFor([u], friend);
  ctx.fill();
  ctx.strokeStyle = starving ? '#ffd23f' : '#000';
  ctx.lineWidth = starving ? line * 2 : line;
  ctx.stroke();

  // Innenleben: X = Infanterie (leicht), Oval = Panzer (schwer)
  const ix = friend ? hw : d / 2, iy = friend ? hh : d / 2;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = line;
  ctx.beginPath();
  if (u.type === 'heavy') {
    ctx.ellipse(x, y, ix * 0.62, iy * 0.5, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(x - ix, y - iy); ctx.lineTo(x + ix, y + iy);
    ctx.moveTo(x + ix, y - iy); ctx.lineTo(x - ix, y + iy);
  }
  ctx.stroke();

  const top = friend ? y - hh : y - d;
  const bottom = friend ? y + hh : y + d;

  // Größenzeichen I (Kompanie) nur bei ausreichendem Zoom
  if (hw / px > 10) drawEchelon(ctx, x, top, 'I', px);

  // Lebensbalken unter dem Symbol
  const frac = u.hp / u.maxHp;
  if (frac < 0.999) {
    const bw = hw * 2, bh = Math.max(1, 2.2 * px), by = bottom + 1.5 * px;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - hw, by, bw, bh);
    ctx.fillStyle = frac > 0.6 ? '#4cd17a' : frac > 0.3 ? '#f2c94c' : '#ff5b4b';
    ctx.fillRect(x - hw, by, bw * Math.max(0, frac), bh);
  }
}

function polylineMid(line) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (half <= seg) {
      const t = seg ? half / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    half -= seg;
  }
  return line[0];
}

// Linie mit weißem Hof zeichnen, damit sie auf jedem Gelände lesbar bleibt
function haloStroke(ctx, px, color, width, dashed) {
  ctx.setLineDash(dashed ? [7 * px, 5 * px] : []);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = width + 2.5 * px;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
}

// Phasenlinie (PL) mit Decknamen an beiden Enden
function drawPhaseLine(ctx, line, name, px, color, planned) {
  if (line.length < 2) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(line[0].x, line[0].y);
  for (const p of line) ctx.lineTo(p.x, p.y);
  haloStroke(ctx, px, color, 2.5 * px, planned);
  if (!name) return;
  const label = `PL ${name}`;
  ctx.font = `bold ${11 * px}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.fillStyle = color;
  for (const [p, q] of [[line[0], line[1]], [line[line.length - 1], line[line.length - 2]]]) {
    // Beschriftung in Verlängerung der Linie hinter dem Endpunkt
    const dx = p.x - q.x, dy = p.y - q.y;
    const l = Math.hypot(dx, dy) || 1;
    const x = p.x + dx / l * 8 * px, y = p.y + dy / l * 8 * px;
    ctx.textAlign = dx >= 0 ? 'left' : 'right';
    ctx.strokeText(label, x, y);
    ctx.fillText(label, x, y);
  }
}

// Hauptangriffsachse (Axis of Advance, Main Attack): hohler, leicht gebogener Pfeil
// aus zwei Linien mit zusätzlicher innerer Spitze
function drawAxisOfAdvance(ctx, from, to, px, color, planned) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const body = 8 * px, headW = 25 * px, headL = Math.min(34 * px, len * 0.45);
  const bend = len * 0.12;
  const hx = to.x - ux * headL, hy = to.y - uy * headL;
  const cx = (from.x + hx) / 2 + nx * bend, cy = (from.y + hy) / 2 + ny * bend;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';

  // Umriss: linke Schaftkante, Spitze, rechte Schaftkante; hinten offen
  ctx.beginPath();
  ctx.moveTo(from.x + nx * body, from.y + ny * body);
  ctx.quadraticCurveTo(cx + nx * body, cy + ny * body, hx + nx * body, hy + ny * body);
  ctx.lineTo(hx + nx * headW, hy + ny * headW);
  ctx.lineTo(to.x, to.y);
  ctx.lineTo(hx - nx * headW, hy - ny * headW);
  ctx.lineTo(hx - nx * body, hy - ny * body);
  ctx.quadraticCurveTo(cx - nx * body, cy - ny * body, from.x - nx * body, from.y - ny * body);
  haloStroke(ctx, px, color, 2.2 * px, planned);

  // Innere Spitze kennzeichnet den Hauptangriff
  const g = 8 * px;
  const tx = to.x - ux * g * 1.6, ty = to.y - uy * g * 1.6;
  const bx = hx - ux * g * 0.2, by = hy - uy * g * 0.2;
  const iw = headW - g * 1.1;
  ctx.beginPath();
  ctx.moveTo(bx + nx * iw, by + ny * iw);
  ctx.lineTo(tx, ty);
  ctx.lineTo(bx - nx * iw, by - ny * iw);
  haloStroke(ctx, px, color, 2.2 * px, planned);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
}

// Verbandssymbol (APP-6): Größenzeichen (III, XX), Innenzeichen nach Zusammensetzung
// (X = Infanterie, Oval = Panzer, beides = Panzergrenadiere), Name und Stärke
function drawFormationSymbol(ctx, x, y, members, friend, px, highlight, starving, label) {
  const { level, echelon, name, count } = label;
  // Mindestens etwas größer als eine Kompanie; beim Hineinzoomen wächst das Symbol mit
  // der Karte, und Linien, Schrift und Größenzeichen skalieren proportional mit
  const base = 10 + level * 1.2;
  const company = Math.max(...members.map((u) => companyHalfWidth(u, px)));
  const hw = Math.max(base * px, company * 1.15);
  px = hw / base;
  const hh = hw * 0.68, d = hw * 0.95;
  const line = Math.max(0.6, 1.4 * px);
  if (highlight) {
    symbolPath(ctx, x, y, friend ? hw : d, hh, friend);
    ctx.strokeStyle = highlight;
    ctx.lineWidth = line * 4;
    ctx.stroke();
  }
  symbolPath(ctx, x, y, friend ? hw : d, hh, friend);
  ctx.fillStyle = fillFor(members, friend);
  ctx.fill();
  ctx.strokeStyle = starving ? '#ffd23f' : '#000';
  ctx.lineWidth = starving ? line * 2 : line;
  ctx.stroke();

  const heavy = members.filter((u) => u.type === 'heavy').length;
  const share = heavy / members.length;
  const ix = friend ? hw : d / 2, iy = friend ? hh : d / 2;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = line;
  ctx.beginPath();
  if (share < 0.67) {
    ctx.moveTo(x - ix, y - iy); ctx.lineTo(x + ix, y + iy);
    ctx.moveTo(x + ix, y - iy); ctx.lineTo(x - ix, y + iy);
  }
  ctx.stroke();
  if (share > 0.33) {
    ctx.beginPath();
    ctx.ellipse(x, y, ix * 0.62, iy * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Größenzeichen der Stufe über dem Rahmen (III, XX)
  const top = friend ? y - hh : y - d;
  drawEchelon(ctx, x, top, echelon, px);

  // Name des Verbands rechts neben dem Symbol
  ctx.font = `bold ${10 * px}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.fillStyle = '#111';
  const text = name || String(members.length);
  const lx = x + (friend ? hw : d) + 3 * px;
  ctx.strokeText(text, lx, y);
  ctx.fillText(text, lx, y);
  if (count) {
    // Stärke anwesend/Soll unter dem Namen
    ctx.font = `${8 * px}px system-ui, sans-serif`;
    ctx.strokeText(count, lx, y + 9 * px);
    ctx.fillText(count, lx, y + 9 * px);
  }

  // Gemeinsamer Lebensbalken
  let hp = 0, max = 0;
  for (const u of members) { hp += u.hp; max += u.maxHp; }
  const frac = hp / max;
  const bottom = friend ? y + hh : y + d;
  const bw = hw * 2, bh = Math.max(1, 2.4 * px), barY = bottom + 1.8 * px;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - hw, barY, bw, bh);
  ctx.fillStyle = frac > 0.6 ? '#4cd17a' : frac > 0.3 ? '#f2c94c' : '#ff5b4b';
  ctx.fillRect(x - hw, barY, bw * frac, bh);
  return friend ? hw : d;
}

// Stufe und Name aus der Gliederung: kleinster gemeinsamer Verband der Kompanien
// (Regiment oder Division), dazu ein Zähler anwesend/Stärke des Verbands.
// Kompanien ohne Division haben keinen Verband: kein Größenzeichen, nur die Anzahl
function labelFor(members) {
  let f = members[0].regiment;
  while (f && !members.every((u) => isIn(u, f))) f = f.parent;
  if (!f) return { level: REGIMENT, echelon: '', name: `${members.length} Kp.`, count: '' };
  return { level: f.level, echelon: LEVELS[f.level].echelon, name: f.name, count: `${members.length}/${unitsOf(f).length}` };
}

function isIn(u, f) {
  for (let g = u.regiment; g; g = g.parent) if (g === f) return true;
  return false;
}

// Verlegt die Kompanie gerade (unterwegs, nicht im Gefecht, Ziel noch nicht nah)?
// Mit Hysterese: gilt als marschierend ab 40 bis zum Ziel, wieder stehend erst unter 15
function marching(u) {
  if (u.target || !u.path.length) return (u.isMarching = false);
  const end = u.path[u.path.length - 1];
  const d = Math.hypot(end.x - u.x, end.y - u.y);
  u.isMarching = u.isMarching ? d > 15 : d > 40;
  return u.isMarching;
}

// Halbe Breite eines Kompaniesymbols auf dem Bildschirm (wie in drawNatoSymbol)
function companyHalfWidth(u, px) {
  return Math.max(u.r * 1.45, 7 * px * (u.type === 'heavy' ? 1.25 : 1));
}

// Kompakte Gruppen um dichte Kerne bilden, dann Gruppen verschmelzen, deren Symbole
// sich überdecken. Lange Fronten zerfallen so in mehrere Gruppen statt einer Kette.
function groupByOverlap(units, px) {
  const n = units.length;
  if (!n) return [];
  // Hysterese: wer schon im letzten Bild zusammen war, trennt sich erst bei deutlich
  // größerem Abstand
  const touch = (a, b) => {
    const k = a.drawGroup && a.drawGroup === b.drawGroup ? 2 : 1;
    const lim = (companyHalfWidth(a, px) + companyHalfWidth(b, px) + 2 * px) * k;
    return Math.abs(a.x - b.x) < lim && Math.abs(a.y - b.y) < lim * 0.75;
  };
  // Nachbarn je Einheit
  const nb = units.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (touch(units[i], units[j])) { nb[i].push(j); nb[j].push(i); }
    }
  }
  // Kerne: Einheiten mit den meisten Nachbarn zuerst
  const order = units.map((_, i) => i).sort((a, b) => nb[b].length - nb[a].length);
  const taken = new Uint8Array(n);
  let groups = [];
  for (const i of order) {
    if (taken[i]) continue;
    taken[i] = 1;
    const members = [units[i]];
    for (const j of nb[i]) if (!taken[j]) { taken[j] = 1; members.push(units[j]); }
    groups.push(makeGroup(members));
  }
  // Gruppen zusammenführen, solange sich ihre Symbole überdecken
  // Gruppensymbol inkl. Größenzeichen darüber und Rand: etwa 17 px nach jeder Seite
  const symbolHalf = (g) => Math.max(17 * px, Math.max(...g.members.map((u) => companyHalfWidth(u, px))) * 1.5);
  for (let changed = true, guard = 0; changed && guard < 8; guard++) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j];
        const ra = a.members.length > 1 ? symbolHalf(a) : companyHalfWidth(a.members[0], px);
        const rb = b.members.length > 1 ? symbolHalf(b) : companyHalfWidth(b.members[0], px);
        const was = a.members.some((u) => u.drawGroup && b.members.some((v) => v.drawGroup === u.drawGroup)) ? 1.4 : 1;
        if (Math.abs(a.x - b.x) < (ra + rb) * was && Math.abs(a.y - b.y) < (ra + rb) * was) {
          groups[i] = makeGroup(a.members.concat(b.members));
          groups.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

function makeGroup(members) {
  return {
    members,
    x: members.reduce((a, u) => a + u.x, 0) / members.length,
    y: members.reduce((a, u) => a + u.y, 0) / members.length,
  };
}

// NATO-Größenzeichen: I als senkrechte Striche, X als kleine Kreuze, mittig über dem Rahmen
function drawEchelon(ctx, x, top, echelon, px) {
  const s = 2.9 * px, gapI = 2.8 * px, gapX = 2 * s + 1.4 * px;
  const widths = [...echelon].map((ch) => (ch === 'I' ? gapI : gapX));
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = x - total / 2;
  const cy = top - 2 * px - s;
  ctx.beginPath();
  [...echelon].forEach((ch, k) => {
    const mid = cx + widths[k] / 2;
    if (ch === 'I') {
      ctx.moveTo(mid, cy - s); ctx.lineTo(mid, cy + s);
    } else {
      ctx.moveTo(mid - s, cy - s); ctx.lineTo(mid + s, cy + s);
      ctx.moveTo(mid + s, cy - s); ctx.lineTo(mid - s, cy + s);
    }
    cx += widths[k];
  });
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(0.6, 1.3 * px);
  ctx.stroke();
}

// Hauptquartier nach APP-6: Rahmen mit Stab, der links unten nach unten zeigt,
// Größenzeichen der Division (XX) und "HQ" im Rahmen
function drawHQSymbol(ctx, hq, friend, px) {
  const hw = Math.max(8 * px, 6);
  px = hw / 8;
  const hh = hw * 0.68, d = hw * 0.95;
  const { x, y } = hq;
  const line = Math.max(0.5, 1.1 * px);
  symbolPath(ctx, x, y, friend ? hw : d, hh, friend);
  ctx.fillStyle = hq.formation ? divisionColor(hq.formation) : friend ? NATO_FRIEND : NATO_HOSTILE;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = line;
  ctx.stroke();
  // Stab
  const sx = friend ? x - hw : x - d, sy = friend ? y + hh : y;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx, sy + 9 * px);
  ctx.lineWidth = Math.max(0.6, 1.5 * px);
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.font = `bold ${6.5 * px}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('HQ', x, y + 0.5 * px);
  drawEchelon(ctx, x, friend ? y - hh : y - d, 'XX', px * 0.85);
}
