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
- **Einheiten:** Infanterie/leicht (schnell, günstig) und Panzer/schwer (robust, stark auf Ebenen), dargestellt als NATO-Symbole nach APP-6: blaues Rechteck = eigene, rote Raute = feindliche Einheit, X = Infanterie, Oval = Panzer. Städte produzieren sie; ein Klick auf die eigene Stadt wechselt den Typ.
- **Gelände:** Ebene, Wald (−25 % Angriff), Hügel (+50 % Angriff, mehr Sicht), Wasser (−50 % Angriff, langsam), Gebirge und tiefes Wasser sind unpassierbar.
- **Kampf** läuft automatisch. Eingekesselte Einheiten nehmen 50 % mehr Schaden.
- **Versorgung:** Heilung nahe eigener Städte, Schaden tief im Feindesland. Jede Stadt versorgt 5 Einheiten, überzählige hungern.
- **Frontlinien wie in Hearts of Iron:** Einheiten einer gezeichneten Linie oder der Grenze zum Gegner zuweisen. Sie verteilen sich gleichmäßig und halten die Stellung. Grenzfronten wandern mit der Grenze und können im Angriffsmodus ins Feindgebiet drücken. Optional rücken neue Einheiten automatisch nach (Verstärkung) und Verwundete ziehen sich zum Heilen zurück (Rotation). Die KI nutzt dieselbe Logik: Ein Teil ihrer Armee hält eine Grenzfront und wechselt bei Überlegenheit in den Angriff.
- **Nebel des Krieges:** Gegner sind nur in Sichtweite sichtbar.

## Steuerung

| Aktion | PC | Handy |
| --- | --- | --- |
| Weg zeichnen | Von eigener Einheit aus ziehen | Von eigener Einheit aus ziehen |
| Auswählen | Einheit anklicken / Rahmen aufziehen (Umschalt = hinzufügen) | Einheit antippen / „▢ Auswahl“ + Rahmen |
| Gruppe bewegen | Von ausgewählter Einheit ziehen oder auf Ziel klicken | ebenso |
| Karte verschieben | Rechte Maustaste ziehen | Ein Finger ziehen |
| Zoomen | Mausrad | Zwei Finger |
| Front zeichnen | „〰 Front“ (F), dann Linie ziehen | ebenso |
| Grenzfront | „⛨ Grenze“ (G) | ebenso |
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
js/fronts.js      Frontlinien (Verteilung, Grenzverfolgung, Rotation)
js/render.js      Canvas-Darstellung
js/input.js       Maus-, Touch- und Tastatursteuerung
js/main.js        Spielschleife und Menüs
```

## Veröffentlichen

GitHub Pages veröffentlicht die Seite direkt aus dem Branch `main` (Settings → Pages → „Deploy from a branch“). Jeder Push aktualisiert das Spiel nach etwa einer Minute.

Nach Änderungen am Code `./scripts/bump-version.sh` ausführen. Das erhöht die Versionsnummer an allen Skript-Verweisen, damit Browser (vor allem auf dem Handy) nicht die alten Dateien aus dem Cache laden.
