// Spielkonstanten. Viele Werte orientieren sich an bekannten War-of-Dots-Nachbauten.

export const CELL = 10; // Weltgröße einer Gitterzelle

export const T = { DEEP: 0, WATER: 1, PLAINS: 2, FOREST: 3, HILL: 4, MOUNTAIN: 5 };

export const TERRAIN_INFO = [
  { name: 'Tiefes Wasser', speed: 0, attack: 0, vision: 1, passable: false },
  { name: 'Wasser', speed: 0.6, attack: 0.5, vision: 1, passable: true },
  { name: 'Ebene', speed: 1, attack: 1, vision: 1, passable: true },
  { name: 'Wald', speed: 0.8, attack: 0.75, vision: 0.7, passable: true },
  { name: 'Hügel', speed: 0.7, attack: 1.5, vision: 1.4, passable: true },
  { name: 'Gebirge', speed: 0, attack: 0, vision: 1, passable: false },
];

// terrainAttack: zusätzlicher Faktor je Gelände (Index wie T)
export const UNIT_TYPES = {
  light: {
    name: 'Leicht', hp: 100, speed: 22, dps: 6, radius: 5, buildTime: 15,
    terrainAttack: [0, 1, 1, 1, 1, 0], strength: 1,
  },
  heavy: {
    name: 'Schwer', hp: 165, speed: 14, dps: 10, radius: 7, buildTime: 26,
    terrainAttack: [0, 0.7, 1.25, 0.7, 0.85, 0], strength: 1.7,
  },
};

export const ATTACK_RANGE = 24;        // plus beide Radien
export const ENEMY_GAP = 6;            // Mindestabstand zu Feinden (plus Radien)
export const ENGAGED_SPEED = 0.45;     // Tempo im Kampf
export const SURROUND_BONUS = 1.5;     // Schadensbonus bei Einkesselung

export const CITY_RADIUS = 12;
export const CITY_CAPTURE_RADIUS = 20;
export const CAPTURE_TIME = 4;         // Sekunden
export const UNITS_PER_CITY = 5;

export const SUPPLY_FULL = 200;        // volle Versorgung bis zu dieser Distanz
export const SUPPLY_NONE = 900;        // keine Versorgung ab dieser Distanz

export const UNIT_VISION = 85;
export const CITY_VISION = 165;
export const UNIT_BORDER = 40;
export const CITY_BORDER = 80;

export const PLAYER_COLORS = ['#9a9a9a', '#2f6fe0', '#e0412f'];
export const PLAYER_RGB = [[150, 150, 150], [47, 111, 224], [224, 65, 47]];

export const MAP_SIZES = {
  small: { w: 120, h: 72, pairs: 4, minDist: 17 },
  medium: { w: 160, h: 96, pairs: 6, minDist: 18 },
  large: { w: 208, h: 120, pairs: 8, minDist: 20 },
};

export const DIFFICULTY = {
  easy: { name: 'Leicht', interval: 2.4, seeAll: false, prodMult: 0.85, heavyRatio: 0.15, retreatAt: 0.2, attackFactor: 1.0, frontShare: 0.35, frontPush: 2.2 },
  medium: { name: 'Mittel', interval: 1.2, seeAll: false, prodMult: 1.0, heavyRatio: 0.3, retreatAt: 0.33, attackFactor: 1.3, frontShare: 0.45, frontPush: 1.7 },
  hard: { name: 'Schwer', interval: 0.6, seeAll: true, prodMult: 1.12, heavyRatio: 0.35, retreatAt: 0.4, attackFactor: 1.45, frontShare: 0.5, frontPush: 1.4 },
};
