// Spielkonstanten. Viele Werte orientieren sich an bekannten War-of-Dots-Nachbauten.

export const CELL = 10; // Weltgröße einer Gitterzelle

// Maßstab: 1 Zelle = 1 km (1 Welteinheit = 100 m); Zeitraffer bei Tempo 1×:
// 1 Spielsekunde = 6 Minuten. Die mittlere Insel misst damit 160 × 96 km.
export const KM = CELL;              // Welteinheiten je Kilometer
export const HOURS_PER_SECOND = 0.1; // Spielstunden je Spielsekunde
// km/h -> Welteinheiten je Spielsekunde
export const kmh = (v) => v * KM * HOURS_PER_SECOND;

export const T = { DEEP: 0, WATER: 1, PLAINS: 2, FOREST: 3, HILL: 4, MOUNTAIN: 5 };

export const TERRAIN_INFO = [
  { name: 'Tiefes Wasser', speed: 0, attack: 0, vision: 1, passable: false },
  { name: 'Wasser', speed: 0.6, attack: 0.5, vision: 1, passable: true },
  { name: 'Ebene', speed: 1, attack: 1, vision: 1, passable: true },
  { name: 'Wald', speed: 0.8, attack: 0.75, vision: 0.7, passable: true },
  { name: 'Hügel', speed: 0.7, attack: 1.5, vision: 1.4, passable: true },
  { name: 'Gebirge', speed: 0, attack: 0, vision: 1, passable: false },
];

// speed: Marschtempo auf offener Ebene (Straße ×1,6, Gelände bremst, siehe TERRAIN_INFO)
// terrainAttack: zusätzlicher Faktor je Gelände (Index wie T)
export const UNIT_TYPES = {
  light: {
    name: 'Leicht', hp: 100, speed: kmh(10), dps: 6, radius: 5, buildTime: 15,
    terrainAttack: [0, 1, 1, 1, 1, 0], strength: 1, cost: { money: 30, manpower: 150 },
  },
  heavy: {
    name: 'Schwer', hp: 165, speed: kmh(18), dps: 10, radius: 7, buildTime: 26,
    terrainAttack: [0, 0.7, 1.25, 0.7, 0.85, 0], strength: 1.7, cost: { money: 100, manpower: 90 },
  },
};

// Organisation wie in HOI4: Kampfbereitschaft einer Kompanie. Schaden trifft sie stärker
// als die Lebenspunkte; bei 0 ist die Kompanie zerschlagen, zieht sich zurück und kämpft
// nicht, bis sie wieder returnAt erreicht hat. Erholung nur außerhalb des Gefechts.
export const ORG = {
  max: { light: 60, heavy: 35 },  // Infanterie hält länger durch, Panzer brechen schneller ein
  damage: 2,                      // Organisationsverlust relativ zum Lebenspunkteverlust
  hpShare: 0.8,                   // Anteil des Schadens, der Lebenspunkte kostet (0,6 machte Partien zu zäh)
  recoverPerHour: 0.15,           // Erholung je Stunde (Anteil des Maximums) bei vollem Nachschub
  march: 0.5,                     // beim Marschieren nur halb so schnell
  starvePerHour: 0.05,            // ohne Nachschub (Vorrat unter 15 %) sinkt sie so schnell
  returnAt: 0.5,                  // zerschlagene Kompanien sind ab hier wieder einsatzbereit
  retreatKm: 6,                   // so weit ziehen sie sich vom Feind zurück
};

export const ATTACK_RANGE = 24;        // plus beide Radien
export const ENEMY_GAP = 6;            // Mindestabstand zu Feinden (plus Radien)
export const ENGAGED_SPEED = 0.45;     // Tempo im Kampf
export const SURROUND_BONUS = 1.5;     // Schadensbonus bei Einkesselung

export const CITY_RADIUS = 12;
export const CITY_CAPTURE_RADIUS = 20;
export const CAPTURE_TIME = 4;         // Sekunden
export const UNITS_PER_CITY = 10;

// Wirtschaft: Geld und Manpower je Seite. Städte liefern je nach Größe (aus der echten
// Einwohnerzahl), die Hauptstadt (Startstadt) zählt immer als Großstadt, das Land bringt
// etwas Geld dazu. Kompanien kosten beides (cost in UNIT_TYPES).
export const ECONOMY = {
  sizeOf: (pop) => (pop >= 1500000 ? 3 : pop >= 400000 ? 2 : 1), // 1 Kleinstadt … 3 Großstadt
  cityMoney: 0.6,     // Geld je Sekunde und Stadtgröße
  landMoney: 0.05,    // Geld je Sekunde und Prozent des Landes
  cityManpower: 4,    // Manpower je Sekunde und Stadtgröße
  manpowerCap: 45,    // Manpower-Vorrat höchstens so viele Sekunden Zuwachs (mindestens 1000)
  startMoney: 150,
  startManpower: 600,
};

