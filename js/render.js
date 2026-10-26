import { CELL, T, UNIT_TYPES, PLAYER_COLORS, PLAYER_RGB, CITY_RADIUS, SUPPLY, BUILDINGS } from './config.js?v=108';
import { classify } from './map.js?v=108';
import { frontBadge } from './fronts.js?v=108';
import { LEVELS, REGIMENT, DIVISION, ARMY, formationOf, divisionColor, armyColor, unitsOf, divisionOf } from './orbat.js?v=108';

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

// Einzelheiten einer Divisionsfront (Abschnitt, Zahl der Kompanien) nur bei Bedarf: Division
// ausgewählt, Front angetippt oder Angriff in Planung. Die Fronten der Armeen sind immer zu
// sehen (siehe drawHolds)
export function isFrontShown(f, ui) {
  if (f === ui.front) return true;
  if (ui.frontMode && ui.frontMode.plan && ui.frontMode.plan.includes(f)) return true;
  for (const u of ui.selection) if (divisionOf(u) === f.division) return true;
  return false;
}

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
    this.ownMask = [null, ...game.players.map(() => new Float32Array(w * h))];
    this.fogImg = this.fogCanvas.getContext('2d').createImageData(w, h);
    this.terrVersion = -1;
    this.fogVersion = -1;
    this.supplyCanvas = makeCanvas(w, h);
    this.supplyImg = this.supplyCanvas.getContext('2d').createImageData(w, h);
    this.supplyStamp = null;
  }

  // Kartenebene „Nachschub“: eigenes Gebiet nach Lieferquote eingefärbt (grün = voll,
  // gelb = knapp, rot = nichts kommt an, dunkelrot = abgeschnitten)
  updateSupplyOverlay() {
    const g = this.game, sup = g.supply;
    const net = sup.nets[this.human];
    if (this.supplyStamp === net.time) return;
    this.supplyStamp = net.time;
    const d = this.supplyImg.data;
    const tr = g.territory;
    const n = g.map.w * g.map.h;
    const mix = (a, b, t) => a + (b - a) * t;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (tr[i] !== this.human) { d[o + 3] = 0; continue; }
      const h = net.hours[i];
      let r, gg, b;
      if (h === Infinity) { r = 120; gg = 20; b = 20; } else {
        const e = sup.efficiency(h);
        if (e >= 0.5) { const t = (e - 0.5) * 2; r = mix(242, 76, t); gg = mix(201, 209, t); b = mix(76, 122, t); }
        else { const t = e * 2; r = mix(255, 242, t); gg = mix(91, 201, t); b = mix(75, 76, t); }
      }
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 125;
    }
    this.supplyCanvas.getContext('2d').putImageData(this.supplyImg, 0, 0);
  }

  // Nachschubebene: Färbung, Auslastung der Depots und Nachschubweg der Auswahl
  drawSupply(ui, px) {
    const { ctx, game } = this;
    const { worldW, worldH } = game.map;
    this.updateSupplyOverlay();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.supplyCanvas, 0, 0, worldW, worldH);
    // Nachschubweg vom Depot zur Mitte der Auswahl
    const sel = [...ui.selection].filter((u) => u.owner === this.human && u.hp > 0);
    if (sel.length) {
      const cx = sel.reduce((a, u) => a + u.x, 0) / sel.length, cy = sel.reduce((a, u) => a + u.y, 0) / sel.length;
      const path = game.supply.route(this.human, cx, cy);
      if (path.length > 1) {
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (const p of path) ctx.lineTo(p.x, p.y);
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(90,60,20,0.9)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Auslastung je Depot
    ctx.font = `bold ${11 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const c of game.cities) {
      if (c.owner !== this.human) continue;
      const load = c.supplyLoad || 0;
      const text = `Nachschub ${Math.round(load * 100)} %`;
      const y = c.y + CITY_RADIUS + 9;
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(text, c.x, y);
      ctx.fillStyle = load > 1 ? '#c0392b' : load > 0.8 ? '#a07800' : '#1d6b3a';
      ctx.fillText(text, c.x, y);
    }
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
        // Ausland: blass und grau, nicht spielbar
        if (map.off[map.cellIndex(wx, wy)] && t !== T.DEEP) {
          const grey = (r + g + b) / 3;
          r = grey * 0.35 + 205 * 0.65; g = grey * 0.35 + 205 * 0.65; b = grey * 0.35 + 200 * 0.65;
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

  // Straßen und Flüsse als Vektorpfade vorbereiten, damit sie in jeder Zoomstufe scharf bleiben
  buildRoads() {
    const map = this.game.map;
    this.riverPath = new Path2D();
    for (const line of map.riverLines) {
      if (line.length < 2) continue;
      this.riverPath.moveTo(line[0].x, line[0].y);
      for (const p of line) this.riverPath.lineTo(p.x, p.y);
    }
    this.roadPath = new Path2D();
    this.bridgePath = new Path2D();
    for (const line of map.roadLines) {
      if (line.length < 2) continue;
      this.roadPath.moveTo(line[0].x, line[0].y);
      for (const p of line) this.roadPath.lineTo(p.x, p.y);
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const t = map.cellTerrainAt((a.x + b.x) / 2, (a.y + b.y) / 2);
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
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgb(78,150,205)';
    ctx.lineWidth = Math.max(4, 2 * px);
    ctx.stroke(this.riverPath);
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
      for (const p of g.players) {
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
          for (const p of g.players) {
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
        d[o] = 10; d[o + 1] = 14; d[o + 2] = 24; d[o + 3] = vis[i] || cells[i] === T.DEEP || g.map.off[i] ? 0 : 95;
      }
      this.fogCanvas.getContext('2d').putImageData(this.fogImg, 0, 0);
    }
  }

  draw(cam, ui, fronts) {
    const { ctx, canvas, game } = this;
    ME = this.human;
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
    if (ui.showSupply) this.drawSupply(ui, 1 / cam.zoom);

    const px = 1 / cam.zoom; // eine Bildschirm-Einheit in Weltkoordinaten
    const me = this.human;
    const visible = (u) => u.owner === me || ui.revealAll || game.isVisible(me, u.x, u.y);

    // Feindliche Fronten bleiben verborgen. Eigene: die Grenze selbst in der Farbe der
    // zuständigen Armee (rot gestrichelt: keine Front), Einzelheiten der ausgewählten Divisionen
    if (fronts && ui.showFronts) this.drawFrontLines(fronts, px);
    if (fronts) {
      for (const f of fronts.fronts) {
        if (isFrontShown(f, ui)) this.drawFront(fronts, f, px, f === ui.front);
        else if (ui.showFronts && (f.plan || f.attack)) this.drawOrders(f, px);
      }
    }

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
    this.drawConvoys(px, ui);

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
    const hover = new Set(ui.hover || []);
    const HOVER = 'rgba(255,255,255,0.5)';
    const highlightOf = (u) => (ui.selection.has(u) ? '#fff' : hover.has(u) ? HOVER : ui.front && u.front === ui.front ? '#f2c94c' : null);
    // Gruppierung nur nach Überlappung auf dem Bildschirm, unabhängig vom Zoom:
    // Kompanien, deren Symbole sich überdecken würden, werden zu einem Verband zusammengefasst.
    // Trefferflächen (this.hits) entstehen genau dort, wo die eigenen Symbole gezeichnet sind:
    // angeklickt wird, was man sieht
    this.hits = [];
    const drawn = new Set();
    for (const p of game.players) {
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
        const hov = group.members.some((u) => hover.has(u));
        const inFront = ui.front && group.members.some((u) => u.front === ui.front);
        const hw = drawFormationSymbol(ctx, group.x, group.y, group.members, !game.hostile(me, p), px,
          sel ? '#fff' : hov ? HOVER : inFront ? '#f2c94c' : null, p === me && group.members.some((u) => u.supply < 0.2) && flash,
          labelFor(group.members));
        for (const u of group.members) drawn.add(u);
        if (p === me) this.hits.push({ x: group.x, y: group.y, hw, hh: hw * 0.68, members: group.members, single: false });
      }
    }
    for (const u of game.units) {
      if (drawn.has(u) || !visible(u)) continue;
      drawNatoSymbol(ctx, u, !game.hostile(me, u.owner), px, highlightOf(u), u.owner === me && u.supply < 0.2 && flash);
      if (u.owner === me) {
        const hw = companyHalfWidth(u, px);
        this.hits.push({ x: u.x, y: u.y, hw, hh: hw * 0.68, members: [u], single: true });
      }
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
        drawHQSymbol(ctx, hq, !game.hostile(me, hq.owner), px);
      }
    }

    // Abzeichen der Armeefronten und Trenner über den Truppen
    this.holdHits = [];
    if (fronts && ui.showFronts) {
      this.drawHoldBadges(fronts, px, ui);
      this.drawBoundaries(fronts, px);
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

  // Fronten wie in Hearts of Iron: die Grenze selbst als Linie in der Farbe der zuständigen
  // Armee (bzw. Division mit eigener Front), darunter ein breites Band, Zacken Richtung Feind.
  // Grenzstücke ohne Front rot gestrichelt. Die Linien folgen den Feldkanten und sind nur
  // geglättet: sie können nicht reißen
  drawFrontLines(fronts, px) {
    const { ctx } = this;
    const lines = fronts.edges();
    const path = (pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts) ctx.lineTo(p.x, p.y);
    };
    ctx.lineJoin = 'round';
    // ohne Front
    ctx.setLineDash([7 * px, 5 * px]);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(255,80,60,0.95)';
    ctx.lineWidth = 4 * px;
    for (const l of lines) if (!l.key) { path(l.pts); ctx.stroke(); }
    ctx.setLineDash([]);
    // Bänder, dann Linien mit Zacken
    for (const l of lines) {
      const hd = l.key && fronts.holdIds.get(l.key);
      if (!hd) continue;
      path(l.pts);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = holdColor(hd);
      ctx.lineWidth = 15 * px;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const l of lines) {
      const hd = l.key && fronts.holdIds.get(l.key);
      if (!hd) continue;
      const color = holdColor(hd);
      path(l.pts);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 5.5 * px;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * px;
      ctx.stroke();
      // Zacken in Mindestabständen auf dem Bildschirm
      ctx.fillStyle = color;
      ctx.beginPath();
      let last = null;
      for (const t of l.teeth) {
        if (last && Math.hypot(t.x - last.x, t.y - last.y) < 15 * px) continue;
        last = t;
        const tx = -t.ny, ty = t.nx; // entlang der Linie
        ctx.moveTo(t.x - tx * 4.5 * px, t.y - ty * 4.5 * px);
        ctx.lineTo(t.x + t.nx * 7 * px, t.y + t.ny * 7 * px);
        ctx.lineTo(t.x + tx * 4.5 * px, t.y + ty * 4.5 * px);
      }
      ctx.fill();
    }
    for (const hd of fronts.holds) {
      if (hd.fallback && !hd.falling) drawFallback(ctx, hd.fallback.line, px, holdColor(hd), hd.formation.name);
    }
  }

  // Abzeichen je Armeefront nahe der Mitte ihres Abschnitts: Name, Divisionen und Frontlänge,
  // Ampel für die Besetzung (Kompanien je Grenzfeld). Antippen wählt den Verband.
  drawHoldBadges(fronts, px, ui) {
    const { ctx } = this;
    const selDivs = new Set([...ui.selection].map(divisionOf).filter(Boolean));
    for (const hd of fronts.holds) {
      const p = hd.falling && hd.fallback ? polylineMid(hd.fallback.line) : fronts.holdBadge(hd);
      if (!p) continue;
      const st = fronts.holdStatus(hd);
      const color = holdColor(hd);
      const name = hd.formation.name;
      const sub = hd.falling ? `${st.divs} Div · Auffanglinie` : `${st.divs} Div · ${st.km} km`;
      ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
      const tw = Math.max(ctx.measureText(name).width, ctx.measureText(sub).width);
      const hw = (tw + 34 * px) / 2, hh = 15 * px;
      const off = 40 * px; // hinter die Linie, ins eigene Gebiet
      const x = p.x - (p.nx || 0) * off, y = p.y - (p.ny || 0) * off;
      const chosen = fronts.members(hd).some((d) => selDivs.has(d));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(20,30,44,0.92)';
      ctx.fillRect(x - hw, y - hh, hw * 2, hh * 2);
      ctx.fillStyle = color;
      ctx.fillRect(x - hw, y - hh, 5 * px, hh * 2);
      ctx.strokeStyle = chosen ? '#fff' : color;
      ctx.lineWidth = (chosen ? 2.5 : 1.5) * px;
      ctx.strokeRect(x - hw, y - hh, hw * 2, hh * 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(name, x - hw + 10 * px, y - 6 * px);
      ctx.font = `${10 * px}px system-ui, sans-serif`;
      ctx.fillStyle = '#b8c6d6';
      ctx.fillText(sub, x - hw + 10 * px, y + 6.5 * px);
      ctx.beginPath();
      ctx.arc(x + hw - 8 * px, y - 7 * px, 3.5 * px, 0, Math.PI * 2);
      ctx.fillStyle = STATUS_COLORS[st.level];
      ctx.fill();
      this.holdHits.push({ hd, x, y, hw, hh });
    }
  }

  // Trenner zwischen zwei Armeefronten: ziehen verschiebt die Naht
  drawBoundaries(fronts, px) {
    const { ctx } = this;
    for (const b of fronts.boundaries()) {
      const r = 7 * px;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#14202e';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 2.2 * px, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
  }

  // Einzelheiten einer Divisionsfront: ihr Abschnitt der Grenze in der Farbe der Division,
  // Zahl der Kompanien, dazu Angriffsziel und -achse
  drawFront(fronts, f, px, selected) {
    const { ctx } = this;
    const color = divisionColor(f.division);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const lines = f.hold.falling ? [] : fronts.edgesOf(f);
    for (const l of lines) {
      ctx.beginPath();
      ctx.moveTo(l.pts[0].x, l.pts[0].y);
      for (const p of l.pts) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.6)';
      ctx.lineWidth = (selected ? 8 : 7) * px;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * px;
      ctx.stroke();
    }
    this.drawOrders(f, px);

    const b = frontBadge(f);
    if (!b) return;
    const r = 12 * px;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = selected ? '#f2c94c' : '#fff';
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = `bold ${12 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(f.units.length), b.x, b.y + 0.5 * px);
  }

  // NATO-Führungszeichen: Phasenlinie als Ziel und Hauptangriffsachse in der Farbe der
  // Armee. Geplant = gestrichelt, laufend = durchgezogen (wie in APP-6)
  drawOrders(f, px) {
    if (!f.plan && !f.attack) return;
    const { ctx } = this;
    const color = holdColor(f.hold);
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

  // Handel: Kolonnen (kleiner Lastwagen) und Schiffe in der Farbe ihrer Seite; fremde nur in Sicht
  drawConvoys(px, ui) {
    const { ctx, game } = this;
    const me = this.human;
    const s = Math.max(4, 7 * px);
    ctx.lineWidth = Math.max(0.8, 1 * px);
    for (const k of game.trade.convoys) {
      if (k.owner !== me && !ui.revealAll && !game.isVisible(me, k.x, k.y)) continue;
      ctx.fillStyle = PLAYER_COLORS[k.owner];
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      if (k.kind === 'sea') {
        // Rumpf
        ctx.moveTo(k.x - s * 1.4, k.y - s * 0.3);
        ctx.lineTo(k.x + s * 1.4, k.y - s * 0.3);
        ctx.lineTo(k.x + s * 0.9, k.y + s * 0.6);
        ctx.lineTo(k.x - s * 0.9, k.y + s * 0.6);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillRect(k.x - s * 0.3, k.y - s * 0.9, s * 0.6, s * 0.6); // Aufbau
      } else {
        ctx.rect(k.x - s, k.y - s * 0.55, s * 2, s * 1.1);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#222';
        ctx.beginPath();
        ctx.arc(k.x - s * 0.55, k.y + s * 0.6, s * 0.3, 0, Math.PI * 2);
        ctx.arc(k.x + s * 0.55, k.y + s * 0.6, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawCity(c, px, ui) {
    const { ctx, game } = this;
    const me = this.human;
    const R = CITY_RADIUS * (0.8 + 0.12 * game.citySize(c)); // Großstädte etwas größer
    if (ui.pickHover === c) {
      // Wahl der Startstadt: Stadt unter dem Zeiger hervorheben
      ctx.beginPath();
      ctx.arc(c.x, c.y, R * 2.4, 0, Math.PI * 2);
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = PLAYER_COLORS[me];
      ctx.stroke();
    }
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

    // Ausbildung (nur bei eigenen Städten sichtbar): Ring = Fortschritt des ersten Auftrags
    const training = c.owner === me ? game.production.active(c.id) : [];
    if (training.length) {
      const o = training[0];
      ctx.beginPath();
      ctx.arc(c.x, c.y, R + 3, -Math.PI / 2, -Math.PI / 2 + Math.min(1, o.timer / UNIT_TYPES[o.type].buildTime) * Math.PI * 2);
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
    if (training.length) {
      // Was gerade ausgebildet wird, als NATO-Zeichen: X = Infanterie, Oval = Panzer
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (training[0].type === 'heavy') ctx.ellipse(c.x, c.y, 4.2, 2.4, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(c.x - 3.2, c.y - 3.2); ctx.lineTo(c.x + 3.2, c.y + 3.2);
        ctx.moveTo(c.x + 3.2, c.y - 3.2); ctx.lineTo(c.x - 3.2, c.y + 3.2);
      }
      ctx.stroke();
    }
    // Name der Stadt (stark herausgezoomt ausgeblendet)
    if (c.name && px < 2.6) {
      ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(c.name, c.x, c.y + R + 4 * px);
      ctx.fillStyle = '#fff';
      ctx.fillText(c.name, c.x, c.y + R + 4 * px);
      // Gebäude der eigenen Städte (nah herangezoomt): Symbol und Stufe, 🔨 = im Bau
      if (c.owner === me && px < 1.3) {
        const parts = Object.entries(c.buildings).filter(([, l]) => l).map(([k, l]) => BUILDINGS[k].icon + l);
        if (c.construction) parts.push('🔨');
        if (parts.length) {
          ctx.font = `${9 * px}px system-ui, sans-serif`;
          ctx.strokeText(parts.join(' '), c.x, c.y + R + 17 * px);
          ctx.fillText(parts.join(' '), c.x, c.y + R + 17 * px);
        }
      }
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

// Eigene Seite des Bildes (Symbole: eckig für eigene und verbündete, Raute für feindliche)
let ME = 1;
const NATO_FRIEND = '#80e0ff';
const NATO_HOSTILE = '#ff8080';
const LOOSE_FRIEND = '#c9d2dc';  // Kompanien ohne Division: grau

// Feindliche Kompanien ohne Division: heller Ton der Farbe ihrer Seite
function looseHostile(owner) {
  const [r, g, b] = PLAYER_RGB[owner] || [220, 198, 198];
  const mix = (v) => Math.round(v + (255 - v) * 0.62);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// Füllfarbe nach Division der Kompanie(n): Farbe der häufigsten Division, ohne Division grau
function fillFor(members, friend) {
  const count = new Map();
  for (const u of members) {
    const f = formationOf(u, DIVISION);
    if (f) count.set(f, (count.get(f) || 0) + 1);
  }
  let best = null, bc = 0;
  for (const [f, c] of count) if (c > bc) { bc = c; best = f; }
  return best ? divisionColor(best) : members[0].owner === ME ? LOOSE_FRIEND : looseHostile(members[0].owner);
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

export function drawNatoSymbol(ctx, u, friend, px, highlight, lowSupply) {
  if (u.broken) ctx.globalAlpha = 0.5; // zerschlagen: blass, bis wieder einsatzbereit
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
  ctx.strokeStyle = lowSupply ? '#ffd23f' : '#000';
  ctx.lineWidth = lowSupply ? line * 2 : line;
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

  // Lebensbalken und darunter Organisation (blau)
  drawBars(ctx, x - hw, bottom + 1.5 * px, hw * 2, Math.max(1, 2.2 * px), u.hp / u.maxHp, u.org / u.maxOrg, px);
  ctx.globalAlpha = 1;
  if (u.owner === ME && u.supply < SUPPLY.warnBelow) drawSupplyWarning(ctx, x + (friend ? hw : d), top, px);
}

// Balken für Lebenspunkte (grün/gelb/rot) und Organisation (blau); nur, was nicht voll ist
function drawBars(ctx, x, y, w, h, hp, org, px) {
  const bars = [];
  if (hp < 0.999) bars.push([Math.max(0, hp), hp > 0.6 ? '#4cd17a' : hp > 0.3 ? '#f2c94c' : '#ff5b4b']);
  if (org < 0.999) bars.push([Math.max(0, org), '#5ab4ff']);
  for (const [frac, color] of bars) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * frac, h);
    y += h + 0.6 * px;
  }
}

// Warnzeichen „knapper Nachschub“: gelbes Dreieck mit Ausrufezeichen an der Ecke
function drawSupplyWarning(ctx, x, y, px) {
  const s = 5 * px;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y + s * 0.75);
  ctx.lineTo(x - s, y + s * 0.75);
  ctx.closePath();
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.lineWidth = Math.max(0.5, 0.9 * px);
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.fillRect(x - 0.45 * px, y - s * 0.45, 0.9 * px, s * 0.7);
  ctx.fillRect(x - 0.45 * px, y + s * 0.38, 0.9 * px, 0.9 * px);
}

// Ampel der Besetzung einer Armeefront (siehe FrontManager.holdStatus)
const STATUS_COLORS = { good: '#4cd17a', thin: '#f2c94c', weak: '#ff6b5b', none: '#9a9a9a' };

export function holdColor(hd) {
  return hd.formation.level === ARMY ? armyColor(hd.formation) : divisionColor(hd.formation);
}

// Auffanglinie (geplant): gestrichelt in der Farbe des Verbands, Winkel zeigen zurück auf die
// Linie, Beschriftung „AL“ mit dem Namen
function drawFallback(ctx, line, px, color, name) {
  if (line.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([10 * px, 6 * px]);
  ctx.beginPath();
  ctx.moveTo(line[0].x, line[0].y);
  for (const p of line) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 5 * px;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5 * px;
  ctx.stroke();
  ctx.setLineDash([]);
  const m = polylineMid(line);
  if (m) {
    ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    const label = `⤶ AL ${name}`;
    ctx.strokeText(label, m.x, m.y - 5 * px);
    ctx.fillStyle = color;
    ctx.fillText(label, m.x, m.y - 5 * px);
  }
  ctx.restore();
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
function drawFormationSymbol(ctx, x, y, members, friend, px, highlight, lowSupply, label) {
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
  ctx.strokeStyle = lowSupply ? '#ffd23f' : '#000';
  ctx.lineWidth = lowSupply ? line * 2 : line;
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

  // Gemeinsamer Lebens- und Organisationsbalken
  let hp = 0, max = 0, org = 0, maxOrg = 0;
  for (const u of members) { hp += u.hp; max += u.maxHp; org += u.org; maxOrg += u.maxOrg; }
  const bottom = friend ? y + hh : y + d;
  drawBars(ctx, x - hw, bottom + 1.8 * px, hw * 2, Math.max(1, 2.4 * px), hp / max, org / maxOrg, px);
  if (members[0].owner === ME && members.reduce((s, u) => s + u.supply, 0) / members.length < SUPPLY.warnBelow) {
    drawSupplyWarning(ctx, x + hw, friend ? y - hh : y - d, px);
  }
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
