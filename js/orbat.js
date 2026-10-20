// Gliederung (Order of Battle): Division (XX) → Regiment (III) → Kompanie (I).
// Kompanien starten ohne Division; Spieler und KI fassen sie nach Bedarf zu Divisionen
// zusammen. Die Regimenter innerhalb einer Division ordnet das Spiel selbst.

export const LEVELS = [
  { name: 'Kompanie', short: 'Kp.', echelon: 'I' },
  { name: 'Regiment', short: 'Rgt.', echelon: 'III' },
  { name: 'Division', short: 'Div.', echelon: 'XX' },
];
export const REGIMENT = 1, DIVISION = 2;

export const DIVISION_MAX = 12; // Höchststärke einer Division in Kompanien
export const REGIMENT_MAX = 3;  // Kompanien je Regiment
const AUTO_SIZE = 8;            // Auto-Gliederung: Kompanien je neuer Division
const AUTO_RADIUS = 260;        // Auto-Gliederung: so weit dürfen Kompanien einer Division auseinander stehen
const TYPES = ['light', 'heavy'];

// Farbtöne je Division: Blautöne für Blau, Rottöne für Rot (gut unterscheidbar,
// hell genug für die schwarzen NATO-Zeichen)
export const DIVISION_COLORS = [
  null,
  ['#7fe3ff', '#5aa8ff', '#b4a8ff', '#6fe0cf', '#d4f1ff', '#7f86f5', '#9cc3dc', '#3f8fd9'],
  ['#ff8080', '#ffa36b', '#ff6f9c', '#ffbfae', '#e8735f', '#ff9fd0', '#d99a8c', '#ffc27a'],
];

export function divisionColor(f) {
  const pal = DIVISION_COLORS[f.owner];
  return pal[(f.colorIndex || 0) % pal.length];
}

export class OrderOfBattle {
  static nextId = 0;

  constructor(owner) {
    this.owner = owner;
    this.divisions = [];
  }

