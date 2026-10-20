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
- **Einheiten:** Infanterie/leicht (10 km/h, günstig) und Panzer/schwer (18 km/h, robust, stark auf Ebenen), dargestellt als NATO-Symbole nach APP-6: Rechteck = eigene, Raute = feindliche Einheit (im Farbton ihrer Division, grau ohne Division), X = Infanterie, Oval = Panzer. Städte produzieren sie; ein Klick auf die eigene Stadt wechselt den Typ.
- **Maßstab:** 1 Kartenfeld = 1 km, die mittlere Insel misst 160 × 96 km. Bei Tempo 1× vergehen in einer Sekunde 6 Minuten Spielzeit; alle Geschwindigkeiten stehen als km/h in `js/config.js` (Straßen ×1,6).
- **Gelände:** Ebene, Wald (−25 % Angriff), Hügel (+50 % Angriff, mehr Sicht), Wasser (−50 % Angriff, langsam), Gebirge und tiefes Wasser sind unpassierbar.
- **Kampf** läuft automatisch. Eingekesselte Einheiten nehmen 50 % mehr Schaden.
- **Nachschub** (`js/supply.js`): Jede eigene Stadt ist ein Depot. Ein Dijkstra über das eigene Gebiet berechnet die LKW-Fahrzeit zu jedem Feld (Straße 50 km/h, Gelände 4–20 km/h, Feindgebiet sperrt, 2 km um Feinde vierfache Zeit). Jede Kompanie hat einen Vorrat (1/6 je Stunde, im Gefecht doppelt) und fordert Nachschub an; voll bis 3 h Fahrt, nichts ab 8 h. Verbundene Depots teilen sich ihre Lieferleistung, Mangel wird gleichmäßig verteilt (Panzer zählen 1,5-fach); Kessel sind abgeschnitten. Wirkung: Heilen nur mit Vorrat, sonst Abnutzung, Kampfkraft bis 50 %, Panzer ohne Treibstoff langsam. Kartenebene „Nachschub“ (N). LKW-Kolonnen sind vorbereitet (`dispatch()`/`deliver()`/`route()`, `SUPPLY.convoys`), aber noch nicht eingebaut.
- **Organisation:** Kampfbereitschaft je Kompanie (Infanterie 60, Panzer 35). Schaden trifft sie stärker als die Lebenspunkte; bei 0 ist die Kompanie zerschlagen, kämpft nicht, erobert nichts und zieht sich zurück (auch von der Front), ab 50 % ist sie wieder einsatzbereit. Erholung außerhalb des Gefechts je nach Nachschub. KI und HQs berücksichtigen Organisation und Nachschub.
- **Städte** produzieren Einheiten, bis zu 10 je eigener Stadt.
- **Gliederung:** Division (XX) → Regiment (III) → Kompanie (I). Alle Kompanien starten ohne Division; Spieler und KI fassen sie nach Bedarf zu Divisionen zusammen (höchstens 12 Kompanien) oder nehmen sie wieder heraus. Die Regimenter (2–3 Kompanien, Infanterie und Panzer getrennt) ordnet das Spiel selbst. Leere Divisionen lösen sich auf und geben Nummer und Farbe frei. Kompanien ohne Division sind die Reserve: frei verfügbar, aber ohne HQ, Front und Rotation. Innerhalb einer Division rotieren Kompanien: Unter 25 % im Gefecht tauscht eine Kompanie den Platz mit einer frischen in der Nähe.
- **Fronten wie in Hearts of Iron:** Jede Front gehört zu genau einer Division, ihre Kompanien verteilen sich darauf und halten sie. Eine gezeichnete Linie nahe der Grenze rastet als Grenzabschnitt ein und wandert mit der Grenze; „Grenze“ mit mehreren Divisionen teilt die Grenze nach Stärke auf. Abschnitte werden über eine feste Achse quer zur Stoßrichtung abgegrenzt, benachbarte teilen sich einen Ankerpunkt (keine Lücken, keine Überlappung); ein neuer Abschnitt kürzt ältere. Angriffe wie in HOI4: Division mit Front auswählen → „➜ Angriff planen“ → Ziellinie ziehen (NATO-Phasenlinie mit Decknamen und Hauptangriffsachse nach APP-6; geplant gestrichelt, laufend durchgezogen) → „▶ Angriff starten“. Optional ziehen sich Verwundete zum Heilen zurück (Rotation).
- **Sichtbarkeit der Fronten:** Auf der Karte erscheint nur die Front der ausgewählten Division; „Fronten“ (V) blendet alle eigenen ein. Grenzstücke ohne Front sind rot gestrichelt. Fronten und Angriffspläne des Gegners bleiben verborgen.
- **Divisions-HQs:** Jede Division hat ein HQ hinter der Linie (keine Kampfeinheit). Es gleicht in der Verteidigung Kräfte aus, indem es ruhige Kompanien an bedrängte Stellen schickt, und riegelt Durchbrüche mit einem freien Regiment ab. Ist der Abschnitt einer Division weitgehend leer, funkt ihr HQ die Nachbarfronten an; der Nachbar mit Reserven übernimmt vorübergehend (bis 3 Kompanien, 30 s).
- **Divisionsleiste:** Unten Werkzeuge zur Gliederung („＋ Neue Division“, „− Aus Division“, „Auffüllen“, „Auto-Gliederung“) und eine Karte je Division (NATO-Symbol, Name, Stärke, Regimenter) wie in HOI4; Antippen wählt die Division, „＋“ fügt die Auswahl hinzu.
- **KI:** Bildet Front-Divisionen (6–10 Kompanien) nach ihrer Lage an der Grenze, teilt die Grenze unter ihnen auf und behält eine Reserve ohne Division für Städte. Bei Überlegenheit stoßen die 1–2 Divisionen nächst einer Stadt vor; kippt das Kräfteverhältnis, kehren sie in ihre Abschnitte zurück. Auf „Schwer“ sieht sie die ganze Karte.
- **Straßen:** Ein Straßennetz verbindet die Städte (Relative Neighborhood Graph, Trassen meiden Hügel/Wald und Gebirge, Brücken über Wasser). Auf Straßen sind Einheiten 60 % schneller.
- **Gebiet:** Die Insel wird beim Start lückenlos aufgeteilt (jedes Feld gehört der Seite, deren Stadt es auf dem Landweg am schnellsten erreicht), es gibt also von Anfang an eine durchgehende Grenze ohne Niemandsland.
- **Nebel des Krieges:** Gegner sind nur in Sichtweite sichtbar.