// Versorgung: jede eigene Stadt ist ein Depot und beliefert die Kompanien, die sie über
// eigenes Gebiet am schnellsten erreicht. LKW fahren auf Straßen schnell; Feindgebiet
// sperrt, Feindnähe bremst. Mengen in Grundlasten (1 = voller Vorrat einer Kompanie).
export const SUPPLY = {
  roadKmh: 50,                       // LKW auf Straßen und Brücken
  truckKmh: [0, 4, 20, 12, 10, 0],   // LKW abseits von Straßen, je Gelände (Index wie T)
  fullHours: 3,                      // bis zu dieser Fahrzeit kommt alles an
  noneHours: 8,                      // ab dieser Fahrzeit kommt nichts mehr an
  enemyKm: 2,                        // in diesem Umkreis um Feinde ...
  enemySlow: 4,                      // ... dauert der Transport so viel länger
  reach: 3,                          // Zellen: Kompanien am Rand des eigenen Gebiets nutzen das nächste erreichbare Feld
  usePerHour: 1 / 6,                 // Verbrauch je Stunde (ein voller Vorrat reicht 6 h)
  combatUse: 2,                      // im Gefecht doppelt so viel
  refillPerHour: 0.5,                // so schnell wird ein leerer Vorrat höchstens aufgefüllt
  demand: { light: 1, heavy: 1.5 },  // Panzer brauchen zusätzlich Treibstoff
  depotPerHour: UNITS_PER_CITY / 6 * 1.25, // Lieferleistung je Stadt (Grundlasten je Stunde)
  interval: 2,                       // Sekunden zwischen Neuberechnungen des Netzes je Seite
  tick: 0.5,                         // Sekunden zwischen zwei Lieferungen
  convoys: false,                    // vorbereitet: LKW-Kolonnen statt Sofortlieferung (noch nicht eingebaut)
  combatMin: 0.5,                    // Kampfkraft mit leerem Vorrat (volle ab halbem Vorrat)
  fuelLow: 0.3,                      // darunter fehlt Panzern der Treibstoff ...
  fuelMinSpeed: 0.35,                // ... und sie fahren mit leerem Tank nur noch so schnell
  warnBelow: 0.35,                   // Warnzeichen am Symbol
};

export const DIVISION_ROTATE = 0.25; // darunter tauscht eine Kompanie mit einer frischen
export const ROAD_SPEED = 1.6;   // Tempo auf Straßen (Ebene = 1)
export const BRIDGE_SPEED = 1;   // Tempo auf Brücken über Wasser
export const UNIT_VISION = 85;
export const CITY_VISION = 165;
export const UNIT_BORDER = 40;
export const CITY_BORDER = 80;

// Seiten: 0 neutral, 1 Spieler (blau), 2–5 KI-Gegner
export const PLAYER_COLORS = ['#9a9a9a', '#2f6fe0', '#e0412f', '#2fa84f', '#e0a020', '#9b4fd8'];
export const PLAYER_RGB = [[150, 150, 150], [47, 111, 224], [224, 65, 47], [47, 168, 79], [224, 160, 32], [155, 79, 216]];
export const PLAYER_NAMES = ['Neutral', 'Blau', 'Rot', 'Grün', 'Gelb', 'Violett'];
// Farbbereich (Farbton von–bis) für die Divisionen jeder Seite
export const PLAYER_HUES = [null, [185, 255], [340, 395], [95, 150], [38, 58], [268, 318]];
export const MAX_AI = 4;
export const WIN_SHARE = 0.7;          // so viel Land gewinnt die Runde
export const START_UNITS = ['light', 'light', 'light', 'heavy']; // Startkompanien je Seite

export const DIFFICULTY = {
  easy: { name: 'Leicht', interval: 2.4, seeAll: false, prodMult: 0.8, heavyRatio: 0.15, retreatAt: 0.2, attackFactor: 1.0, frontShare: 0.35, frontPush: 2.6, rotate: false },
  medium: { name: 'Mittel', interval: 1.2, seeAll: false, prodMult: 1.0, heavyRatio: 0.3, retreatAt: 0.33, attackFactor: 1.3, frontShare: 0.45, frontPush: 2.0, rotate: true },
  hard: { name: 'Schwer', interval: 0.6, seeAll: true, prodMult: 1.25, heavyRatio: 0.35, retreatAt: 0.4, attackFactor: 1.45, frontShare: 0.5, frontPush: 1.7, rotate: true },
};
