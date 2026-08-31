# Draaimolen 26 — timetable-webapp

Losstaande webapp binnen deze backend, op **`/draaimolen/`**. Raakt niets van
CIRQO/Bouwkringloop aan: eigen router (`draaimolen.py`), eigen service worker,
eigen tabellen (`draaimolen_timetable`, `draaimolen_abonnees`,
`draaimolen_verzonden`).

## Wat het doet

* Timetable per dag en per stage, met "nu bezig", een nu-streep en verleden
  sets uitgegrijsd.
* Tik een artiest aan → hij staat in **Mijn line-up**, met botsingswaarschuwing
  en agenda-export (.ics).
* **Meldingen**: web push vanaf de server (5–45 minuten van tevoren), plus een
  reservelijn die het toestel zelf plant zolang de app open staat.
* Werkt offline: service worker cachet pagina, stijl, script en de laatst
  opgehaalde timetable — het MOB-complex heeft nauwelijks bereik.

## Timetable bijwerken

De line-up in `timetable.json` staat er zonder tijden in; de officiële
set-tijden komen erbij via **Meldingen → Timetable inlezen**: plak de tekst van
draaimolen.nu, controleer het resultaat en kies

* *Gebruik op dit toestel* — alleen lokaal (localStorage), of
* *Ook op de server zetten* — vraagt om de code uit de omgevingsvariabele
  `DRAAIMOLEN_CODE`. Dan zien alle toestellen dezelfde tijden **en** gebruiken
  de pushherinneringen ze.

De parser snapt regels als `12:00 - 14:30 Artiest`, losse tijdregels met de
naam eronder, dagkoppen (`VRIJDAG`, `ZATERDAG`) en stagekoppen (een regel
zonder tijd). Een JSON in dezelfde opbouw plakken mag ook.

## Omgevingsvariabelen

| Variabele | Waarvoor |
|---|---|
| `DRAAIMOLEN_CODE` | Nodig om een timetable naar de server te publiceren. Leeg = publiceren staat uit. |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` | Al aanwezig voor CIRQO; dezelfde sleutels sturen ook deze meldingen. |

## Herinneringen

`herinneringen_loop()` draait mee in de lifespan van `main.py`: elke 30 seconden
rond het festival, daarbuiten elk kwartier een korte controle. Per abonnee en
per set wordt één melding gestuurd (`draaimolen_verzonden` voorkomt dubbelen).
Favorieten hangen aan de artiestnaam, niet aan een set-id — een nieuwe
timetable inlezen kost je dus je selectie niet.
