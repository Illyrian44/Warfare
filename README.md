# Phase Line

Ein Echtzeit-Strategiespiel mit Fronten, Divisionen und Armeen auf einer Lagekarte mit NATO-Symbolen, komplett im Browser spielbar – am PC und auf dem Handy – gegen eine KI. Entstanden aus einem Nachbau von [War of Dots](https://warofdots.net/).

Inspiriert vom Original und vom Python-Nachbau [gamepycoder/War-of-dots-](https://github.com/gamepycoder/War-of-dots-). Der Code hier ist eigenständig in JavaScript geschrieben.

## Spielen

- Online über GitHub Pages: `https://illyrian44.github.io/Warfare/`
- Lokal: einen beliebigen statischen Webserver im Projektordner starten, z. B.
  `python3 -m http.server 8000` und dann <http://localhost:8000> öffnen.
  (Direktes Öffnen der `index.html` per Doppelklick funktioniert wegen der ES-Module nicht.)

## Regeln in Kürze

- **Ziel:** 70 % des Landes halten oder als Letzter übrig bleiben, gegen 1–4 KI-Gegner (jeder gegen jeden). Ausgeschieden ist, wer weder Städte noch Truppen hat. Jede Runde beginnt pausiert, damit man in Ruhe gliedern und Fronten setzen kann.
- **Einheiten:** Infanterie/leicht (10 km/h, günstig) und Panzer/schwer (18 km/h, robust, stark auf Ebenen), dargestellt als NATO-Symbole nach APP-6: Rechteck = eigene, Raute = feindliche Einheit (im Farbton ihrer Division, grau ohne Division), X = Infanterie, Oval = Panzer. Städte produzieren sie; ein Klick auf die eigene Stadt wechselt den Typ.
- **Karten nach echter Geografie:** Balkan (223 × 135 Felder) und Mitteleuropa (178 × 162 Felder), je etwa 6 km pro Feld. Küsten, Gebirge (Höhen), Flüsse, Seen, Fernstraßen und die größten Städte (deutsche Namen, wo üblich) stammen aus offenen Daten; Land außerhalb der Region und unerreichbare Inseln sind „Ausland“ (sichtbar, nicht spielbar, zählt nicht zum Landanteil). Straßen über Gebirge werden zu Pässen, Flussfelder sind flaches Wasser mit Brücken an den Straßen. Gebaut werden die Kartendateien `maps/*.json` einmalig mit `node scripts/build-maps.mjs <Datenordner>`. Quellen: [Natural Earth](https://www.naturalearthdata.com/) (gemeinfrei) und die Terrain Tiles von Mapzen/Tilezen (AWS Open Data).
- **Maßstab:** Das Spieltempo ist bewusst stilisiert: Die Mechanik rechnet weiter so, als wäre ein Feld 1 km und eine Sekunde 6 Minuten (alle Geschwindigkeiten als km/h in `js/config.js`, Straßen ×1,6). So fühlt sich das Spiel auf den großen echten Karten so flüssig an wie vorher; auf der Karte kommen Einheiten dadurch schneller voran als in Wirklichkeit.
- **Gelände:** Ebene, Wald (−25 % Angriff), Hügel (+50 % Angriff, mehr Sicht), Wasser (−50 % Angriff, langsam), Gebirge und tiefes Wasser sind unpassierbar.
- **Kampf** läuft automatisch. Eingekesselte Einheiten nehmen 50 % mehr Schaden.
- **Nachschub** (`js/supply.js`): Jede eigene Stadt ist ein Depot. Ein Dijkstra über das eigene Gebiet berechnet die LKW-Fahrzeit zu jedem Feld (Straße 50 km/h, Gelände 4–20 km/h, Feindgebiet sperrt, 2 km um Feinde vierfache Zeit). Jede Kompanie hat einen Vorrat (1/6 je Stunde, im Gefecht doppelt) und fordert Nachschub an; voll bis 3 h Fahrt, nichts ab 8 h. Verbundene Depots teilen sich ihre Lieferleistung, Mangel wird gleichmäßig verteilt (Panzer zählen 1,5-fach); Kessel sind abgeschnitten. Wirkung: Heilen nur mit Vorrat, sonst Abnutzung, Kampfkraft bis 50 %, Panzer ohne Treibstoff langsam. Kartenebene „Nachschub“ (N). LKW-Kolonnen sind vorbereitet (`dispatch()`/`deliver()`/`route()`, `SUPPLY.convoys`), aber noch nicht eingebaut.
- **Organisation:** Kampfbereitschaft je Kompanie (Infanterie 60, Panzer 35). Schaden trifft sie stärker als die Lebenspunkte; bei 0 ist die Kompanie zerschlagen, kämpft nicht, erobert nichts, nimmt keine Befehle an und zieht sich zurück (auch von der Front), ab 50 % ist sie wieder einsatzbereit. Erholung außerhalb des Gefechts je nach Nachschub. KI und HQs berücksichtigen Organisation und Nachschub.
- **Baumenü** (`js/production.js`): Nichts entsteht von selbst. Der Spieler bestellt in einer eigenen Stadt einzelne Kompanien oder ganze Divisionen nach Vorlage (`TEMPLATES`), verstärkt ausgewählte Divisionen (Ausbildung in der nächsten Stadt), schaltet „Auffüllen“ ein (die Division bestellt Ersatz selbst) und rüstet Divisionen aus (`UPGRADES`: Ausbildung +20 % Organisation, Artillerie +15 % Kampfkraft je Stufe). Eine Stadt bildet je nach Größe 1–3 Kompanien gleichzeitig aus; bezahlt wird beim Auftrag, ein Abbruch erstattet alles, fällt die Stadt, verfallen ihre Aufträge. Die KI bestellt ebenso über das Baumenü.
- **Städte ausbauen** (`BUILDINGS` in `js/config.js`): Wohnviertel (+Manpower), Fabrik (+Geld, nötig für Panzer), Kaserne (+1 Ausbildungsplatz), Depot (+50 % Nachschubleistung), Festung (Verteidiger −15 % Schaden, Eroberung +50 % Zeit) und Hafen (nur an der Küste, +Geld, Seehandel) – je bis Stufe 3, Preis und Bauzeit steigen mit der Stufe, je Stadt ein Bau zugleich. Eroberte Städte behalten ihre Gebäude. Die KI baut zuerst eine Fabrik, dann je nach Engpass Wohnviertel, Kasernen oder Fabriken.
- **Wirtschaft** (`ECONOMY` in `js/config.js`): Jede Seite hat Geld und Manpower. Städte liefern nach ihrer Größe (Klein-, Mittel-, Großstadt aus der echten Einwohnerzahl; die eigene Hauptstadt zählt als Großstadt), jedes Prozent Land bringt etwas Geld. Manpower sammelt sich bis zu einem Vorrat. Kompanien kosten beides (Infanterie 30 Geld/150 Manpower, Panzer 100/90). Die Schwierigkeit der KI wirkt auf ihr Einkommen.
- **Gliederung:** Armee (XXXX) → Division (XX) → Regiment (III) → Kompanie (I). Armeen fassen beliebig viele Divisionen zusammen; Grenze, Front und Angriff für eine Armee werden nach Stärke auf ihre Divisionen aufgeteilt, eine neue Division in der Armee löst eine Neuaufteilung aus. Alle Kompanien starten ohne Division; Spieler und KI fassen sie nach Bedarf zu Divisionen zusammen (höchstens 12 Kompanien) oder nehmen sie wieder heraus. Die Regimenter (2–3 Kompanien, Infanterie und Panzer getrennt) ordnet das Spiel selbst. Leere Divisionen lösen sich auf und geben Nummer und Farbe frei. Kompanien ohne Division sind die Reserve: frei verfügbar, aber ohne HQ, Front und Rotation. Innerhalb einer Division rotieren Kompanien: Unter 25 % im Gefecht tauscht eine Kompanie den Platz mit einer frischen in der Nähe.
- **Fronten wie in Hearts of Iron:** Jede Front gehört zu genau einer Division, ihre Kompanien verteilen sich darauf und halten sie. Eine gezeichnete Linie nahe der Grenze rastet als Grenzabschnitt ein und wandert mit der Grenze; „Grenze“ nimmt die Divisionen mit, die schon an der Grenze stehen, und teilt sie unter allen nach Stärke auf; ganz überdeckte Abschnitte werden mitgeteilt statt entzogen. Haltende Fronten nehmen kein Land ein (sonst schöbe jede Front die Grenze und ihre eigenen Plätze immer weiter vor), Verschiebungen laufen hinter der eigenen Linie (Feindgebiet ist für die Wegsuche sehr teuer). Abschnitte werden über eine feste Achse quer zur Stoßrichtung abgegrenzt, benachbarte teilen sich einen Ankerpunkt (keine Lücken, keine Überlappung); ein neuer Abschnitt kürzt ältere. Angriffe wie in HOI4: Division(en) oder Armee mit Front auswählen → „➜ Angriff planen“ → Ziellinie ziehen (NATO-Phasenlinie mit gemeinsamem Decknamen und Hauptangriffsachse nach APP-6; geplant gestrichelt, laufend durchgezogen) → „▶ Angriff starten“. Ein Angriff ist ein Auftrag an die bestehende Front: Die Division bleibt ihrem Grenzabschnitt zugewiesen, es entsteht keine neue Front im Feindesland; danach hält sie die vorgeschobene Grenze. Optional ziehen sich Verwundete zum Heilen zurück (Rotation).
- **Sichtbarkeit der Fronten:** Auf der Karte erscheint nur die Front der ausgewählten Division; „Fronten“ (V) blendet alle eigenen ein. Grenzstücke ohne Front sind rot gestrichelt. Fronten und Angriffspläne des Gegners bleiben verborgen.
- **Divisions-HQs:** Jede Division hat ein HQ hinter der Linie (keine Kampfeinheit). Es gleicht in der Verteidigung Kräfte aus, indem es ruhige Kompanien an bedrängte Stellen schickt, und riegelt Durchbrüche mit einem freien Regiment ab. Ist der Abschnitt einer Division weitgehend leer, funkt ihr HQ die Nachbarfronten an; der Nachbar mit Reserven übernimmt vorübergehend (bis 3 Kompanien, 30 s).
- **Divisionsleiste:** Eine Karte je Armee (aufklappbar) und je Division (NATO-Symbol, Name, Stärke, Regimenter) wie in HOI4; Antippen wählt die Armee bzw. Division, „＋“ fügt die Auswahl hinzu.
- **Befehlsfeld:** Erscheint unten rechts nur mit einer Auswahl und zeigt nur passende Befehle (Halt, Division/Armee bilden oder auflösen, Auffüllen; Front, Grenze und Angriff nur mit ausgewählten Divisionen). „Auto-Gliederung“ steht in der unteren Leiste, solange es Kompanien ohne Division gibt. Das Feld lässt sich an der Titelzeile verschieben und am Griff unten rechts skalieren (60–160 %); Doppelklick auf die Titelzeile setzt es zurück, Lage und Größe bleiben gespeichert.
- **KI:** Fasst ihre Divisionen zu einer Armee zusammen; eigene Fronttruppen decken nahe Städte mit, an der Truppenobergrenze stößt die stärkste Front begrenzt vor. Bildet Front-Divisionen (6–10 Kompanien) nach ihrer Lage an der Grenze, teilt die Grenze unter ihnen auf und behält eine Reserve ohne Division für Städte. Bei Überlegenheit stoßen die 1–2 Divisionen nächst einer Stadt vor; kippt das Kräfteverhältnis, kehren sie in ihre Abschnitte zurück. Auf „Schwer“ sieht sie die ganze Karte.
- **Straßen:** Ein Straßennetz verbindet die Städte (Relative Neighborhood Graph, Trassen meiden Hügel/Wald und Gebirge, Brücken über Wasser). Auf Straßen sind Einheiten 60 % schneller.
- **Start und Gebiet:** Wie bei OpenFront wählst du deine Startstadt auf der Karte (oder zufällig); die KI-Gegner verteilen sich möglichst weit entfernt. Jede Seite beginnt mit einer Stadt, dem Land ringsum und 4 Kompanien, alles andere ist neutral. Eroberte Städte bringen das Land ringsum, marschierende Einheiten nehmen Land ein, haltende Grenzfronten nicht. Grenzabschnitte werden über ihren Winkel um die eigene Startstadt abgegrenzt, so tragen sie auch Grenzen zu mehreren Gegnern ringsum.
- **Nebel des Krieges:** Gegner sind nur in Sichtweite sichtbar.

## Steuerung

| Aktion | PC | Handy |
| --- | --- | --- |
| Auswählen | Einheit anklicken (erneut: Gruppe → Division → Kompanie) / Rahmen mit links aufziehen (Umschalt = hinzufügen) | Einheit antippen (erneut: ebenso) / „▢ Auswahl“ + Rahmen |
| Division / Armee auswählen | Karte in der Divisionsleiste | ebenso |
| Bewegen | Rechtsklick auf das Ziel (dicht aufstellen), Umschalt+Rechtsklick behält die Abstände | Mit Auswahl auf das Ziel tippen |
| Abwählen | Klick ins Leere / Esc | „✕“ im Befehlsfeld |
| Anhalten | S | „■ Halt“ |
| Neue Division / aus Division | D / Umschalt+D | „＋ Neue Division“ / „− Aus Division“ |
| Neue Armee | Divisionen wählen, „＋ Neue Armee“ | ebenso |
| Karte verschieben | Rechte oder mittlere Maustaste ziehen | Ein Finger ziehen |
| Zoomen | Mausrad | Zwei Finger |
| Front zeichnen | Division(en) oder Armee wählen, „〰 Front“ (F), dann Linie ziehen | ebenso |
| Grenze halten | Division(en) wählen, „⛨ Grenze“ (G) | ebenso |
| Alle Fronten zeigen | „Fronten“ (V) | ebenso |
| Nachschub zeigen | „Nachschub“ (N) | ebenso |
| Baumenü | „🏗 Bauen“ (B) oder eigene Stadt anklicken (ohne Auswahl) | ebenso |

Tasten: Leertaste Pause · A alle auswählen · S anhalten · D/Umschalt+D Division · F Front · G Grenze (beide nur mit ausgewählten Divisionen) · V Fronten · N Nachschub · B Baumenü · Esc abwählen · 1/2/3 Tempo.

## Aufbau

```
index.html          Oberfläche (Menü, HUD, Divisionsleiste, Hilfe)
css/style.css       Gestaltung
js/config.js        Spielwerte (Gelände, Einheiten, Schwierigkeit)
js/rng.js           Zufallszahlen und Rauschen für die Karte
js/map.js           Karten laden (maps/*.json), Gelände, Straßen und A*-Wegfindung
maps/*.json         Kartendaten (Höhe, Wald, Flüsse, Straßen, Ausland, Städte)
scripts/build-maps.mjs  baut die Kartendaten aus Natural Earth und Höhendaten
js/orbat.js         Gliederung: Armeen, Divisionen, Regimenter, Kompanien
js/game.js          Simulation: Bewegung, Kampf, Organisation, Städte, Gebiet, Sicht, Rotation
js/hq.js            Divisions-HQs: Kräfteausgleich, Abriegeln, Funk zwischen Nachbarfronten
js/production.js    Baumenü: Ausbildung je Stadt, Divisionsvorlagen, Verstärkung, Ausrüstung
js/supply.js        Nachschub: Depots, LKW-Netz über eigenes Gebiet, Vorräte, Verteilung
js/fronts.js        Fronten je Division, Grenzabschnitte, Angriffe
js/ai.js            KI-Gegner: Gliederung, Fronten, Angriffe, Reserve
js/render.js        Canvas-Darstellung
js/input.js         Maus-, Touch- und Tastatursteuerung, Klickfolge
js/formation.js     Aufstellung am Ziel
js/main.js          Spielschleife, Menüs und Bedienung
test/sim.mjs        Test ohne Browser (npm test)
scripts/bump-version.sh  Versionsnummer gegen veraltete Browser-Caches
```

## Veröffentlichen

GitHub Pages veröffentlicht die Seite direkt aus dem Branch `main` (Settings → Pages → „Deploy from a branch“). Jeder Push aktualisiert das Spiel nach etwa einer Minute.

Vor dem Veröffentlichen `npm test` ausführen (Node 18 oder neuer): Die KI spielt auf beiden Karten mit 2, 3 und 5 Seiten gegen sich selbst, geprüft werden Abstürze, das Spielende, die Gliederung (Höchststärken, Regimenter), die Fronten (eine je Division, keine überlappenden Grenzabschnitte), Nachschub und Organisation (Wertebereiche, Zerschlagene ziehen sich zurück). Der Test prüft zwischen KI und Spielschritt und verändert den Spielverlauf nicht: dieselbe Karte ergibt im Test und im Spiel denselben Ablauf.

Nach Änderungen am Code `./scripts/bump-version.sh` ausführen. Das erhöht die Versionsnummer an allen Skript-Verweisen, damit Browser (vor allem auf dem Handy) nicht die alten Dateien aus dem Cache laden.
