"""
Draaimolen — timetable-webapp met pushherinneringen.

Volledig losstaand van de CIRQO/Bouwkringloop-functionaliteit: eigen tabellen
(prefix draaimolen_), eigen router, eigen service worker. Valt niets om als de
database wegvalt — dan draait de app op het meegeleverde JSON-bestand.
"""
import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, HTTPException, Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

import database as db
import push as push_module

TZ = ZoneInfo("Europe/Amsterdam")
MAP = "static/draaimolen"

# Zonder deze code kan niemand de timetable op de server overschrijven; de
# import in de app werkt dan alleen lokaal op het toestel zelf.
IMPORT_CODE = os.getenv("DRAAIMOLEN_CODE", "")

router = APIRouter(prefix="/draaimolen")

_tabellen_klaar = False


def _zorg_tabellen():
    global _tabellen_klaar
    if _tabellen_klaar:
        return
    with db.get_cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS draaimolen_timetable (
                id         INTEGER PRIMARY KEY,
                data       TEXT NOT NULL,
                bijgewerkt TIMESTAMPTZ DEFAULT NOW()
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS draaimolen_abonnees (
                id           SERIAL PRIMARY KEY,
                subscription TEXT UNIQUE NOT NULL,
                artiesten    TEXT NOT NULL DEFAULT '[]',
                lead_min     INTEGER NOT NULL DEFAULT 15,
                bijgewerkt   TIMESTAMPTZ DEFAULT NOW()
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS draaimolen_verzonden (
                abonnee_id INTEGER REFERENCES draaimolen_abonnees(id) ON DELETE CASCADE,
                set_id     TEXT NOT NULL,
                moment     TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (abonnee_id, set_id)
            )""")
    _tabellen_klaar = True


# ── Timetable ─────────────────────────────────────────────────────────────────

def _bestand() -> dict:
    with open(f"{MAP}/timetable.json", "r", encoding="utf-8") as f:
        return json.load(f)


_cache: dict = {"data": None, "tot": 0.0}


def laad_timetable() -> dict:
    """Serverversie (ingelezen via de app) gaat voor op het meegeleverde bestand.
    Kort gecachet: de herinneringenlus vraagt hem elke halve minuut op."""
    import time as _t
    if _cache["data"] is not None and _t.time() < _cache["tot"]:
        return _cache["data"]
    try:
        _zorg_tabellen()
        with db.get_cursor() as cur:
            cur.execute("SELECT data FROM draaimolen_timetable WHERE id = 1")
            rij = cur.fetchone()
        if rij:
            data = json.loads(rij["data"])
            data["herkomst"] = "server"
            _cache.update(data=data, tot=_t.time() + 60)
            return data
    except Exception as e:
        print(f"[draaimolen] timetable uit db mislukt: {e}")
    data = _bestand()
    data["herkomst"] = "bestand"
    _cache.update(data=data, tot=_t.time() + 60)
    return data


def sleutel(naam: str) -> str:
    """Artiestnaam → vergelijkbare sleutel. Favorieten hangen aan de naam en niet
    aan een set-id, zodat ze een nieuwe timetable overleven."""
    return re.sub(r"[^a-z0-9]", "", (naam or "").lower())


def set_id(s: dict) -> str:
    ruw = f"{s.get('dag')}|{s.get('stage')}|{s.get('start')}|{s.get('artiest')}"
    return hashlib.sha1(ruw.encode("utf-8")).hexdigest()[:16]


def _dagdatum(data: dict, dag_id) -> str:
    for d in data.get("dagen", []):
        if d.get("id") == dag_id:
            return d.get("datum", "")
    return ""


def set_moment(data: dict, s: dict):
    """Werkelijk aanvangsmoment. Sets na middernacht horen bij de vorige dag,
    dus alles vóór 06:00 schuift een etmaal op."""
    datum = _dagdatum(data, s.get("dag"))
    start = s.get("start")
    if not datum or not start:
        return None
    try:
        jaar, maand, dag = (int(x) for x in datum.split("-"))
        uur, minuut = (int(x) for x in str(start).split(":")[:2])
    except ValueError:
        return None
    moment = datetime(jaar, maand, dag, uur, minuut, tzinfo=TZ)
    if uur < 6:
        moment += timedelta(days=1)
    return moment


# ── Routes ────────────────────────────────────────────────────────────────────

def _bestandsrespons(naam: str, media: str, cache: str) -> FileResponse:
    pad = f"{MAP}/{naam}"
    if not os.path.isfile(pad):
        raise HTTPException(status_code=404)
    return FileResponse(pad, media_type=media, headers={"Cache-Control": cache})


@router.get("")
def pagina_slash():
    """Canoniek adres is /draaimolen/ — daar reikt het bereik van de service
    worker tot, en dat is wat de app op het beginscherm installeert."""
    return RedirectResponse("/draaimolen/", status_code=308)


@router.get("/", response_class=HTMLResponse)
def pagina():
    with open(f"{MAP}/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read(), headers={"Cache-Control": "no-store"})


@router.get("/sw.js")
def service_worker():
    """Bewust op /draaimolen/sw.js: dat bepaalt het bereik van de worker."""
    with open(f"{MAP}/sw.js", "r", encoding="utf-8") as f:
        return Response(content=f.read(), media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/manifest.json")
def manifest():
    return _bestandsrespons("manifest.json", "application/manifest+json", "no-cache")


@router.get("/api/timetable")
def api_timetable():
    return laad_timetable()


@router.post("/api/timetable")
def api_timetable_publiceren(body: dict = Body(...)):
    """Zet een ingelezen timetable op de server, zodat alle toestellen hem zien
    én de pushherinneringen de juiste tijden gebruiken."""
    if not IMPORT_CODE:
        raise HTTPException(status_code=403, detail="Publiceren staat uit (DRAAIMOLEN_CODE ontbreekt)")
    if (body.get("code") or "") != IMPORT_CODE:
        raise HTTPException(status_code=403, detail="Onjuiste code")
    data = body.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("sets"), list):
        raise HTTPException(status_code=400, detail="Ongeldige timetable")
    if len(data["sets"]) > 2000:
        raise HTTPException(status_code=400, detail="Te veel sets")
    data.pop("herkomst", None)
    data["bijgewerkt"] = datetime.now(TZ).strftime("%Y-%m-%d %H:%M")
    _zorg_tabellen()
    with db.get_cursor() as cur:
        cur.execute("""
            INSERT INTO draaimolen_timetable (id, data, bijgewerkt) VALUES (1, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, bijgewerkt = NOW()
        """, (json.dumps(data, ensure_ascii=False),))
        # Nieuwe tijden: eerder verstuurde herinneringen mogen opnieuw
        cur.execute("DELETE FROM draaimolen_verzonden")
    _cache.update(data=None, tot=0.0)
    return {"ok": True, "sets": len(data["sets"])}


@router.get("/api/vapid")
def api_vapid():
    return {"public_key": push_module.get_public_key()}


@router.post("/api/abonnement")
def api_abonnement(body: dict = Body(...)):
    """Slaat de pushinschrijving op mét de gekozen artiesten en voorlooptijd."""
    sub = body.get("subscription")
    if not isinstance(sub, dict) or not sub.get("endpoint"):
        raise HTTPException(status_code=400, detail="Geen geldige subscription")
    artiesten = [str(a)[:120] for a in (body.get("artiesten") or [])][:400]
    lead = int(body.get("lead_min") or 15)
    lead = min(max(lead, 0), 120)
    _zorg_tabellen()
    with db.get_cursor() as cur:
        cur.execute("""
            INSERT INTO draaimolen_abonnees (subscription, artiesten, lead_min, bijgewerkt)
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (subscription) DO UPDATE
               SET artiesten = EXCLUDED.artiesten,
                   lead_min  = EXCLUDED.lead_min,
                   bijgewerkt = NOW()
        """, (json.dumps(sub), json.dumps(artiesten, ensure_ascii=False), lead))
    return {"ok": True, "artiesten": len(artiesten), "lead_min": lead}


@router.post("/api/afmelden")
def api_afmelden(body: dict = Body(...)):
    sub = body.get("subscription")
    if not isinstance(sub, dict):
        raise HTTPException(status_code=400, detail="Geen geldige subscription")
    _zorg_tabellen()
    with db.get_cursor() as cur:
        cur.execute("DELETE FROM draaimolen_abonnees WHERE subscription = %s", (json.dumps(sub),))
    return {"ok": True}


@router.post("/api/test")
def api_test(body: dict = Body(...)):
    sub = body.get("subscription")
    if not isinstance(sub, dict) or not sub.get("endpoint"):
        raise HTTPException(status_code=400, detail="Geen geldige subscription")
    ok = push_module.send_push(json.dumps(sub), "Draaimolen", "Zo ziet een setherinnering eruit.",
                               url="/draaimolen/")
    return {"ok": bool(ok)}


# ── Herinneringen ─────────────────────────────────────────────────────────────

def _festivalvenster(nu: datetime) -> bool:
    """Alleen rond het festival elke halve minuut kijken; daarbuiten is dat
    nutteloos databaseverkeer."""
    data = laad_timetable()
    datums = [d.get("datum") for d in data.get("dagen", []) if d.get("datum")]
    if not datums:
        return False
    try:
        eerste = datetime.strptime(min(datums), "%Y-%m-%d").replace(tzinfo=TZ) - timedelta(days=1)
        laatste = datetime.strptime(max(datums), "%Y-%m-%d").replace(tzinfo=TZ) + timedelta(days=2)
    except ValueError:
        return False
    return eerste <= nu <= laatste


def _verstuur_herinneringen():
    nu = datetime.now(TZ)
    data = laad_timetable()
    sets = [s for s in data.get("sets", []) if s.get("start") and s.get("dag")]
    if not sets:
        return
    with db.get_cursor() as cur:
        cur.execute("SELECT id, subscription, artiesten, lead_min FROM draaimolen_abonnees")
        abonnees = cur.fetchall()
    if not abonnees:
        return

    # Sets die binnen het komende uur beginnen: alleen die kunnen aan de beurt zijn
    komend = []
    for s in sets:
        moment = set_moment(data, s)
        if moment and timedelta(minutes=-10) <= (moment - nu) <= timedelta(minutes=125):
            komend.append((s, moment))
    if not komend:
        return

    for ab in abonnees:
        try:
            favorieten = {sleutel(a) for a in json.loads(ab["artiesten"] or "[]")}
        except Exception:
            favorieten = set()
        if not favorieten:
            continue
        lead = timedelta(minutes=int(ab["lead_min"] or 0))
        for s, moment in komend:
            if sleutel(s.get("artiest")) not in favorieten:
                continue
            trigger = moment - lead
            # Venster van twee minuten terug: de lus draait elke 30s, dus dit
            # vangt hem altijd, en de verzonden-tabel voorkomt dubbelingen.
            if not (timedelta(0) <= (nu - trigger) <= timedelta(minutes=2)):
                continue
            sid = set_id(s)
            with db.get_cursor() as cur:
                cur.execute("""
                    INSERT INTO draaimolen_verzonden (abonnee_id, set_id) VALUES (%s, %s)
                    ON CONFLICT DO NOTHING RETURNING set_id
                """, (ab["id"], sid))
                nieuw = cur.fetchone()
            if not nieuw:
                continue
            minuten = max(round((moment - nu).total_seconds() / 60), 0)
            wanneer = "begint nu" if minuten <= 0 else f"begint over {minuten} min"
            stage = s.get("stage") or "onbekende stage"
            body = f"{s.get('start')} · {stage} — {wanneer}"
            ok = push_module.send_push(ab["subscription"], s.get("artiest", "Draaimolen"),
                                       body, url="/draaimolen/")
            print(f"[draaimolen] herinnering {s.get('artiest')} → abonnee {ab['id']}: "
                  f"{'ok' if ok else 'mislukt'}")
            if not ok:
                with db.get_cursor() as cur:
                    cur.execute("DELETE FROM draaimolen_abonnees WHERE id = %s", (ab["id"],))


async def herinneringen_loop():
    """Kijkt elke halve minuut of er een favoriete set bijna begint."""
    await asyncio.sleep(25)
    while True:
        rustig = True
        try:
            nu = datetime.now(TZ)
            rustig = not _festivalvenster(nu)
            if not rustig:
                await asyncio.get_event_loop().run_in_executor(None, _verstuur_herinneringen)
        except Exception as e:
            print(f"[draaimolen] herinneringenlus: {e}")
        await asyncio.sleep(900 if rustig else 30)
