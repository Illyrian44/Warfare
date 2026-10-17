# War of Dots – Browser-Version

Ein minimalistisches Echtzeit-Strategiespiel im Stil von [War of Dots](https://warofdots.net/), komplett im Browser spielbar – am PC und auf dem Handy – gegen eine KI.

Inspiriert vom Original und vom Python-Nachbau [gamepycoder/War-of-dots-](https://github.com/gamepycoder/War-of-dots-). Der Code hier ist eigenständig in JavaScript geschrieben.

## Spielen

- Online über GitHub Pages: `https://illyrian44.github.io/Warfare/`
- Lokal: einen beliebigen statischen Webserver im Projektordner starten, z. B.
  `python3 -m http.server 8000` und dann <http://localhost:8000> öffnen.
  (Direktes Öffnen der `index.html` per Doppelklick funktioniert wegen der ES-Module nicht.)

## Regeln in Kürze

- **Ziel:** alle gegnerischen Städte erobern und die Armee vernichten.
- **Einheiten:** leicht (schnell, günstig) und schwer (robust, stark auf Ebenen). Städte produzieren sie; ein Klick auf die eigene Stadt wechselt den Typ.
- **Gelände:** Ebene, Wald (−25 % Angriff), Hügel (+50 % Angriff, mehr Sicht), Wasser (−50 % Angriff, langsam), Gebirge und tiefes Wasser sind unpassierbar.
- **Kampf** läuft automatisch. Eingekesselte Einheiten nehmen 50 % mehr Schaden.
- **Versorgung:** Heilung nahe eigener Städte, Schaden tief im Feindesland. Jede Stadt versorgt 5 Einheiten, überzählige hungern.
- **Nebel des Krieges:** Gegner sind nur in Sichtweite sichtbar.

## Steuerung

| Aktion | PC | Handy |
| --- | --- | --- |
| Weg zeichnen | Von eigener Einheit aus ziehen | Von eigener Einheit aus ziehen |
| Auswählen | Einheit anklicken / Rahmen aufziehen (Umschalt = hinzufügen) | Einheit antippen / „▢ Auswahl“ + Rahmen |
| Gruppe bewegen | Von ausgewählter Einheit ziehen oder auf Ziel klicken | ebenso |
| Karte verschieben | Rechte Maustaste ziehen | Ein Finger ziehen |
| Zoomen | Mausrad | Zwei Finger |
| Produktion wechseln | Eigene Stadt anklicken (ohne Auswahl) | Stadt antippen |

Tasten: Leertaste Pause · A alle auswählen · S anhalten · Esc abwählen · 1/2/3 Tempo.

## Aufbau

```
index.html        Oberfläche (Menü, HUD, Hilfe)
css/style.css     Gestaltung
js/config.js      Spielwerte (Gelände, Einheiten, Schwierigkeit)
js/map.js         Kartengenerator (punktsymmetrische Insel) und A*-Wegfindung
js/game.js        Simulation: Bewegung, Kampf, Versorgung, Städte, Gebiet, Sicht
js/ai.js          KI-Gegner
js/render.js      Canvas-Darstellung
js/input.js       Maus-, Touch- und Tastatursteuerung
js/main.js        Spielschleife und Menüs
```

## Veröffentlichen

Der Workflow `.github/workflows/pages.yml` veröffentlicht die Seite bei jedem Push auf `main`. Einmalig in den Repository-Einstellungen unter **Settings → Pages → Source** „GitHub Actions“ auswählen.
