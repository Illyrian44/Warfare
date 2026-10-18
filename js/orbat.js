// Gliederung (Order of Battle): Kompanie → Regiment → Brigade → Division → Korps → Armee.
// Jede Kompanie gehört fest zu einem Regiment, jedes Regiment zu einer Brigade usw.

export const LEVELS = [
  { name: 'Kompanie', short: 'Kp.', echelon: 'I' },
  { name: 'Regiment', short: 'Rgt.', echelon: 'III' },
  { name: 'Brigade', short: 'Brig.', echelon: 'X' },
  { name: 'Division', short: 'Div.', echelon: 'XX' },
  { name: 'Korps', short: 'Korps', echelon: 'XXX' },
  { name: 'Armee', short: 'Armee', echelon: 'XXXX' },
];
export const REGIMENT = 1, BRIGADE = 2, DIVISION = 3, CORPS = 4, ARMY = 5;

// Sollstärke: Kinder je Verband (Regiment: Kompanien)
const SIZE = { [REGIMENT]: 2, [BRIGADE]: 2, [DIVISION]: 2, [CORPS]: 2 };

// Sollstärke in Kompanien je Stufe (Regiment 2, Brigade 4, Division 8, Korps 16, Armee 32)
export const NOMINAL = {};
NOMINAL[REGIMENT] = SIZE[REGIMENT];
for (let l = BRIGADE; l <= ARMY; l++) NOMINAL[l] = NOMINAL[l - 1] * (SIZE[l] || 2);

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export class OrderOfBattle {
  static nextId = 0;

  constructor(owner) {
    this.owner = owner;
    this.counters = [0, 0, 0, 0, 0, 0];
    this.army = this.make(ARMY, null);
  }

  make(level, parent) {
    const n = ++this.counters[level];
    const f = {
      id: ++OrderOfBattle.nextId, level, owner: this.owner, parent, children: [], units: [],
      name: level === CORPS ? `${ROMAN[n] || n}. Korps` : `${n}. ${LEVELS[level].short}`,
    };
    if (parent) parent.children.push(f);
    return f;
  }

  // Startaufstellung: je Stadt eine Division (2 Brigaden à 2 Regimenter à 2 Kompanien),
  // je zwei Divisionen ein Korps, alles unter einer Armee
  createStart(game, cities) {
    let corps = null;
    cities.forEach((city, k) => {
      if (k % SIZE[CORPS] === 0) corps = this.make(CORPS, this.army);
      const div = this.make(DIVISION, corps);
      let slot = 0;
      for (let b = 0; b < SIZE[DIVISION]; b++) {
        const brig = this.make(BRIGADE, div);
        for (let r = 0; r < SIZE[BRIGADE]; r++) {
          const reg = this.make(REGIMENT, brig);
          // Ein Panzerregiment je Division, sonst Infanterie
          const type = b === SIZE[DIVISION] - 1 && r === SIZE[BRIGADE] - 1 ? 'heavy' : 'light';
          for (let c = 0; c < SIZE[REGIMENT]; c++) {
            const u = game.spawnUnit(this.owner, type, city, slot++);
            this.attach(u, reg);
          }
        }
      }
    });
  }

  attach(u, reg) {
    u.regiment = reg;
    reg.units.push(u);
  }

  // Neue Kompanie dem schwächsten Regiment zuteilen; sind alle voll, neue Verbände bilden
  assign(u, game) {
    this.prune(game);
    const regs = this.all(REGIMENT).sort((a, b) => a.units.length - b.units.length);
    if (regs.length && regs[0].units.length < SIZE[REGIMENT]) return this.attach(u, regs[0]);
    this.attach(u, this.make(REGIMENT, this.slotFor(BRIGADE)));
  }

  // Verband der Stufe `level` mit freiem Platz finden oder anlegen
  slotFor(level) {
    if (level === ARMY) return this.army;
    const open = this.all(level).filter((f) => f.children.length < SIZE[level])
      .sort((a, b) => a.children.length - b.children.length);
    if (open.length) return open[0];
    return this.make(level, this.slotFor(level + 1));
  }

  all(level) {
    const out = [];
    const walk = (f) => {
      if (f.level === level) { out.push(f); return; }
      for (const c of f.children) walk(c);
    };
    walk(this.army);
    return out;
  }

  // Gefallene Kompanien austragen
  prune(game) {
    for (const reg of this.all(REGIMENT)) reg.units = reg.units.filter((u) => u.hp > 0 && game.units.includes(u));
  }
}

// Alle lebenden Kompanien eines Verbands
export function unitsOf(f) {
  if (f.level === REGIMENT) return f.units.filter((u) => u.hp > 0);
  const out = [];
  for (const c of f.children) out.push(...unitsOf(c));
  return out;
}

// Verband einer Kompanie auf der gewünschten Stufe
export function formationOf(u, level) {
  let f = u.regiment;
  while (f && f.level < level) f = f.parent;
  return f;
}