  // Kleinste freie Nummer: aufgelöste Verbände geben Nummer (und Farbe) wieder frei
  freeNumber(list) {
    const used = new Set(list.map((f) => f.number));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  makeDivision() {
    const n = this.freeNumber(this.divisions);
    const div = {
      id: ++OrderOfBattle.nextId, level: DIVISION, owner: this.owner, parent: null, children: [],
      number: n, colorIndex: n - 1, name: `${n}. Div.`,
    };
    this.divisions.push(div);
    this.divisions.sort((a, b) => a.number - b.number);
    return div;
  }

  makeRegiment(div, type) {
    const n = this.freeNumber(this.all(REGIMENT));
    const reg = {
      id: ++OrderOfBattle.nextId, level: REGIMENT, owner: this.owner, parent: div, children: [], units: [],
      type, number: n, name: `${n}. Rgt.`,
    };
    div.children.push(reg);
    return reg;
  }

  all(level) {
    if (level === DIVISION) return this.divisions;
    if (level === REGIMENT) return this.divisions.flatMap((d) => d.children);
    return [];
  }

  // Startaufstellung: je eigene Stadt 8 Kompanien (davon 2 Panzer), noch ohne Division
  createStart(game, cities) {
    for (const city of cities) {
      for (let k = 0; k < 8; k++) game.spawnUnit(this.owner, k >= 6 ? 'heavy' : 'light', city, k);
    }
  }

  // Neue Division aus Kompanien bilden (höchstens DIVISION_MAX)
  createDivision(units) {
    const list = units.filter((u) => u.owner === this.owner && u.hp > 0).slice(0, DIVISION_MAX);
    if (!list.length) return null;
    const div = this.makeDivision();
    this.add(div, list);
    return div;
  }

  // Kompanien einer Division zuteilen; sie verlassen dabei ihre alte Division.
  // Liefert die Zahl der aufgenommenen Kompanien (begrenzt durch die Höchststärke)
  add(div, units) {
    let added = 0;
    for (const u of units) {
      if (u.owner !== this.owner || u.hp <= 0 || divisionOf(u) === div) continue;
      if (strength(div) >= DIVISION_MAX) break;
      this.remove([u]);
      this.place(div, u);
      added++;
    }
    if (added) this.compact(div);
    return added;
  }

  // In das kleinste Regiment gleichen Typs mit freiem Platz, sonst neues Regiment
  place(div, u) {
    let reg = null;
    for (const r of div.children) {
      if (r.type === u.type && r.units.length < REGIMENT_MAX && (!reg || r.units.length < reg.units.length)) reg = r;
    }
    if (!reg) reg = this.makeRegiment(div, u.type);
    reg.units.push(u);
    u.regiment = reg;
  }

  // Kompanien aus ihrer Division nehmen
  remove(units) {
    const touched = new Set();
    for (const u of units) {
      const reg = u.regiment;
      if (!reg) continue;
      reg.units = reg.units.filter((o) => o !== u);
      u.regiment = null;
      touched.add(reg.parent);
    }
    for (const div of touched) this.compact(div);
  }

  disband(div) {
    this.remove(div.children.flatMap((r) => r.units));
    if (!div.dissolved) this.dissolve(div);
  }

  // Regimenter aufräumen: Gefallene austragen, je Typ so wenige Regimenter wie nötig,
  // Größen angleichen (2+2 statt 3+1). Leere Divisionen werden aufgelöst.
  compact(div) {
    for (const r of div.children) r.units = r.units.filter((u) => u.hp > 0 && u.regiment === r);
    for (const type of TYPES) {
      const regs = div.children.filter((r) => r.type === type).sort((a, b) => b.units.length - a.units.length);
      const n = regs.reduce((s, r) => s + r.units.length, 0);
      const keep = regs.slice(0, Math.ceil(n / REGIMENT_MAX));
      for (const r of regs.slice(keep.length)) {
        for (const u of r.units) {
          const t = keep.reduce((a, b) => (b.units.length < a.units.length ? b : a));
          t.units.push(u);
          u.regiment = t;
        }
        r.units = [];
      }
      for (let guard = 0; guard < 6 && keep.length > 1; guard++) {
        keep.sort((a, b) => b.units.length - a.units.length);
        const big = keep[0], small = keep[keep.length - 1];
        if (big.units.length - small.units.length < 2) break;
        const u = big.units.pop();
        small.units.push(u);
        u.regiment = small;
      }
    }
    div.children = div.children.filter((r) => r.units.length);
    if (!div.children.length) this.dissolve(div);
  }

  dissolve(div) {
    for (const r of div.children) for (const u of r.units) if (u.regiment === r) u.regiment = null;
    div.children = [];
    div.dissolved = true;
    if (div.hq) div.hq.alive = false;
    this.divisions = this.divisions.filter((d) => d !== div);
  }

  // Gefallene austragen und leere Divisionen auflösen (regelmäßig aus dem Spiel aufgerufen)
  prune() {
    for (const div of [...this.divisions]) this.compact(div);
  }

  // Auto-Gliederung: Kompanien ohne Division nach ihrer Lage zu Divisionen zusammenfassen.
  // Kleine Reste schließen sich einer nahen Division mit freien Plätzen an.
  autoOrganize(units) {
    const pool = units.filter((u) => u.owner === this.owner && u.hp > 0 && !u.regiment)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const made = [];
    while (pool.length) {
      const seed = pool[0];
      const group = pool.map((u) => ({ u, d: Math.hypot(u.x - seed.x, u.y - seed.y) }))
        .filter((o) => o.d <= AUTO_RADIUS)
        .sort((a, b) => a.d - b.d)
        .slice(0, AUTO_SIZE)
        .map((o) => o.u);
      for (const u of group) pool.splice(pool.indexOf(u), 1);
      if (group.length < 3) {
        const near = this.nearestWithSpace(seed, AUTO_RADIUS);
        if (near) { this.add(near, group); continue; }
        if (group.length < 2) continue;
      }
      made.push(this.createDivision(group));
    }
    return made;
  }

  nearestWithSpace(p, maxDist) {
    let best = null, bd = maxDist;
    for (const div of this.divisions) {
      if (strength(div) >= DIVISION_MAX) continue;
      const c = centerOf(div);
      const d = c ? Math.hypot(c.x - p.x, c.y - p.y) : Infinity;
      if (d <= bd) { bd = d; best = div; }
    }
    return best;
  }
}

// Alle lebenden Kompanien eines Verbands
export function unitsOf(f) {
  if (f.level === REGIMENT) return f.units.filter((u) => u.hp > 0);
  const out = [];
  for (const c of f.children) out.push(...unitsOf(c));
  return out;
}

// Zahl der eingeteilten Kompanien (auch eben gefallene, bis sie ausgetragen sind)
export function strength(div) {
  return div.children.reduce((s, r) => s + r.units.length, 0);
}

export function centerOf(f) {
  const units = unitsOf(f);
  if (!units.length) return null;
  return {
    x: units.reduce((a, u) => a + u.x, 0) / units.length,
    y: units.reduce((a, u) => a + u.y, 0) / units.length,
  };
}

// Verband einer Kompanie auf der gewünschten Stufe
export function formationOf(u, level) {
  let f = u.regiment;
  while (f && f.level < level) f = f.parent;
  return f;
}

export function divisionOf(u) {
  return u.regiment ? u.regiment.parent : null;
}
