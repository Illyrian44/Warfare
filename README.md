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
- **Versorgung:** Heilung nahe eigener Städte, Schaden tief im Feindesland. Jede Stadt versorgt 10 Einheiten, überzählige hungern.
- **Frontlinien wie in Hearts of Iron:** Einheiten einer gezeichneten Linie oder der Grenze zum Gegner zuweisen. Sie verteilen sich gleichmäßig und halten die Stellung. Grenzfronten wandern mit der Grenze. Angriffe laufen wie in HOI4: Front antippen → „➜ Angriff planen“ → Ziellinie ziehen (dargestellt als NATO-Phasenlinie mit Decknamen und Hauptangriffsachse nach APP-6; geplant gestrichelt, laufend durchgezogen) → „▶ Angriff starten“. Optional rücken neue Einheiten automatisch nach (Verstärkung) und Verwundete ziehen sich zum Heilen zurück (Rotation). Die KI nutzt dieselbe Logik: Ein Teil ihrer Armee hält eine Grenzfront; bei Überlegenheit plant sie einen Angriffspfeil hinter die nächste feindliche Stadt, bricht ab, wenn das Kräfteverhältnis kippt, und folgt danach wieder der Grenze. Angriffspläne sind geheim: Keine Seite sieht die Pfeile oder Ziellinien der anderen, nur die Truppen in Sichtweite.
- **Gliederung:** Jede Seite startet mit einer Armee (je eigene Stadt eine Division à 8 Kompanien). Feste Gliederung Kompanie → Regiment → Brigade → Division → Korps → Armee mit NATO-Größenzeichen (I, III, X, XX, XXX, XXXX); die Karte fasst Truppen zusammen, sobald sich ihre Symbole überdecken würden (Stufe nach Sollstärke: ab 2 Kompanien Regiment, ab 4 Brigade, ab 8 Division, ab 16 Korps, ab 32 Armee; Name nach dem häufigsten Verband); ganz nah erscheinen einzelne Kompanien. Innerhalb einer Division rotieren Kompanien: Unter 25 % im Gefecht tauscht eine Kompanie den Platz mit einer frischen in der Nähe.
- **Divisions-HQs:** Jede Division hat ein HQ hinter der Linie (keine Kampfeinheit). Es gleicht in der Verteidigung Kräfte aus, indem es ruhige Kompanien an bedrängte Abschnitte schickt, und riegelt Durchbrüche mit einem freien Regiment ab.
- **Divisionsleiste:** Unten eine Karte je Division (NATO-Symbol, Name, Stärke, Regimenter als Icons) wie in HOI4; Antippen wählt die Division.
- **Straßen:** Ein Straßennetz verbindet die Städte (Relative Neighborhood Graph, Trassen meiden Hügel/Wald und Gebirge, Brücken über Wasser). Auf Straßen sind Einheiten 60 % schneller.
- **Gebiet:** Die Insel wird beim Start lückenlos aufgeteilt (jedes Feld gehört der Seite, deren Stadt es auf dem Landweg am schnellsten erreicht), es gibt also von Anfang an eine durchgehende Grenze ohne Niemandsland.
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