## Steuerung

| Aktion | PC | Handy |
| --- | --- | --- |
| Weg zeichnen | Von eigener Einheit aus ziehen | Von eigener Einheit aus ziehen |
| Auswählen | Einheit anklicken / Rahmen aufziehen (Umschalt = hinzufügen) | Einheit antippen / „▢ Auswahl“ + Rahmen |
| Division auswählen | Karte in der Divisionsleiste | ebenso |
| Gruppe bewegen | Von ausgewählter Einheit ziehen oder auf Ziel klicken | ebenso |
| Anhalten | S | „■ Halt“ |
| Neue Division / aus Division | D / Umschalt+D | „＋ Neue Division“ / „− Aus Division“ |
| Karte verschieben | Rechte Maustaste ziehen | Ein Finger ziehen |
| Zoomen | Mausrad | Zwei Finger |
| Front zeichnen | Division wählen, „〰 Front“ (F), dann Linie ziehen | ebenso |
| Grenze halten | Division(en) wählen, „⛨ Grenze“ (G) | ebenso |
| Alle Fronten zeigen | „Fronten“ (V) | ebenso |
| Nachschub zeigen | „Nachschub“ (N) | ebenso |
| Produktion wechseln | Eigene Stadt anklicken (ohne Auswahl) | Stadt antippen |

Tasten: Leertaste Pause · A alle auswählen · S anhalten · D/Umschalt+D Division · F Front · G Grenze · V Fronten · N Nachschub · Esc abwählen · 1/2/3 Tempo.

## Aufbau

```
index.html          Oberfläche (Menü, HUD, Divisionsleiste, Hilfe)
css/style.css       Gestaltung
js/config.js        Spielwerte (Gelände, Einheiten, Schwierigkeit)
js/rng.js           Zufallszahlen und Rauschen für die Karte
js/map.js           Kartengenerator (punktsymmetrische Insel), Straßen und A*-Wegfindung
js/orbat.js         Gliederung: Divisionen, Regimenter, Kompanien
js/game.js          Simulation: Bewegung, Kampf, Organisation, Städte, Gebiet, Sicht, Rotation
js/hq.js            Divisions-HQs: Kräfteausgleich, Abriegeln, Funk zwischen Nachbarfronten
js/supply.js        Nachschub: Depots, LKW-Netz über eigenes Gebiet, Vorräte, Verteilung
js/fronts.js        Fronten je Division, Grenzabschnitte, Angriffe
js/ai.js            KI-Gegner: Gliederung, Fronten, Angriffe, Reserve
js/render.js        Canvas-Darstellung
js/input.js         Maus-, Touch- und Tastatursteuerung
js/main.js          Spielschleife, Menüs und Bedienung
test/sim.mjs        Test ohne Browser (npm test)
scripts/bump-version.sh  Versionsnummer gegen veraltete Browser-Caches
```

## Veröffentlichen

GitHub Pages veröffentlicht die Seite direkt aus dem Branch `main` (Settings → Pages → „Deploy from a branch“). Jeder Push aktualisiert das Spiel nach etwa einer Minute.

Vor dem Veröffentlichen `npm test` ausführen (Node 18 oder neuer): Die KI spielt auf allen drei Kartengrößen gegen sich selbst, geprüft werden Abstürze, das Spielende, die Gliederung (Höchststärken, Regimenter), die Fronten (eine je Division, keine überlappenden Grenzabschnitte), Nachschub und Organisation (Wertebereiche, Zerschlagene ziehen sich zurück). Der Test prüft zwischen KI und Spielschritt und verändert den Spielverlauf nicht: dieselbe Karte ergibt im Test und im Spiel denselben Ablauf.

Nach Änderungen am Code `./scripts/bump-version.sh` ausführen. Das erhöht die Versionsnummer an allen Skript-Verweisen, damit Browser (vor allem auf dem Handy) nicht die alten Dateien aus dem Cache laden.
