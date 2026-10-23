# Phase Line

Ein Echtzeit-Strategiespiel mit Fronten, Divisionen und Armeen auf einer Lagekarte mit NATO-Symbolen, komplett im Browser spielbar – am PC und auf dem Handy – gegen bis zu vier KI-Gegner, mit Wirtschaft, Städtebau, Handel und Bündnissen nach dem Vorbild von OpenFront. Entstanden aus einem Nachbau von [War of Dots](https://warofdots.net/).

Inspiriert vom Original und vom Python-Nachbau [gamepycoder/War-of-dots-](https://github.com/gamepycoder/War-of-dots-). Der Code hier ist eigenständig in JavaScript geschrieben.

## Spielen

- Online über GitHub Pages: `https://illyrian44.github.io/Warfare/`
- Lokal: einen beliebigen statischen Webserver im Projektordner starten, z. B.
  `python3 -m http.server 8000` und dann <http://localhost:8000> öffnen.
  (Direktes Öffnen der `index.html` per Doppelklick funktioniert wegen der ES-Module nicht.)

## Regeln in Kürze

- **Ziel:** 70 % des Landes halten oder als Letzter übrig bleiben, gegen 1–4 KI-Gegner (jeder gegen jeden). Ausgeschieden ist, wer weder Städte noch Truppen hat. Jede Runde beginnt pausiert, damit man in Ruhe gliedern und Fronten setzen kann.
- **Einheiten:** Infanterie/leicht (10 km/h, günstig) und Panzer/schwer (18 km/h, robust, stark auf Ebenen), dargestellt als NATO-Symbole nach APP-6: Rechteck = eigene oder verbündete, Raute = feindliche Einheit (im Farbton ihrer Division bzw. Seite, eigene ohne Division grau), X = Infanterie, Oval = Panzer. Städte produzieren sie; ein Klick auf die eigene Stadt wechselt den Typ.
- **Karten nach echter Geografie:** Balkan (232 × 223 Felder, mit ganz Griechenland) und Mitteleuropa (178 × 162 Felder), je etwa 6 km pro Feld. Küsten, Gebirge (Höhen), Flüsse, Seen, Fernstraßen und die größten Städte (deutsche Namen, wo üblich) stammen aus offenen Daten; Land außerhalb der Region und unerreichbare Inseln sind „Ausland“ (sichtbar, nicht spielbar, zählt nicht zum Landanteil). Straßen über Gebirge werden zu Pässen, Flussfelder sind flaches Wasser mit Brücken an den Straßen. Gebaut werden die Kartendateien `maps/*.json` einmalig mit `node scripts/build-maps.mjs <Datenordner>`. Quellen: [Natural Earth](https://www.naturalearthdata.com/) (gemeinfrei) und die Terrain Tiles von Mapzen/Tilezen (AWS Open Data).
- **Maßstab:** Das Spieltempo ist bewusst stilisiert: Die Mechanik rechnet weiter so, als wäre ein Feld 1 km und eine Sekunde 6 Minuten (alle Geschwindigkeiten als km/h in `js/config.js`, Straßen ×1,6). So fühlt sich das Spiel auf den großen echten Karten so flüssig an wie vorher; auf der Karte kommen Einheiten dadurch schneller voran als in Wirklichkeit.
- **Gelände:** Ebene, Wald (−25 % Angriff), Hügel (+50 % Angriff, mehr Sicht), Wasser (−50 % Angriff, langsam), Gebirge und tiefes Wasser sind unpassierbar.
- **Kampf** läuft automatisch. Eingekesselte Einheiten nehmen 50 % mehr Schaden.
- **Nachschub** (`js/supply.js`): Jede eigene Stadt ist ein Depot. Ein Dijkstra über das eigene Gebiet berechnet die LKW-Fahrzeit zu jedem Feld (Straße 50 km/h, Gelände 4–20 km/h, Feindgebiet sperrt, 2 km um Feinde vierfache Zeit). Jede Kompanie hat einen Vorrat (1/6 je Stunde, im Gefecht doppelt) und fordert Nachschub an; voll bis 3 h Fahrt, nichts ab 8 h. Verbundene Depots teilen sich ihre Lieferleistung, Mangel wird gleichmäßig verteilt (Panzer zählen 1,5-fach); Kessel sind abgeschnitten. Wirkung: Heilen nur mit Vorrat, sonst Abnutzung, Kampfkraft bis 50 %, Panzer ohne Treibstoff langsam. Kartenebene „Nachschub“ (N). LKW-Kolonnen sind vorbereitet (`dispatch()`/`deliver()`/`route()`, `SUPPLY.convoys`), aber noch nicht eingebaut.
- **Organisation:** Kampfbereitschaft je Kompanie (Infanterie 60, Panzer 35). Schaden trifft sie stärker als die Lebenspunkte; bei 0 ist die Kompanie zerschlagen, kämpft nicht, erobert nichts, nimmt keine Befehle an und zieht sich zurück (auch von der Front), ab 50 % ist sie wieder einsatzbereit. Erholung außerhalb des Gefechts je nach Nachschub. KI und HQs berücksichtigen Organisation und Nachschub.
- **Baumenü** (`js/production.js`): Nichts entsteht von selbst. Der Spieler bestellt in einer eigenen Stadt einzelne Kompanien oder ganze Divisionen nach Vorlage (`TEMPLATES`), verstärkt ausgewählte Divisionen (Ausbildung in der nächsten Stadt), schaltet „Auffüllen“ ein (die Division bestellt Ersatz selbst) und rüstet Divisionen aus (`UPGRADES`: Ausbildung +20 % Organisation, Artillerie +15 % Kampfkraft je Stufe). Eine Stadt bildet je nach Größe 1–3 Kompanien gleichzeitig aus; bezahlt wird beim Auftrag, ein Abbruch erstattet alles, fällt die Stadt, verfallen ihre Aufträge. Die KI bestellt ebenso über das Baumenü.
- **Städte ausbauen** (`BUILDINGS` in `js/config.js`): Wohnviertel (+Manpower), Fabrik (+Geld, nötig für Panzer), Kaserne (+1 Ausbildungsplatz), Depot (+50 % Nachschubleistung), Festung (Verteidiger −15 % Schaden, Eroberung +50 % Zeit) und Hafen (nur an der Küste, +Geld, Seehandel) – je bis Stufe 3, Preis und Bauzeit steigen mit der Stufe, je Stadt ein Bau zugleich. Eroberte Städte behalten ihre Gebäude. Die KI baut zuerst eine Fabrik, dann je nach Engpass Wohnviertel, Kasernen, Fabriken oder Häfen.
- **Handel** (`js/trade.js`, `TRADE`): Städte schicken regelmäßig Kolonnen über eigenes Gebiet zu anderen eigenen und verbündeten Städten (mit Verbündeten ×1,5 für beide), Häfen schicken Schiffe zu Häfen im selben Meer (Meere als Zusammenhangskomponenten des tiefen Wassers). Bei der Ankunft gibt es Geld nach Weglänge und Stadtgröße bzw. Hafenstufe. Kolonnen gehen verloren, wenn ein Feind ihnen nahe kommt oder ihr Weg zu Feindgebiet wird; Schiffe sind auf See sicher.
- **Bündnisse** (`DIPLOMACY`): Angebote mit Annehmen/Ablehnen, Verbündete kämpfen nicht gegeneinander, nehmen sich kein Land (Feindschaft als Tabelle `game.enmity`), handeln mit Bonus. Bündnisse laufen nach 8 Minuten aus (1 Minute vorher angekündigt, danach 2 Minuten Pause), Bruch (nach einer Warnung) macht 3 Minuten zum internationalen Verräter: −20 % Verteidigung (`traitorDefense`), die KI lehnt Bündnisse ab. Nach jedem Bündnisende 60 s Waffenruhe (`game.truces`, zählt nicht als Feindschaft): Kompanien im Land des anderen bekommen einen Abzugsbefehl ins eigene Land (`game.withdraw`, Vorrang vor Front, KI und HQ), wer hineinmarschiert, wird zurückgeschickt. Die KI verbündet sich gegen eine stärkere dritte Seite, wenn sie selbst nicht führt, und bricht, wenn der Partner 45 % Land erreicht oder nur noch zwei Seiten übrig sind. Gewinnen kann nur eine Seite allein.
- **Wachstum** (`GROWTH`): Eigenes Gebiet wächst langsam in angrenzendes neutrales Land (wie bei OpenFront), nie in feindliches.
- **Wirtschaft** (`ECONOMY` in `js/config.js`): Jede Seite hat Geld und Manpower. Städte liefern nach ihrer Größe (Klein-, Mittel-, Großstadt aus der echten Einwohnerzahl; die eigene Hauptstadt zählt als Großstadt), jedes Prozent Land bringt etwas Geld. Manpower sammelt sich bis zu einem Vorrat. Kompanien kosten beides (Infanterie 30 Geld/150 Manpower, Panzer 100/90). Die Schwierigkeit der KI wirkt auf ihr Einkommen.
- **Gliederung:** Armee (XXXX) → Division (XX) → Regiment (III) → Kompanie (I). Armeen fassen beliebig viele Divisionen zusammen und halten ihre Front als Ganzes; Front und Angriff einer Armee werden nach Stärke auf ihre Divisionen aufgeteilt, eine neue Division bringt ihre Sektoren mit und löst eine Neuaufteilung aus. Alle Kompanien starten ohne Division; Spieler und KI fassen sie nach Bedarf zu Divisionen zusammen (höchstens 12 Kompanien) oder nehmen sie wieder heraus. Die Regimenter (2–3 Kompanien, Infanterie und Panzer getrennt) ordnet das Spiel selbst. Leere Divisionen lösen sich auf und geben Nummer und Farbe frei. Kompanien ohne Division sind die Reserve: frei verfügbar, aber ohne HQ, Front und Rotation. Innerhalb einer Division rotieren Kompanien: Unter 25 % im Gefecht tauscht eine Kompanie den Platz mit einer frischen in der Nähe.
- **Fronten wie in Hearts of Iron** (`js/sectors.js`, `js/fronts.js`): Die Karte wird beim Start einmal in feste Regionen von etwa 30 km zerlegt (`FRONT` in `js/config.js`, im Menü 20/30/45 km; Breitensuche von einem leicht verrückten Gitter aus, Meer und Gebirge trennen). Jede eigene Region an der Grenze ist ein *Frontsektor* und gehört höchstens einem *Auftrag*: einer Armee oder einer einzelnen Division. Bedienung mit „〰 Front“: über die Grenze ziehen malt Sektoren, ins Feindgebiet tippen nimmt die ganze Grenze zu diesem Gegner, eine Linie ohne Sektor darunter wird zur Verteidigungslinie; „⌫ Entziehen“ nimmt Sektoren die Front, „⛨ Ganze Grenze“ (G) nimmt die Grenze zu allen Gegnern. Mehrere ausgewählte Verbände teilen sich Sektoren zusammenhängend nach Lage und Stärke. Runde Trenner zwischen zwei Aufträgen verschieben die Naht. Jeder Auftrag verteilt seine Linie zusammenhängend nach Stärke auf seine Divisionen (je Division eine Front; Rotation, HQs und Angriffe arbeiten je Division). Eine Division mit eigenem Auftrag gehört nicht zum Auftrag ihrer Armee. Rückt die Grenze vor, übernehmen neue Grenzsektoren den Auftrag ihres nächsten Nachbarsektors (bis 3 Regionen weit); bewusst freie Sektoren geben ihre Lücke nicht weiter. Sonst ändert sich nichts von selbst. Haltende Fronten nehmen kein Land ein, Verschiebungen laufen hinter der eigenen Linie (Feindgebiet ist für die Wegsuche sehr teuer). Angriffe wie in HOI4: Division(en) oder Armee mit Front auswählen → „➜ Angriff planen“ → Ziellinie ziehen (NATO-Phasenlinie mit gemeinsamem Decknamen und Hauptangriffsachse nach APP-6; geplant gestrichelt, laufend durchgezogen) → „▶ Angriff starten“. Ein Angriff ist ein Auftrag an die bestehende Front; danach hält die Division die vorgeschobene Grenze. Optional ziehen sich Verwundete zum Heilen zurück (Rotation). Auffanglinie wie in HOI4: eine Linie hinter der Front je Auftrag; „Zurückfallen“ lässt die Divisionen sie statt ihrer Sektoren halten (die Zuteilung bleibt), „Front halten“ schickt sie zurück.
- **Sichtbarkeit der Fronten:** Jede eigene Front erscheint als Band in der Farbe ihrer Armee mit Zacken zum Feind und Strichen an den Sektorgrenzen, dazu ein Abzeichen (Name, Divisionen, Sektoren, Ampel für Kompanien je Sektor). Grenzstücke ohne Front sind rot gestrichelt. Die Abschnitte der Divisionen erscheinen, wenn sie ausgewählt sind. „Fronten“ (V) blendet alles aus. Fronten und Angriffspläne des Gegners bleiben verborgen.
- **Divisions-HQs:** Jede Division hat ein HQ hinter der Linie (keine Kampfeinheit). Es gleicht in der Verteidigung Kräfte aus, indem es ruhige Kompanien an bedrängte Stellen schickt, und riegelt Durchbrüche mit einem freien Regiment ab. Ist der Abschnitt einer Division weitgehend leer, funkt ihr HQ die Nachbarfronten derselben Armee an; der Nachbar mit Reserven übernimmt vorübergehend (bis 3 Kompanien, 30 s). Alle HQ-Befehle gelten nur in der Nähe (bis etwa 20 Felder) und nur auf Wegen hinter der eigenen Linie; gibt es keinen, unterbleibt der Befehl.
- **Oberfläche wie in HOI4:** Oben links Reiter für Produktion (B), Städte (C), Diplomatie (K), Logistik (L) und Truppen (T), die eine feste Seitenleiste öffnen (am Handy von unten); in der Mitte Meldungen (Sektoren ohne Front, Kompanien ohne Nachschub oder ohne Division, antippen springt hin); rechts Lage, Geld, Manpower und die Uhr mit Pause und Tempo. Unten links die Armeeleiste: je Armee eine Karte (Farbe, Divisionen, Sektoren, Ampel der Besetzung), die Reserve (Divisionen ohne Armee, Kompanien ohne Division, Auto-Gliederung) und „＋ Armee“; darüber die Divisionen der offenen Armee (NATO-Symbol, Name, Stärke, Organisation, Nachschub, Regimenter); eine Divisionskarte nach unten auf eine Armee, die Reserve oder „＋ Armee“ ziehen hängt sie um (sie bringt ihre Sektoren mit). Unten rechts Werkzeuge und Kartenmodi. Der Reiter Truppen listet Armeen mit Divisionen, Front und Besetzung, die Reserve und die Lücken an der Grenze; der Reiter Städte alle eigenen Städte mit ihren Gebäuden; der Reiter Logistik die Versorgungslage, Vorrat und Lieferquote je Armee und Division sowie die Versorgungsnetze mit Auslastung und Depot-Ausbau.
- **Befehlsfeld:** Erscheint unten links über der Armeeleiste, sobald etwas ausgewählt ist. Die Schlachtplan-Knöpfe (Front, Ganze Grenze, Angriff, Auffanglinie, Ausführen, Stopp) stehen immer an derselben Stelle und sind ausgegraut, wenn sie nicht passen; Rotation, zurück an die Front, Plan verwerfen und Front auflösen liegen unter „⋯“. Darunter die Gliederung (Halt, Division bzw. Armee bilden oder auflösen, Auffüllen), nur mit passenden Befehlen.
- **KI:** Fasst ihre Divisionen zu einer Armee zusammen; eigene Fronttruppen decken nahe Städte mit, an der Truppenobergrenze stößt die stärkste Front begrenzt vor. Bildet Front-Divisionen (6–10 Kompanien) nach ihrer Lage an der Grenze, gibt ihrer Armee die ganze Grenze und behält eine Reserve ohne Division für Städte. Bei Überlegenheit stoßen die 1–2 Divisionen nächst einer Stadt vor; kippt das Kräfteverhältnis, kehren sie in ihre Abschnitte zurück. Bildet über das Baumenü aus, baut ihre Städte aus (zuerst eine Fabrik, Festungen in bedrohten Städten, Depots bei knappem Nachschub, sonst nach Engpass), rüstet ihre Front-Divisionen auf und schließt bzw. bricht Bündnisse. Die Schwierigkeit wirkt auf ihr Einkommen (80/100/125 %) und ihr Denktempo; auf „Schwer“ sieht sie die ganze Karte.
- **Straßen:** Fern- und Hauptstraßen aus Natural Earth; Straßen über Gebirge sind Pässe, über Flüsse Brücken. Auf Straßen sind Einheiten 60 % schneller.
- **Start und Gebiet:** Wie bei OpenFront wählst du deine Startstadt auf der Karte (oder zufällig); die KI-Gegner verteilen sich möglichst weit entfernt. Jede Seite beginnt mit einer Stadt, dem Land ringsum und 4 Kompanien, alles andere ist neutral. Eroberte Städte bringen das Land ringsum (außer was näher an feindlichen Truppen liegt), marschierende Einheiten nehmen Land ein, haltende Grenzfronten nicht. Auch danach halten Städte das Land ringsum, aber nur bis auf halbem Weg zu feindlichen Truppen: Land hinter Truppen vor einer feindlichen Stadt fällt nicht an die Stadt. Grenzabschnitte werden über ihren Winkel um die eigene Startstadt abgegrenzt, so tragen sie auch Grenzen zu mehreren Gegnern ringsum.
- **Nebel des Krieges:** Gegner sind nur in Sichtweite sichtbar.

## Steuerung

| Aktion | PC | Handy |
| --- | --- | --- |
| Auswählen | Einheit anklicken (erneut: Gruppe → Division → Kompanie) / Rahmen mit links aufziehen (Umschalt = hinzufügen) | Einheit antippen (erneut: ebenso) / „▢ Auswahl“ + Rahmen |
| Division / Armee auswählen | Karte in der Armeeleiste unten oder im Reiter Truppen | ebenso |
| Bewegen | Rechtsklick auf das Ziel (dicht aufstellen), Umschalt+Rechtsklick behält die Abstände | Mit Auswahl auf das Ziel tippen |
| Abwählen | Klick ins Leere / Esc | „✕“ im Befehlsfeld |
| Anhalten | S | „■ Halt“ |
| Neue Division / aus Division | D / Umschalt+D | „＋ Neue Division“ / „− Aus Division“ |
| Neue Armee | Divisionen wählen, „＋ Neue Armee“ | ebenso |
| Karte verschieben | Rechte oder mittlere Maustaste ziehen | Ein Finger ziehen |
| Zoomen | Mausrad | Zwei Finger |
| Front malen | Armee oder Division(en) wählen, „〰 Front“ (F), dann über die Grenze ziehen bzw. ins Feindgebiet klicken | ebenso, mit dem Finger |
| Ganze Grenze | Armee oder Division(en) wählen, „⛨ Ganze Grenze“ (G) | ebenso |
| Naht zwischen Armeen verschieben | Runden Trenner auf der Front ziehen | ebenso |
| Fronten aus-/einblenden | „Fronten“ (V) | ebenso |
| Nachschub zeigen | „Nachschub“ (N) | ebenso |
| Produktion / Städte / Diplomatie / Truppen | Reiter oben links (B / C / K / T); eigene Stadt anklicken (ohne Auswahl) öffnet Städte | ebenso |

Tasten: Leertaste Pause · A alle auswählen · S anhalten · D/Umschalt+D Division · F Front · G ganze Grenze (beide nur mit ausgewählten Divisionen oder Armeen) · V Fronten · N Nachschub · B Produktion · C Städte · K Diplomatie · L Logistik · T Truppen · Esc schrittweise zurück · 1/2/3 Tempo.

## Aufbau

```
index.html          Oberfläche (Menü, obere Leiste mit Reitern, Seitenleiste, Armeeleiste, Hilfe)
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
js/trade.js         Handel: Kolonnen über Land, Schiffe zwischen Häfen
js/supply.js        Nachschub: Depots, LKW-Netz über eigenes Gebiet, Vorräte, Verteilung
js/sectors.js       Frontsektoren: feste Regionen von etwa 30 km
js/fronts.js        Fronten: Aufträge je Armee/Division auf Sektoren, Divisionsfronten, Angriffe
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

Vor dem Veröffentlichen `npm test` ausführen (Node 18 oder neuer): Die KI spielt auf beiden Karten mit 2, 3 und 5 Seiten gegen sich selbst, geprüft werden Abstürze, das Spielende, die Gliederung (Höchststärken, Regimenter), die Fronten (eine je Division, jede in einem bestehenden Auftrag, keine überlappenden Teile), die Frontsektoren (Aufteilen, Trenner, eigene Division, Erben), Nachschub und Organisation (Wertebereiche, Zerschlagene ziehen sich zurück). Der Test prüft zwischen KI und Spielschritt und verändert den Spielverlauf nicht: dieselbe Karte ergibt im Test und im Spiel denselben Ablauf.

Nach Änderungen am Code `./scripts/bump-version.sh` ausführen. Das erhöht die Versionsnummer an allen Skript-Verweisen, damit Browser (vor allem auf dem Handy) nicht die alten Dateien aus dem Cache laden.
