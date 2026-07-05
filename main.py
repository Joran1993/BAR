"""
De Bouwkringloop — cloud backend
Rollen: superadmin (platform), admin (gemeente), user (scanner)
"""
import asyncio
import base64
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

import database as db
import ai as ai_module
import auth as auth_module
import storage as storage_module
import cache as cache_module
import push as push_module
import firestore as fs

# Foutbewaking: wordt actief zodra SENTRY_DSN als env-var is gezet; zonder DSN
# is dit een no-op en kost het niets
if os.getenv("SENTRY_DSN"):
    import sentry_sdk
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.getenv("RAILWAY_ENVIRONMENT_NAME", "development"),
        traces_sample_rate=0.0,       # geen performance-tracing: nul overhead
        send_default_pii=False,       # geen persoonsgegevens meesturen (AVG)
    )

security = HTTPBearer(auto_error=False)


# ── Auth helpers ──────────────────────────────────────────────────────────────

_USER_VERS_CACHE: dict = {}   # user_id → (timestamp, db-row) — max 60s oud


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if not credentials:
        raise HTTPException(status_code=401, detail="Niet ingelogd")
    payload = auth_module.decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=401, detail="Sessie verlopen")
    uid = int(payload["sub"])
    # Rol/gemeente/bedrijf vers uit de DB (60s cache): accountwijzigingen werken
    # direct door — niemand hoeft opnieuw in te loggen na een scope-aanpassing
    import time as _t
    nu = _t.time()
    hit = _USER_VERS_CACHE.get(uid)
    if not hit or nu - hit[0] > 60:
        try:
            hit = (nu, db.get_user_by_id(uid), False)   # (tijd, rij, db_fout)
        except Exception:
            hit = (nu, None, True)   # DB even niet bereikbaar → tijdelijke terugval op token
        _USER_VERS_CACHE[uid] = hit
        if len(_USER_VERS_CACHE) > 5000:
            _USER_VERS_CACHE.clear()
    row = hit[1]
    if row:
        return {
            "id": uid,
            "username": row.get("username") or payload.get("username", ""),
            "role": row.get("role") or payload.get("role", "user"),
            "gemeente": row.get("gemeente") or "",
            "bedrijf_id": row.get("bedrijf_id") if row.get("bedrijf_id") is not None else payload.get("bedrijf_id"),
        }
    # Gebruiker niet in de DB: alleen doorlaten als de DB even onbereikbaar was
    # (dan gaven we hierboven None-op-exception). Een écht verwijderde gebruiker
    # (DB bereikbaar, geen rij) mag NIET terugvallen op de token-rol.
    if hit[2] if len(hit) > 2 else False:
        # db-fout → tijdelijke terugval op token zodat de app niet plat gaat
        return {
            "id": uid,
            "username": payload.get("username", ""),
            "role": payload.get("role", "user"),
            "gemeente": payload.get("gemeente", "") or "",
            "bedrijf_id": payload.get("bedrijf_id"),
        }
    raise HTTPException(status_code=401, detail="Account bestaat niet meer")


def get_optional_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Als get_current_user, maar geeft None terug i.p.v. 401 zonder (geldige) token."""
    if not credentials:
        return None
    payload = auth_module.decode_token(credentials.credentials)
    if not payload:
        return None
    return {
        "id": int(payload["sub"]),
        "username": payload.get("username", ""),
        "role": payload.get("role", "user"),
        "gemeente": payload.get("gemeente", "") or "",
        "bedrijf_id": payload.get("bedrijf_id"),
    }


def require_superadmin(user=Depends(get_current_user)):
    if user["role"] != "superadmin":
        raise HTTPException(status_code=403, detail="Alleen platform-beheerders hebben toegang")
    return user


def require_admin(user=Depends(get_current_user)):
    """superadmin én gemeente-admin mogen door."""
    if user["role"] not in ("superadmin", "admin"):
        raise HTTPException(status_code=403, detail="Geen beheerdersrechten")
    return user


def _mag_item_beheren(user: dict, item: dict) -> bool:
    """Mag deze gebruiker dit item lezen/wijzigen/verwijderen?
    superadmin: alles; admin: items binnen eigen gemeente-scope; user/bedrijf: eigen items."""
    if user["role"] == "superadmin":
        return True
    if user["role"] == "admin":
        gem = item.get("gemeente")
        if not gem:
            return False
        scope = _gemeenten_expand(user.get("gemeente")) or ([user.get("gemeente")] if user.get("gemeente") else [])
        return gem in scope
    up = item.get("uploaded_by")
    return up is not None and up == user["id"]


def _scope_gemeenten(user: dict, item: Optional[dict] = None) -> list:
    """Gemeenten waarbinnen deze gebruiker mag handelen (incl. organisatie en item-gemeente)."""
    g = user.get("gemeente")
    scope = set(_gemeenten_expand(g) or ([g] if g else []))
    org = (user.get("organisatie") or "").strip().lower()
    if org in ORGANISATIE_GEMEENTEN:
        scope |= set(ORGANISATIE_GEMEENTEN[org])
    if item and item.get("gemeente"):
        scope.add(item["gemeente"])
    return list(scope)


def _bedrijf_werkt_in(bedrijf_id: int, gemeenten: list) -> bool:
    """Werkt dit bedrijf (hoofdgemeente of extra werkgebied) in een van deze gemeenten?"""
    if not gemeenten:
        return False
    with db.get_cursor() as cur:
        cur.execute(
            """SELECT 1 FROM bedrijven b
               WHERE b.id = %s AND (b.gemeente = ANY(%s)
                  OR EXISTS (SELECT 1 FROM bedrijf_gemeenten bg
                             WHERE bg.bedrijf_id = b.id AND bg.gemeente = ANY(%s)))""",
            (bedrijf_id, gemeenten, gemeenten),
        )
        return cur.fetchone() is not None


RWM_GEMEENTEN = [
    "Roermond", "Leudal", "Maasgouw", "Echt-Susteren",
    "Roerdalen", "Weert", "Beesel", "Bergen",
]
RWM_MILIEUSTRATEN = {
    "Roermond":      ["Milieustraat Roermond"],
    "Leudal":        ["Milieustraat Heythuysen"],
    "Maasgouw":      ["Milieustraat Maasbracht"],
    "Echt-Susteren": ["Milieustraat Echt"],
    "Roerdalen":     ["Milieustraat St. Odiliënberg"],
    "Weert":         ["Milieustraat Weert"],
    "Beesel":        ["Milieustraat Reuver"],
    "Bergen":        ["Milieustraat Well"],
}
WAARDLANDEN_GEMEENTEN = [
    "Alblasserdam", "Gorinchem", "Hardinxveld-Giessendam",
    "Hendrik-Ido-Ambacht", "Molenlanden", "Papendrecht",
    "Sliedrecht", "Vijfheerenlanden", "Zwijndrecht",
]
BRAND_GEMEENTEN = {"rwm": RWM_GEMEENTEN}
ORGANISATIE_GEMEENTEN = {
    "waardlanden": WAARDLANDEN_GEMEENTEN,
    "rwm":         RWM_GEMEENTEN,
}
# Milieustraten per organisatie: naam → gemeente waar de locatie staat
# (items krijgen bij het scannen de gemeente van de milieustraat via GPS/account)
ORGANISATIE_MILIEUSTRATEN = {
    "waardlanden": [
        {"naam": "Milieustraat Gorinchem",              "gemeente": "Gorinchem"},
        {"naam": "Milieustraat Hardinxveld-Giessendam", "gemeente": "Hardinxveld-Giessendam"},
        {"naam": "Milieustraat Leerdam",                "gemeente": "Vijfheerenlanden"},
        {"naam": "Ecopark Groot-Ammers",                "gemeente": "Molenlanden"},
    ],
}


def _gemeente_filter(user: dict, gemeente: Optional[str] = None) -> Optional[str]:
    """
    superadmin:  mag alles zien (None = geen filter)
    admin:       mag alleen een gemeente kiezen BINNEN de eigen (organisatie)scope;
                 daarbuiten of zonder keuze → eigen scope
    user:        altijd eigen gemeente
    """
    if user["role"] == "superadmin":
        return gemeente or None
    if user["role"] == "admin":
        eigen = user.get("gemeente") or None
        if gemeente and eigen:
            scope = _gemeenten_expand(eigen) or [eigen]
            if gemeente == eigen or gemeente in scope:
                return gemeente
            return eigen        # buiten scope aangevraagd → terug naar eigen scope
        return gemeente or eigen
    return user.get("gemeente") or None


def _gemeenten_expand(gemeente: Optional[str]) -> Optional[list]:
    if gemeente and gemeente in ORGANISATIE_GEMEENTEN:
        return ORGANISATIE_GEMEENTEN[gemeente]
    gemeenten = BRAND_GEMEENTEN.get(DEFAULT_BRAND)
    if not gemeenten:
        return None
    if gemeente is None or gemeente in gemeenten:
        return gemeenten
    return None


def _invalideer_bedrijf_items(bedrijf_id) -> None:
    """Leeg de gecachete /api/items én het dashboard van dit bedrijf."""
    if bedrijf_id:
        cache_module.delete_pattern(f"items:bedrijf2:{bedrijf_id}:*")
        cache_module.delete(f"dashboard-bedrijf:{bedrijf_id}")


def _invalideer_item_caches(item_id: int, item: Optional[dict] = None) -> None:
    """Leeg de items-caches van iedereen die dit item in zijn lijst kan hebben:
    de uploader én alle bedrijven waaraan het is aangeboden. Nodig omdat de
    items-cache lang leeft en puur op gerichte invalidatie leunt."""
    try:
        if item is None:
            item = db.get_item(item_id)
        if item and item.get("uploaded_by"):
            cache_module.delete_pattern(f"items:*:0:{item['uploaded_by']}")
        with db.get_cursor() as cur:
            cur.execute("SELECT DISTINCT bedrijf_id FROM aanbiedingen WHERE item_id = %s", (item_id,))
            for row in cur.fetchall():
                _invalideer_bedrijf_items(row["bedrijf_id"])
    except Exception as e:
        print(f"[cache] item-invalidatie {item_id} mislukt: {e}")


# ── Startup ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    _migrate_admin_to_superadmin()
    try:
        fs.init_firebase()
    except Exception as e:
        print(f"[main] Firebase init mislukt (niet fataal): {e}")
    print(f"[main] gestart — DEFAULT_BRAND={DEFAULT_BRAND!r}, BRAND_ENV={os.getenv('BRAND')!r}")
    asyncio.create_task(_firestore_sync_loop())
    asyncio.create_task(_prewarm_cache_loop())
    asyncio.create_task(_digest_loop())
    yield


def _migrate_admin_to_superadmin():
    """Zet oude 'admin' accounts die geen gemeente hebben om naar superadmin."""
    try:
        with db.get_cursor() as cur:
            cur.execute("""
                UPDATE users SET role = 'superadmin'
                WHERE role = 'admin' AND (gemeente IS NULL OR gemeente = '')
            """)
    except Exception as e:
        print(f"[migrate] {e}")


# Ringtweelijst e-mail → bedrijf_id
_RINGTWO_EMAIL_BEDRIJF = {
    "info@kringloopgorinchem.nl":    20,   # Kringloop Gorinchem
    "kantoor@kringloopgorinchem.nl": 20,   # Kringloop Gorinchem (tweede adres)
    "daan@opwaarts.nu":              38,   # Opwaarts (Almere)
    "martin@behoudenvaart.net":      23,   # SitY academie
    "info@sityacademy.nl":           23,   # SitY academie (Firebase-account)
}

# Gemeente → standaard afnemer als er geen Ringtweelijst is
_GEMEENTE_BEDRIJF = {
    "hardinxveld-giessendam": 21,  # De Gezel
    "hardinxveld": 21,
}


def _backup_firestore_docs(docs: list):
    """Sla alle Firestore Marketplaceoffers op als raw JSON backup — ongeacht of we de gebruiker kennen."""
    import json as _json
    try:
        with db.get_cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS firestore_backup (
                    doc_id      TEXT PRIMARY KEY,
                    collection  TEXT NOT NULL DEFAULT 'Marketplaceoffers',
                    data        JSONB NOT NULL,
                    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            for doc in docs:
                raw = {}
                for k, v in doc.to_dict().items():
                    if hasattr(v, "timestamp"):
                        raw[k] = v.isoformat() if hasattr(v, "isoformat") else str(v)
                    elif hasattr(v, "_seconds"):
                        from datetime import datetime, timezone
                        raw[k] = datetime.fromtimestamp(v.timestamp(), tz=timezone.utc).isoformat()
                    else:
                        raw[k] = v
                cur.execute("""
                    INSERT INTO firestore_backup (doc_id, data)
                    VALUES (%s, %s)
                    ON CONFLICT (doc_id) DO UPDATE
                        SET data = EXCLUDED.data, last_seen = NOW()
                """, (doc.id, _json.dumps(raw, default=str)))
    except Exception as e:
        print(f"[firestore-backup] Fout: {e}")


def _verklein_foto(data: bytes, max_px: int = 1568) -> bytes:
    """Schaal een foto terug tot max_px aan de langste zijde (JPEG).
    Faalt de verwerking, dan komt het origineel terug (best-effort)."""
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        if max(img.size) <= max_px:
            return data
        img.thumbnail((max_px, max_px))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=82)
        return buf.getvalue()
    except Exception:
        return data


def _estimate_weight_background(item_id: int, photo_url: str):
    """Download foto en schat gewicht via AI — draait in achtergrond-thread."""
    def _run():
        try:
            import base64
            import httpx
            r = httpx.get(photo_url, timeout=20, follow_redirects=True)
            r.raise_for_status()
            # Foto's uit de app-kant kunnen >8000px zijn — de AI-API weigert die.
            # Verklein naar max 1568px (optimale grootte voor beeldanalyse).
            foto_bytes = _verklein_foto(r.content)
            img_b64 = base64.b64encode(foto_bytes).decode()
            _, _, gewicht_kg, _, _ = ai_module.analyse_photo(img_b64)
            if gewicht_kg is not None:
                with db.get_cursor() as cur:
                    cur.execute("UPDATE items SET gewicht_kg = %s WHERE id = %s AND gewicht_kg IS NULL",
                                (gewicht_kg, item_id))
                print(f"[gewicht] Item {item_id}: {gewicht_kg} kg")
            else:
                print(f"[gewicht] Item {item_id}: AI gaf geen gewicht terug")
        except Exception as e:
            print(f"[gewicht] Item {item_id} fout: {e}")
    import threading
    threading.Thread(target=_run, daemon=True).start()


def _fix_ringtwo_aanbieding(doc):
    """Corrigeer aanbieding van een al-geïmporteerd item als Ringtweelijst afwijkt."""
    try:
        d = doc.to_dict()
        ringtwo = d.get("Ringtweelijst") or []
        if isinstance(ringtwo, str):
            ringtwo = [ringtwo]
        bedrijf_ids = [_RINGTWO_EMAIL_BEDRIJF[e] for e in ringtwo if e in _RINGTWO_EMAIL_BEDRIJF]
        if not bedrijf_ids:
            return  # geen Ringtweelijst-match, geen actie
        with db.get_cursor() as cur:
            cur.execute("SELECT id FROM items WHERE firestore_doc_id = %s", (doc.id,))
            row = cur.fetchone()
            if not row:
                return
            item_id = row["id"]
            cur.execute("SELECT bedrijf_id FROM aanbiedingen WHERE item_id = %s", (item_id,))
            huidige = {r["bedrijf_id"] for r in cur.fetchall()}
            for bedrijf_id in bedrijf_ids:
                if bedrijf_id not in huidige:
                    cur.execute("""
                        INSERT INTO aanbiedingen (item_id, bedrijf_id, aangeboden_door, status, created_at)
                        VALUES (%s, %s, (SELECT uploaded_by FROM items WHERE id=%s), 'beschikbaar', NOW())
                        ON CONFLICT DO NOTHING
                    """, (item_id, bedrijf_id, item_id))
                    print(f"[ringtwo-fix] Item {item_id} → bedrijf {bedrijf_id}")
            # Verwijder foute gemeente-fallback als Ringtweelijst wél gevuld is
            wrong = huidige - set(bedrijf_ids)
            for w in wrong:
                cur.execute(
                    "DELETE FROM aanbiedingen WHERE item_id=%s AND bedrijf_id=%s AND status='beschikbaar'",
                    (item_id, w)
                )
    except Exception as e:
        print(f"[ringtwo-fix] {e}")


def _sync_firestore_items_now() -> int:
    """Importeer nieuwe Marketplaceoffers uit Firestore. Geeft aantal geïmporteerde items terug."""
    try:
        fsdb = fs._get_db()
        if not fsdb:
            return 0

        # Bestaande firestore_doc_ids ophalen
        with db.get_cursor() as cur:
            cur.execute("SELECT firestore_doc_id FROM items WHERE firestore_doc_id IS NOT NULL")
            existing = {r["firestore_doc_id"] for r in cur.fetchall()}

        docs = fsdb.collection("Marketplaceoffers").get()
        imported = 0

        # Backup alle docs ongeacht of ze al geïmporteerd zijn
        _backup_firestore_docs(docs)

        for doc in docs:
            if doc.id in existing:
                # Controleer of aanbieding klopt met Ringtweelijst — herstel indien nodig
                _fix_ringtwo_aanbieding(doc)
                continue
            d = doc.to_dict()

            # Datum bepalen
            ts = d.get("Datumaangemaakt")
            if not ts or not hasattr(ts, "timestamp"):
                continue
            from datetime import datetime, timezone
            dt = datetime.fromtimestamp(ts.timestamp(), tz=timezone.utc)

            foto = d.get("Foto") or ""
            foto_urls = [u for u in [d.get("Foto"), d.get("foto2"), d.get("foto3"), d.get("foto4")] if u]
            omschrijving = d.get("Omschrijving") or ""
            categorie = d.get("Categorie") or ""
            gemeente = d.get("Gemeente") or ""
            firebase_uid = d.get("uid") or ""
            email = d.get("user") or d.get("Productaanbieder") or ""

            # Gebruiker opzoeken
            supabase_user = None
            if firebase_uid:
                supabase_user = db.get_user_by_firebase_uid(firebase_uid)
            if not supabase_user and email:
                supabase_user = db.get_user_by_email(email)
            if not supabase_user:
                continue  # onbekende gebruiker — sla over

            user_id = supabase_user["id"]

            # Item aanmaken
            import json as _json
            with db.get_cursor() as cur:
                cur.execute("""
                    INSERT INTO items (timestamp, photo_url, photo_urls, ai_label, ai_detail, category,
                                       gemeente, geaccepteerd, uploaded_by, firestore_doc_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, true, %s, %s)
                    ON CONFLICT DO NOTHING
                    RETURNING id
                """, (dt, foto, _json.dumps(foto_urls) if len(foto_urls) > 1 else None,
                      omschrijving, omschrijving, categorie, gemeente, user_id, doc.id))
                row = cur.fetchone()
                if not row:
                    continue
                item_id = row["id"]

                # Afnemer bepalen via Ringtweelijst, anders gemeente-default
                ringtwo = d.get("Ringtweelijst") or []
                bedrijf_ids = [
                    _RINGTWO_EMAIL_BEDRIJF[e]
                    for e in (ringtwo if isinstance(ringtwo, list) else [])
                    if e in _RINGTWO_EMAIL_BEDRIJF
                ]
                if not bedrijf_ids:
                    gemeente_key = gemeente.lower().strip()
                    fallback = next(
                        (v for k, v in _GEMEENTE_BEDRIJF.items() if k in gemeente_key), None
                    )
                    if fallback:
                        bedrijf_ids = [fallback]
                for bedrijf_id in bedrijf_ids:
                    cur.execute("""
                        INSERT INTO aanbiedingen (item_id, bedrijf_id, aangeboden_door, status, created_at)
                        VALUES (%s, %s, %s, 'beschikbaar', %s)
                        ON CONFLICT DO NOTHING
                    """, (item_id, bedrijf_id, user_id, dt))

            imported += 1
            print(f"[firestore-sync] Item {item_id} geïmporteerd: {omschrijving[:60]}")
            if foto:
                _estimate_weight_background(item_id, foto)

        return imported
    except Exception as e:
        print(f"[firestore-sync] Fout: {e}")
        db.registreer_fout("firestore-sync", str(e))
        return 0


def _start_firestore_listener():
    """Start een realtime Firestore listener die direct reageert op nieuwe Marketplaceoffers."""
    try:
        fsdb = fs._get_db()
        if not fsdb:
            return

        def _on_snapshot(col_snapshot, changes, read_time):
            for change in changes:
                if change.type.name != "ADDED":
                    continue
                doc = change.document
                # Backup altijd
                _backup_firestore_docs([doc])
                # Controleer of al geïmporteerd
                with db.get_cursor() as cur:
                    cur.execute("SELECT id FROM items WHERE firestore_doc_id = %s", (doc.id,))
                    if cur.fetchone():
                        continue
                # Verwerk als nieuw item via bestaande sync-logica
                _sync_single_doc(doc)

        fsdb.collection("Marketplaceoffers").on_snapshot(_on_snapshot)
        print("[firestore-listener] Realtime listener gestart op Marketplaceoffers")
    except Exception as e:
        print(f"[firestore-listener] Start mislukt: {e}")


def _sync_single_doc(doc):
    """Importeer één Firestore-document als CIRQO-item."""
    try:
        d = doc.to_dict()
        ts = d.get("Datumaangemaakt")
        if not ts or not hasattr(ts, "timestamp"):
            return
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(ts.timestamp(), tz=timezone.utc)

        foto        = d.get("Foto") or ""
        foto_urls   = [u for u in [d.get("Foto"), d.get("foto2"), d.get("foto3"), d.get("foto4")] if u]
        omschrijving = d.get("Omschrijving") or ""
        categorie   = d.get("Categorie") or ""
        gemeente    = d.get("Gemeente") or ""
        firebase_uid = d.get("uid") or ""
        email       = d.get("user") or d.get("Productaanbieder") or ""

        supabase_user = None
        if firebase_uid:
            supabase_user = db.get_user_by_firebase_uid(firebase_uid)
        if not supabase_user and email:
            supabase_user = db.get_user_by_email(email)
        if not supabase_user:
            print(f"[firestore-listener] Onbekende gebruiker voor doc {doc.id}, sla op in backup")
            return

        import json as _json
        user_id = supabase_user["id"]
        with db.get_cursor() as cur:
            cur.execute("""
                INSERT INTO items (timestamp, photo_url, photo_urls, ai_label, ai_detail, category,
                                   gemeente, geaccepteerd, uploaded_by, firestore_doc_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, true, %s, %s)
                ON CONFLICT DO NOTHING
                RETURNING id
            """, (dt, foto, _json.dumps(foto_urls) if len(foto_urls) > 1 else None,
                  omschrijving, omschrijving, categorie, gemeente, user_id, doc.id))
            row = cur.fetchone()
            if not row:
                return
            item_id = row["id"]

            ringtwo = d.get("Ringtweelijst") or []
            bedrijf_ids = [
                _RINGTWO_EMAIL_BEDRIJF[e]
                for e in (ringtwo if isinstance(ringtwo, list) else [])
                if e in _RINGTWO_EMAIL_BEDRIJF
            ]
            if not bedrijf_ids:
                gemeente_key = gemeente.lower().strip()
                fallback = next(
                    (v for k, v in _GEMEENTE_BEDRIJF.items() if k in gemeente_key), None
                )
                if fallback:
                    bedrijf_ids = [fallback]
            for bedrijf_id in bedrijf_ids:
                cur.execute("""
                    INSERT INTO aanbiedingen (item_id, bedrijf_id, aangeboden_door, status, created_at)
                    VALUES (%s, %s, %s, 'beschikbaar', %s)
                    ON CONFLICT DO NOTHING
                """, (item_id, bedrijf_id, user_id, dt))

        print(f"[firestore-listener] Item {item_id} direct geïmporteerd: {omschrijving[:60]}")
        if foto:
            _estimate_weight_background(item_id, foto)
    except Exception as e:
        print(f"[firestore-listener] Fout bij verwerken doc {doc.id}: {e}")
        db.registreer_fout("firestore-listener", f"doc {doc.id}: {e}")


_AANB_STATUS_MAP = {
    "Ik wil dit ophalen": "ophalen",
    "Kom het mij brengen": "ophalen",
    "Niet nodig": "niet_nodig",
}


def _verwerk_ophaalverzoek_doc(d: dict) -> str:
    """Verwerk één Firestore ophaalverzoek-doc → aanbieding-status in Postgres.
    Geeft 'updated' | 'inserted' | 'unchanged' | 'skipped' terug."""
    status = _AANB_STATUS_MAP.get(d.get("Verzoek") or d.get("verzoek") or "")
    if not status:
        return "skipped"
    verzender = d.get("verzender") or ""
    bedrijf_naam_fs = (d.get("Bedrijfsnaam") or d.get("bedrijfsnaam") or "").lower()
    with db.get_cursor() as cur:
        bedrijf_id = None
        if verzender:
            cur.execute("SELECT b.id FROM bedrijven b JOIN users u ON u.bedrijf_id = b.id WHERE u.email = %s LIMIT 1", (verzender,))
            row = cur.fetchone()
            bedrijf_id = row["id"] if row else None
        if not bedrijf_id and bedrijf_naam_fs:
            cur.execute("SELECT id FROM bedrijven WHERE lower(naam) = %s LIMIT 1", (bedrijf_naam_fs,))
            row = cur.fetchone()
            bedrijf_id = row["id"] if row else None
        if not bedrijf_id:
            return "skipped"

        # Item vinden: Aanbodref → foto-URL → omschrijving+ontvanger
        item_id = None
        aanbodref = d.get("Aanbodref") or d.get("aanbodref")
        doc_id = aanbodref.id if aanbodref is not None and hasattr(aanbodref, "id") else None
        if doc_id:
            cur.execute("SELECT id FROM items WHERE firestore_doc_id = %s", (doc_id,))
            row = cur.fetchone()
            item_id = row["id"] if row else None
        if not item_id:
            foto = (d.get("foto") or d.get("foto_url") or "").split("?")[0]
            if foto:
                cur.execute("SELECT id FROM items WHERE split_part(photo_url,'?',1) = %s LIMIT 1", (foto,))
                row = cur.fetchone()
                item_id = row["id"] if row else None
        if not item_id:
            omschrijving = d.get("Omschrijving") or d.get("omschrijving") or ""
            ontvanger = d.get("ontvanger") or ""
            if omschrijving and ontvanger:
                cur.execute("""
                    SELECT i.id FROM items i
                    JOIN users u ON u.id = i.uploaded_by
                    WHERE i.ai_label ILIKE %s AND u.email = %s
                    LIMIT 1
                """, (omschrijving, ontvanger))
                row = cur.fetchone()
                item_id = row["id"] if row else None
        if not item_id:
            return "skipped"

        cur.execute("SELECT id, status FROM aanbiedingen WHERE item_id=%s AND bedrijf_id=%s", (item_id, bedrijf_id))
        existing = cur.fetchone()
        if existing:
            if existing["status"] == status:
                return "unchanged"
            cur.execute("UPDATE aanbiedingen SET status=%s WHERE id=%s", (status, existing["id"]))
            _invalideer_bedrijf_items(bedrijf_id)
            cur.execute("SELECT uploaded_by FROM items WHERE id=%s", (item_id,))
            _u = cur.fetchone()
            if _u and _u["uploaded_by"]:
                cache_module.delete_pattern(f"items:*:0:{_u['uploaded_by']}")
            return "updated"
        aangemaakt = d.get("Datumaangemaakt") or d.get("datumaangemaakt")
        ts = aangemaakt.isoformat() if hasattr(aangemaakt, "isoformat") else None
        cur.execute(
            "INSERT INTO aanbiedingen (item_id, bedrijf_id, status, created_at) VALUES (%s,%s,%s,%s)",
            (item_id, bedrijf_id, status, ts)
        )
        _invalideer_bedrijf_items(bedrijf_id)
        cur.execute("SELECT uploaded_by FROM items WHERE id=%s", (item_id,))
        _u = cur.fetchone()
        if _u and _u["uploaded_by"]:
            cache_module.delete_pattern(f"items:*:0:{_u['uploaded_by']}")
        return "inserted"


def _start_ophaalverzoeken_listener():
    """Realtime listener: reacties uit de FlutterFlow-app (ophaalverzoeken) direct naar Postgres.
    De eerste snapshot levert álle documenten → werkt meteen als inhaalslag na downtime."""
    try:
        fsdb = fs._get_db()
        if not fsdb:
            return

        def _on_snapshot(col_snapshot, changes, read_time):
            tellers = {"updated": 0, "inserted": 0, "unchanged": 0, "skipped": 0}
            for change in changes:
                if change.type.name not in ("ADDED", "MODIFIED"):
                    continue
                try:
                    tellers[_verwerk_ophaalverzoek_doc(change.document.to_dict() or {})] += 1
                except Exception as e:
                    print(f"[ophaalverzoek-listener] Fout bij doc {change.document.id}: {e}")
            if tellers["updated"] or tellers["inserted"]:
                print(f"[ophaalverzoek-listener] {tellers['updated']} statussen bijgewerkt, {tellers['inserted']} aanbiedingen toegevoegd")

        fsdb.collection("ophaalverzoeken").on_snapshot(_on_snapshot)
        print("[ophaalverzoek-listener] Realtime listener gestart op ophaalverzoeken")
    except Exception as e:
        print(f"[ophaalverzoek-listener] Start mislukt: {e}")


def _backfill_thumb_urls() -> int:
    """Vul photo_url_thumb voor items zonder thumbnail: Firebase via de 1024x1024-variant
    van de resize-extensie, Supabase via de render-API. Draait periodiek (thumb-sweep)."""
    import re
    import urllib.parse as _up
    try:
        with db.get_cursor() as cur:
            cur.execute("""
                SELECT id, photo_url FROM items
                WHERE photo_url IS NOT NULL AND photo_url != ''
                  AND (photo_url_thumb IS NULL OR photo_url_thumb = '')
            """)
            items = cur.fetchall()
        if not items:
            return 0
        from firebase_admin import storage as _storage
        gedaan = 0
        for item in items:
            url = item["photo_url"]
            thumb_url = None
            m = re.match(r'https://firebasestorage\.googleapis\.com/v0/b/([^/]+)/o/([^?]+)', url)
            if m:
                bucket_name, pad = m.group(1), _up.unquote(m.group(2))
                if pad.lower().endswith(('.jpg', '.jpeg', '.png')):
                    stam, ext = pad.rsplit('.', 1)
                    tpad = f"{stam}_1024x1024.{ext}"
                    try:
                        blob = _storage.bucket(bucket_name).blob(tpad)
                        blob.reload()
                        token = (blob.metadata or {}).get('firebaseStorageDownloadTokens', '')
                        if token:
                            thumb_url = (f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}"
                                         f"/o/{_up.quote(tpad, safe='')}?alt=media&token={token}")
                    except Exception:
                        pass   # variant (nog) niet gemaakt — volgende ronde opnieuw
            elif '.supabase.co/storage/v1/object/public/' in url:
                thumb_url = (url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') +
                             '?width=1024&height=1024&resize=contain')
            if thumb_url:
                with db.get_cursor() as cur:
                    cur.execute("UPDATE items SET photo_url_thumb = %s WHERE id = %s", (thumb_url, item["id"]))
                gedaan += 1
        return gedaan
    except Exception as e:
        print(f"[thumb-sweep] Fout: {e}")
        return 0


async def _firestore_sync_loop():
    """Eenmalige initiële sync bij startup, daarna houdt de realtime listener het bij."""
    import asyncio as _asyncio
    # Kleine delay zodat de app volledig gestart is
    await _asyncio.sleep(5)
    n = await _asyncio.get_event_loop().run_in_executor(None, _sync_firestore_items_now)
    if n:
        print(f"[firestore-sync] {n} nieuwe items geïmporteerd bij startup")
    # Start realtime listeners in achtergrond-threads
    import threading
    threading.Thread(target=_start_firestore_listener, daemon=True).start()
    threading.Thread(target=_start_ophaalverzoeken_listener, daemon=True).start()
    # Thumb-sweep: direct én daarna elk uur ontbrekende thumbnails koppelen
    while True:
        n = await _asyncio.get_event_loop().run_in_executor(None, _backfill_thumb_urls)
        if n:
            print(f"[thumb-sweep] {n} thumbnails gekoppeld")
        await _asyncio.sleep(3600)


app = FastAPI(title="De Bouwkringloop", lifespan=lifespan)
_CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "CORS_ORIGINS",
    "https://app.cirqo.nl,https://www.cirqo.nl,capacitor://localhost,http://localhost",
).split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(Exception)
async def _log_onverwachte_fout(request: Request, exc: Exception):
    """Vang onverwachte 500's, log ze in fout_log en geef een nette melding.
    HTTPException (403/404/…) gaat hier niet doorheen — dat zijn bewuste antwoorden."""
    import traceback
    try:
        db.registreer_fout(
            f"500 {request.method} {request.url.path}",
            traceback.format_exc(),
        )
    except Exception:
        pass
    print(f"[500] {request.method} {request.url.path}: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Er ging iets mis aan onze kant. Probeer het opnieuw."})


from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=()"
        # API-responses NOOIT laten cachen door de browser: zonder deze header
        # cachet iOS/Safari heuristisch en blijven lijsten minutenlang oud
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

app.add_middleware(SecurityHeadersMiddleware)


@app.get("/robots.txt", response_class=Response)
async def robots_txt():
    content = "User-agent: *\nAllow: /\nSitemap: https://app.cirqo.nl/sitemap.xml\n"
    return Response(content=content, media_type="text/plain")


@app.get("/sitemap.xml", response_class=Response)
async def sitemap_xml():
    content = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://app.cirqo.nl/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://app.cirqo.nl/login</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
  <url><loc>https://app.cirqo.nl/catalogus</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
</urlset>"""
    return Response(content=content, media_type="application/xml")


@app.get("/health")
async def health():
    """Health check — wordt gepingd door UptimeRobot om de container wakker te houden."""
    try:
        with db.get_cursor() as cur:
            cur.execute("SELECT 1")
        ai_ok = bool(os.environ.get("ANTHROPIC_API_KEY"))
        # Redis is optioneel maar bepaalt de "warme" snelheid; zichtbaar maken
        # in de health-check zodat een stille uitval opvalt
        redis_status = "uit"
        if os.environ.get("REDIS_URL"):
            try:
                r = cache_module.get_redis()
                redis_status = "ok" if (r and r.ping()) else "fout"
            except Exception:
                redis_status = "fout"
        return {"status": "ok", "db": "ok", "redis": redis_status,
                "ai": "ok" if ai_ok else "geen API key"}
    except Exception as e:
        from fastapi import Response
        return Response(content=f"db fout: {e}", status_code=503)


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.get("/api/auth/bedrijf-token/{token}")
async def login_met_token(token: str):
    """Automatisch inloggen voor bedrijven via de meld_token uit de link."""
    bedrijf = db.get_bedrijf_by_token(token)
    if not bedrijf:
        raise HTTPException(status_code=404, detail="Ongeldige link")
    # Zoek het bijbehorende bedrijf-account
    with db.get_cursor() as cur:
        cur.execute("SELECT * FROM users WHERE bedrijf_id = %s AND role = 'bedrijf' LIMIT 1", (bedrijf["id"],))
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Geen account gevonden voor dit bedrijf")
    user = dict(row)
    token_jwt = auth_module.create_token(
        user["id"], user["username"], user["role"],
        user.get("gemeente") or "", user.get("bedrijf_id")
    )
    return {
        "token": token_jwt,
        "username": bedrijf["naam"],
        "role": "bedrijf",
        "bedrijf_id": bedrijf["id"],
    }


# Brute-force-rem op inloggen: max 8 mislukte pogingen per kwartier per gebruikersnaam+IP
_LOGIN_POGINGEN: dict = {}
_LOGIN_MAX = 8
_LOGIN_VENSTER = 15 * 60  # seconden


def _login_key(request: Request, username: str) -> str:
    # Achter de Railway-proxy staat het echte IP in X-Forwarded-For
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() \
         or (request.client.host if request.client else "?")
    return f"{username.strip().lower()}|{ip}"


def _login_geblokkeerd(key: str) -> bool:
    import time as _t
    nu = _t.time()
    recent = [t for t in _LOGIN_POGINGEN.get(key, []) if nu - t < _LOGIN_VENSTER]
    if recent:
        _LOGIN_POGINGEN[key] = recent
    else:
        _LOGIN_POGINGEN.pop(key, None)
    if len(_LOGIN_POGINGEN) > 10000:   # geheugen begrensd houden
        _LOGIN_POGINGEN.clear()
    return len(recent) >= _LOGIN_MAX


@app.post("/api/auth/login")
async def login(request: Request, username: str = Form(...), password: str = Form(...)):
    import time as _t
    key = _login_key(request, username)
    if _login_geblokkeerd(key):
        raise HTTPException(status_code=429, detail="Te veel mislukte pogingen — probeer het over 15 minuten opnieuw")
    user = db.get_user_by_username(username)
    if not user or not auth_module.verify_password(password, user["password"]):
        _LOGIN_POGINGEN.setdefault(key, []).append(_t.time())
        raise HTTPException(status_code=401, detail="Onjuiste gebruikersnaam of wachtwoord")
    _LOGIN_POGINGEN.pop(key, None)   # gelukt → teller wissen
    # Stilzwijgende migratie: oude HMAC-hashes worden bij succesvolle login
    # omgezet naar bcrypt — de gebruiker merkt hier niets van
    if auth_module.needs_rehash(user["password"]):
        try:
            db.update_user_password(user["id"], password)
        except Exception as e:
            print(f"[auth] bcrypt-migratie mislukt voor user {user['id']}: {e}")
    token = auth_module.create_token(
        user["id"], user["username"], user["role"],
        user.get("gemeente") or "", user.get("bedrijf_id")
    )
    return {
        "token": token,
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "gemeente": user.get("gemeente") or "",
        "bedrijf_id": user.get("bedrijf_id"),
        "organisatie": user.get("organisatie") or "",
        "auth_type": "local",
    }


@app.post("/api/auth/firebase-login")
async def firebase_login(request: Request):
    """Verifieer een Firebase ID-token en geef een CIRQO JWT terug."""
    data = await request.json()
    id_token = data.get("id_token")
    if not id_token:
        raise HTTPException(status_code=400, detail="id_token vereist")
    try:
        import firebase_admin.auth as fb_auth
        fs._get_db()  # zorg dat Firebase app geïnitialiseerd is
        decoded = fb_auth.verify_id_token(id_token)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Ongeldig Firebase token: {e}")

    firebase_uid = decoded["uid"]
    email = decoded.get("email", "")
    email_verified = bool(decoded.get("email_verified"))

    # Haal naam op uit Firestore users3
    naam = email
    gemeente = ""
    role = "user"
    try:
        fsdb = fs._get_db()
        if fsdb:
            docs = fsdb.collection("users3").where("email", "==", email).limit(1).get()
            if not docs:
                # Probeer op UID als document-ID
                doc = fsdb.collection("users3").document(firebase_uid).get()
                docs = [doc] if doc.exists else []
            for doc in docs:
                d = doc.to_dict() or {}
                naam = d.get("Naamofbedrijf") or d.get("naam") or email
                gemeente = d.get("Gemeente") or d.get("gemeente") or ""
                if d.get("Administrator") and email_verified:
                    role = "admin"
    except Exception as e:
        print(f"[firebase-login] Firestore lookup fout: {e}")

    # Naadloze koppeling: hoort deze e-mail bij een bedrijf? → log direct in als afnemer
    # Alleen bij een geverifieerd e-mailadres (anders geen bedrijf-/adminrechten via claim).
    bedrijf_id = None
    bdrf = db.get_bedrijf_by_email(email) if (email and email_verified) else None
    if not bdrf and email and email_verified:
        _bid = _RINGTWO_EMAIL_BEDRIJF.get(email.lower())
        if _bid:
            bdrf = {"id": _bid}
    if bdrf:
        bedrijf_id = bdrf["id"]
        if role not in ("admin", "superadmin"):
            role = "bedrijf"
        if bdrf.get("gemeente"):
            gemeente = bdrf["gemeente"]
        if bdrf.get("naam") and not naam:
            naam = bdrf["naam"]

    user = db.upsert_firebase_user(firebase_uid, email, naam, gemeente, role, bedrijf_id=bedrijf_id)
    token = auth_module.create_token(
        user["id"], user["username"], user["role"],
        user.get("gemeente") or "", user.get("bedrijf_id")
    )
    return {
        "token": token,
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "gemeente": user.get("gemeente") or "",
        "bedrijf_id": user.get("bedrijf_id"),
        "organisatie": user.get("organisatie") or naam,
        "auth_type": "firebase",
    }


@app.post("/api/admin/sync-firestore")
async def sync_firestore_manual(user=Depends(require_superadmin)):
    """Handmatige trigger: sync nieuwe Firestore items naar Supabase."""
    import asyncio as _asyncio
    n = await _asyncio.get_event_loop().run_in_executor(None, _sync_firestore_items_now)
    return {"imported": n}


@app.get("/api/admin/fouten")
async def admin_fouten(limit: int = 100, user=Depends(require_superadmin)):
    """Foutenlog: onverwachte 500's en mislukte achtergrond-syncs. Voor monitoring."""
    return {"fouten": db.get_fouten(min(limit, 500)), "laatste_24u": db.tel_fouten_sinds(24)}


@app.post("/api/gebruik")
async def meld_gebruik(kanaal: str = Form(...), user=Depends(get_current_user)):
    """Client meldt bij app-start via welk kanaal hij draait (update-adoptie)."""
    if kanaal not in ("native-ios", "native-android", "pwa", "browser"):
        kanaal = "browser"
    with db.get_cursor() as cur:
        cur.execute("""
            INSERT INTO gebruik_kanaal (user_id, kanaal, laatst_gezien) VALUES (%s, %s, now())
            ON CONFLICT (user_id) DO UPDATE SET kanaal = EXCLUDED.kanaal, laatst_gezien = now()
        """, (user["id"], kanaal))
    # Token verversen: bij elke app-start rolt de geldigheid weer naar een vol jaar
    # vooruit, zodat een actieve gebruiker nooit onverwacht wordt uitgelogd.
    vers_token = auth_module.create_token(
        user["id"], user["username"], user["role"],
        user.get("gemeente") or "", user.get("bedrijf_id"),
    )
    return {"ok": True, "vernieuwd_token": vers_token}


@app.get("/api/admin/gebruik")
async def admin_gebruik(user=Depends(require_superadmin)):
    """Per gebruiker: laatst gezien + kanaal. Wie ontbreekt zit nog in de oude app of web."""
    with db.get_cursor() as cur:
        cur.execute("""
            SELECT u.id, u.username, COALESCE(u.organisatie, u.username) AS naam, u.role, u.gemeente,
                   g.kanaal, g.laatst_gezien
            FROM users u LEFT JOIN gebruik_kanaal g ON g.user_id = u.id
            ORDER BY g.laatst_gezien DESC NULLS LAST, u.username
        """)
        rijen = [dict(r) for r in cur.fetchall()]
    labels = {"native-ios": "App Store-app", "native-android": "Play Store-app",
              "pwa": "Beginscherm-app", "browser": "Browser"}
    for r in rijen:
        r["kanaal_label"] = labels.get(r["kanaal"], "Nog niet gezien in nieuwe app")
    return {"gebruikers": rijen}


@app.post("/api/admin/import-firestore")
async def import_firestore(user=Depends(require_superadmin)):
    """Eenmalige import van Marketplaceoffers en ophaalverzoeken uit Firestore naar PostgreSQL."""
    fsdb = fs._get_db()
    if not fsdb:
        raise HTTPException(status_code=503, detail="Firestore niet beschikbaar")

    items_added = 0
    items_skipped = 0
    aanbiedingen_added = 0

    # Items importeren
    try:
        docs = fsdb.collection("Marketplaceoffers").stream()
        for doc in docs:
            d = doc.to_dict() or {}
            # Skip als het al een cirqo_web item is (die hebben we al in PostgreSQL)
            if d.get("bron") == "cirqo_web":
                items_skipped += 1
                continue
            try:
                photo_url = d.get("foto_url") or d.get("photoUrl") or d.get("photo_url") or ""
                label = d.get("label") or d.get("naam") or d.get("title") or "Onbekend"
                detail = d.get("detail") or d.get("beschrijving") or d.get("description") or ""
                gewicht = d.get("gewicht_kg") or d.get("gewicht") or 0
                gemeente = d.get("gemeente") or d.get("Gemeente") or ""
                category = d.get("categorie") or d.get("category") or ""
                note = d.get("opmerking") or d.get("note") or ""

                item_id = db.insert_item(photo_url, label, detail, float(gewicht) if gewicht else 0,
                                         gemeente, True, uploaded_by=None)
                if category or note:
                    db.update_item(item_id, note or None, category or None)
                # Markeer als geïmporteerd uit Firestore
                with db.get_cursor() as cur:
                    cur.execute("UPDATE items SET firestore_doc_id=%s WHERE id=%s",
                                (doc.id, item_id)) if _has_firestore_col() else None
                items_added += 1
            except Exception as e:
                print(f"[import] Item {doc.id} overgeslagen: {e}")
                items_skipped += 1
    except Exception as e:
        print(f"[import] Fout bij items: {e}")

    return {
        "ok": True,
        "items_added": items_added,
        "items_skipped": items_skipped,
        "aanbiedingen_added": aanbiedingen_added,
    }


@app.post("/api/admin/heranalyseer-gewichten")
async def heranalyseer_gewichten(gemeente: str = Form("Almere"), user=Depends(require_superadmin)):
    """Heranalyseer gewichten van alle items in een gemeente met Sonnet."""
    import ai, asyncio, time as _time
    with db.get_cursor() as cur:
        cur.execute(
            "SELECT id, ai_label, photo_url, gewicht_kg FROM items WHERE gemeente=%s AND photo_url IS NOT NULL AND photo_url != '' ORDER BY id",
            (gemeente,)
        )
        items = [dict(r) for r in cur.fetchall()]

    updated = skipped = 0
    for item in items:
        nieuw = await asyncio.get_event_loop().run_in_executor(
            None, ai.heranalyseer_gewicht, item["photo_url"], item["ai_label"]
        )
        if nieuw is not None:
            with db.get_cursor() as cur:
                cur.execute("UPDATE items SET gewicht_kg=%s WHERE id=%s", (nieuw, item["id"]))
            print(f"[gewicht] {item['ai_label']}: {item['gewicht_kg']} → {nieuw} kg")
            updated += 1
        else:
            skipped += 1
        await asyncio.sleep(0.3)

    return {"ok": True, "gemeente": gemeente, "updated": updated, "skipped": skipped}


@app.post("/api/admin/fix-aanbieding-statussen")
async def fix_aanbieding_statussen(user=Depends(require_superadmin)):
    """Herstel aanbieding-statussen vanuit Firestore ophaalverzoeken."""
    fsdb = fs._get_db()
    if not fsdb:
        raise HTTPException(status_code=503, detail="Firestore niet beschikbaar")

    tellers = {"updated": 0, "inserted": 0, "unchanged": 0, "skipped": 0}
    for doc in fsdb.collection("ophaalverzoeken").stream():
        tellers[_verwerk_ophaalverzoek_doc(doc.to_dict() or {})] += 1
    return {"ok": True, **tellers}


def _has_firestore_col():
    try:
        with db.get_cursor() as cur:
            cur.execute("SELECT firestore_doc_id FROM items LIMIT 1")
        return True
    except Exception:
        return False


@app.post("/api/auth/impersonate/{user_id}")
async def impersonate(user_id: int, user=Depends(get_current_user)):
    if user["role"] != "superadmin":
        raise HTTPException(status_code=403, detail="Geen toegang")
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Gebruiker niet gevonden")
    token = auth_module.create_token(
        target["id"], target["username"], target["role"],
        target.get("gemeente") or "", target.get("bedrijf_id")
    )
    return {
        "token": token,
        "user_id": target["id"],
        "username": target["username"],
        "role": target["role"],
        "gemeente": target.get("gemeente") or "",
        "organisatie": target.get("organisatie") or "",
        "bedrijf_id": target.get("bedrijf_id"),
    }


@app.post("/api/auth/request-reset")
async def request_reset(email: str = Form(...)):
    """
    Zorgt dat er een Firebase-account bestaat voor dit e-mailadres.
    De browser stuurt daarna zelf sendPasswordResetEmail() — Firebase verstuurt de mail.
    """
    email = email.strip().lower()
    if "@" not in email:
        return {"ok": True}

    try:
        import firebase_admin.auth as _fb_auth
        fs._get_db()

        # Controleer of Firebase-account al bestaat
        firebase_exists = False
        try:
            _fb_auth.get_user_by_email(email)
            firebase_exists = True
        except Exception:
            pass

        if not firebase_exists:
            # Supabase-gebruiker zonder Firebase-account: maak Firebase-account aan
            user = db.get_user_by_email(email)
            if user:
                import secrets as _sec
                fb_user = _fb_auth.create_user(
                    email=email,
                    password=_sec.token_urlsafe(24),  # tijdelijk wachtwoord, wordt meteen gereset
                    email_verified=False,
                )
                # Koppel firebase_uid aan bestaand Supabase-account
                with db.get_cursor() as cur:
                    cur.execute(
                        "UPDATE users SET firebase_uid = %s, email = %s WHERE id = %s",
                        (fb_user.uid, email, user["id"]),
                    )
    except Exception as e:
        print(f"[request-reset] Fout: {e}")

    return {"ok": True}


@app.post("/api/auth/sync-password")
async def sync_password(request: Request):
    """Na Firebase wachtwoord-reset: sync het nieuwe wachtwoord naar Supabase."""
    data = await request.json()
    id_token = data.get("id_token")
    password = data.get("password", "")
    if not id_token or len(password) < 6:
        raise HTTPException(status_code=400, detail="Ongeldige invoer")
    try:
        import firebase_admin.auth as _fb_auth
        fs._get_db()
        decoded = _fb_auth.verify_id_token(id_token)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Ongeldig token: {e}")
    firebase_uid = decoded["uid"]
    email = decoded.get("email", "")
    # Zoek Supabase-gebruiker op firebase_uid of email/username
    user = db.get_user_by_firebase_uid(firebase_uid)
    if not user and email:
        user = db.get_user_by_email(email)
    if not user:
        return {"ok": True}  # geen Supabase-account, niets te doen
    db.update_user_password(user["id"], password)
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user=Depends(get_current_user)):
    db_user = db.get_user_by_id(user["id"])
    organisatie = (db_user or {}).get("organisatie") or ""
    # Bedrijf-gebruikers: val terug op de naam uit de bedrijven-tabel
    if not organisatie and user.get("bedrijf_id"):
        with db.get_cursor() as cur:
            cur.execute("SELECT naam FROM bedrijven WHERE id = %s", (user["bedrijf_id"],))
            row = cur.fetchone()
            if row:
                organisatie = row["naam"]
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "gemeente": user.get("gemeente") or "",
        "organisatie": organisatie,
        "email": (db_user or {}).get("email") or ("@" in user["username"] and user["username"] or ""),
        "contactpersoon": (db_user or {}).get("contactpersoon") or "",
        "telefoon": (db_user or {}).get("telefoon") or "",
        "adres": (db_user or {}).get("adres") or "",
        "auto_doorsturen": bool((db_user or {}).get("auto_doorsturen")),
        "melding_digest": bool((db_user or {}).get("melding_digest")),
    }


# ── Gemeenten ─────────────────────────────────────────────────────────────────

@app.get("/api/gemeenten")
async def list_gemeenten(user=Depends(get_current_user)):
    if DEFAULT_BRAND == "rwm":
        return RWM_GEMEENTEN
    # Wijzigt zelden (alleen bij accountbeheer) — 5 min cache scheelt een DB-call
    # in de drukke opstart-burst van de app
    cached = cache_module.get("gemeenten:all")
    if cached is not None:
        return cached
    result = db.get_gemeenten()
    cache_module.set("gemeenten:all", result, ttl=300)
    return result


@app.get("/api/geocode")
async def geocode(lat: float, lon: float, user=Depends(get_current_user)):
    """Reverse-geocode via de backend i.p.v. rechtstreeks vanaf de client.
    Milieustraten zijn vaste locaties, dus de cache (cel van ~100m) vangt
    vrijwel alles op — sneller én geen throttling-risico bij Nominatim."""
    cache_key = f"geo:{round(lat, 3)}:{round(lon, 3)}"
    cached = cache_module.get(cache_key)
    if cached is not None:
        return {"gemeente": cached or None}
    gemeente = None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": lat, "lon": lon, "format": "json", "addressdetails": 1},
                headers={
                    "Accept-Language": "nl",
                    # Nominatim-beleid vereist een identificerende User-Agent
                    "User-Agent": "cirqo-app/1.0 (https://app.cirqo.nl)",
                },
            )
            addr = (r.json() or {}).get("address", {})
            gemeente = (addr.get("municipality") or addr.get("city")
                        or addr.get("town") or addr.get("village"))
    except Exception as e:
        db.registreer_fout("geocode", str(e))
    cache_module.set(cache_key, gemeente or "", ttl=60 * 60 * 24 * 30)
    return {"gemeente": gemeente}


@app.get("/api/mijn-gemeenten")
async def mijn_gemeenten(user=Depends(get_current_user)):
    """Scope van de ingelogde gebruiker voor de dashboard-switcher.
    Geeft {gemeenten: [...], milieustraten: [{naam, gemeente}, ...]|null} terug —
    organisaties met milieustraten filteren daarop i.p.v. op kale gemeenten."""
    g = user.get("gemeente") or ""
    if g in ORGANISATIE_GEMEENTEN:
        return {"gemeenten": ORGANISATIE_GEMEENTEN[g],
                "milieustraten": ORGANISATIE_MILIEUSTRATEN.get(g)}
    if user["role"] == "superadmin":
        return {"gemeenten": db.get_gemeenten(), "milieustraten": None}
    return {"gemeenten": [g] if g else [], "milieustraten": None}


@app.get("/api/milieustraten")
async def list_milieustraten():
    if DEFAULT_BRAND == "rwm":
        return RWM_MILIEUSTRATEN
    return {}


@app.get("/api/gemeenten/stats")
async def gemeente_stats(user=Depends(require_superadmin)):
    return db.get_gemeente_stats()


# ── Gebruikersbeheer ──────────────────────────────────────────────────────────

@app.get("/api/users")
async def list_users(user=Depends(require_admin)):
    all_users = db.get_all_users()
    # superadmin ziet iedereen; gemeente-admin ziet alleen eigen gemeente
    if user["role"] == "superadmin":
        return all_users
    return [u for u in all_users if u["gemeente"] == user["gemeente"] and u["role"] != "superadmin"]


@app.post("/api/users")
async def create_user(
    username: str = Form(...),
    password: str = Form(...),
    gemeente: str = Form(""),
    role: str = Form("user"),
    admin=Depends(require_admin),
):
    fout = auth_module.wachtwoord_ok(password)
    if fout:
        raise HTTPException(status_code=400, detail=fout)
    # Gemeente-admins kunnen alleen users in hun eigen gemeente aanmaken
    if admin["role"] == "admin":
        gemeente = admin["gemeente"]
        if role not in ("user", "admin"):
            raise HTTPException(status_code=403, detail="Je kunt alleen scanners of beheerders aanmaken")
    # Superadmin kan ook admins aanmaken, maar geen superadmins via API
    if role == "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin aanmaken niet toegestaan via API")
    try:
        user_id = db.create_user(username, password, role, gemeente)
        return db.get_user_by_id(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Gebruikersnaam al in gebruik")


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, admin=Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Je kunt jezelf niet verwijderen")
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404)
    # Gemeente-admin mag alleen eigen gemeente-users verwijderen
    if admin["role"] == "admin" and target["gemeente"] != admin["gemeente"]:
        raise HTTPException(status_code=403, detail="Geen rechten voor deze gebruiker")
    if target["role"] == "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin kan niet worden verwijderd")
    db.delete_user(user_id)
    return {"ok": True}


@app.patch("/api/users/{user_id}/role")
async def change_user_role(
    user_id: int,
    role: str = Form(...),
    bedrijf_id: Optional[int] = Form(None),
    admin=Depends(require_superadmin),
):
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404)
    if target["role"] == "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin kan niet worden gewijzigd")
    if role not in ("user", "admin", "bedrijf"):
        raise HTTPException(status_code=400, detail="Ongeldige rol")
    db.update_user_role(user_id, role, bedrijf_id)
    return {"ok": True}


@app.patch("/api/users/{user_id}/gemeente")
async def change_gemeente(
    user_id: int,
    gemeente: str = Form(...),
    user=Depends(get_current_user),
):
    if user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Geen rechten")
    # Organisatiescope (bv. 'waardlanden') is beheer-domein: een org-account mag
    # zichzelf niet naar één gemeente versmallen (zelf-uitsluiting)
    if (user.get("gemeente") or "") in ORGANISATIE_GEMEENTEN and user["role"] != "superadmin":
        raise HTTPException(status_code=403, detail="Je scope wordt centraal beheerd — vraag de beheerder")
    # Zelf-wijziging alleen binnen de eigen organisatiescope: de gemeente bepaalt
    # tot welke tenant-data iemand toegang heeft, dus een vrije wissel zou
    # toegang tot andere gemeenten geven
    if user["role"] != "superadmin":
        huidige = (user.get("gemeente") or "").strip()
        toegestaan = {huidige} if huidige else set()
        org = (user.get("organisatie") or "").strip().lower()
        if org in ORGANISATIE_GEMEENTEN:
            toegestaan |= set(ORGANISATIE_GEMEENTEN[org])
        scope = _gemeenten_expand(huidige)
        if scope:
            toegestaan |= set(scope)
        if gemeente.strip() not in toegestaan:
            raise HTTPException(status_code=403, detail="Gemeente valt buiten je organisatie — vraag de beheerder")
    with db.get_cursor() as cur:
        cur.execute("UPDATE users SET gemeente = %s WHERE id = %s", (gemeente.strip(), user_id))
    _USER_VERS_CACHE.pop(user_id, None)   # scope-wijziging direct zichtbaar
    new_token = auth_module.create_token(
        user["id"], user["username"], user["role"],
        gemeente.strip(), user.get("bedrijf_id")
    )
    return {"ok": True, "token": new_token, "gemeente": gemeente.strip()}


@app.patch("/api/users/{user_id}/password")
async def change_password(
    user_id: int,
    password: str = Form(...),
    user=Depends(get_current_user),
):
    fout = auth_module.wachtwoord_ok(password)
    if fout:
        raise HTTPException(status_code=400, detail=fout)
    # Gewone user of bedrijf mag alleen het eigen wachtwoord wijzigen
    if user["role"] in ("user", "bedrijf") and user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Geen rechten")
    target = db.get_user_by_id_full(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Gebruiker niet gevonden")
    # Gemeente-admin: alleen users in eigen gemeente, nooit een superadmin
    if user["role"] == "admin" and user["id"] != user_id:
        if target.get("role") == "superadmin" or target.get("gemeente") != user.get("gemeente"):
            raise HTTPException(status_code=403, detail="Geen rechten voor deze gebruiker")
    # Update Firebase Auth als de gebruiker een Firebase-account heeft
    if target.get("firebase_uid"):
        try:
            import firebase_admin.auth as _fb_auth
            fs._get_db()
            _fb_auth.update_user(target["firebase_uid"], password=password)
        except Exception as e:
            print(f"[change-password] Firebase update fout: {e}")
            db.registreer_fout("change-password-firebase", str(e), user_id=user_id)
    db.update_user_password(user_id, password)
    return {"ok": True}


@app.patch("/api/users/{user_id}/organisatie")
async def change_organisatie(
    user_id: int,
    organisatie: str = Form(...),
    user=Depends(get_current_user),
):
    if user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Geen rechten")
    with db.get_cursor() as cur:
        cur.execute("UPDATE users SET organisatie = %s WHERE id = %s", (organisatie.strip(), user_id))
    return {"ok": True, "organisatie": organisatie.strip()}


@app.patch("/api/users/{user_id}/profiel")
async def change_profiel(
    user_id: int,
    organisatie: Optional[str] = Form(None),
    contactpersoon: Optional[str] = Form(None),
    telefoon: Optional[str] = Form(None),
    adres: Optional[str] = Form(None),
    melding_digest: Optional[bool] = Form(None),
    user=Depends(get_current_user),
):
    """Profielgegevens (Mijn gegevens in het accountpaneel)."""
    if user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Geen rechten")
    if melding_digest is not None:
        with db.get_cursor() as cur:
            cur.execute("UPDATE users SET melding_digest = %s WHERE id = %s", (melding_digest, user_id))
    velden = {"organisatie": organisatie, "contactpersoon": contactpersoon,
              "telefoon": telefoon, "adres": adres}
    updates = {k: v.strip()[:160] for k, v in velden.items() if v is not None}
    if not updates:
        if melding_digest is not None:
            return {"ok": True, "melding_digest": melding_digest}
        raise HTTPException(status_code=400, detail="Geen velden om op te slaan")
    with db.get_cursor() as cur:
        kolommen = ", ".join(f"{k} = %s" for k in updates)
        cur.execute(f"UPDATE users SET {kolommen} WHERE id = %s", (*updates.values(), user_id))
    return {"ok": True, **updates}


@app.patch("/api/users/{user_id}/auto-doorsturen")
async def set_auto_doorsturen(
    user_id: int,
    enabled: bool = Form(...),
    user=Depends(get_current_user),
):
    if user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Geen rechten")
    db.set_auto_doorsturen(user_id, enabled)
    return {"ok": True, "auto_doorsturen": enabled}


# ── Bedrijven ─────────────────────────────────────────────────────────────────

@app.get("/api/bedrijven")
async def get_bedrijven(gemeente: Optional[str] = None, user=Depends(require_admin)):
    g = _gemeente_filter(user, gemeente)
    return db.get_bedrijven(g)


@app.get("/api/bedrijven-voor-scan")
async def bedrijven_voor_scan(
    gemeente: str,
    category: Optional[str] = None,
    item_id: Optional[int] = None,
    user=Depends(get_current_user),
):
    gemeenten = _gemeenten_expand(gemeente)
    alle = db.get_bedrijven(None if gemeenten else gemeente, gemeenten=gemeenten)
    # Eigen bedrijf niet in de aanbiedlijst — aan jezelf aanbieden is ruis
    if user.get("bedrijf_id"):
        alle = [b for b in alle if b["id"] != user["bedrijf_id"]]
    if category:
        match_ids = {b["id"] for b in db.get_bedrijven_for_item(None if gemeenten else gemeente, category, gemeenten=gemeenten)}
        if not match_ids:
            match_ids = {b["id"] for b in db.get_bedrijven_for_item(None, category)}
    else:
        match_ids = set()
    already_offered = set()
    if item_id:
        with db.get_cursor() as cur:
            cur.execute("SELECT bedrijf_id FROM aanbiedingen WHERE item_id = %s", (item_id,))
            already_offered = {r["bedrijf_id"] for r in cur.fetchall()}
    # Historie: hoe vaak haalde dit bedrijf eerder deze categorie op? (sterkste matchsignaal)
    historie = {}
    if category:
        with db.get_cursor() as cur:
            cur.execute("""
                SELECT a.bedrijf_id, COUNT(*) AS n
                FROM aanbiedingen a JOIN items i ON i.id = a.item_id
                WHERE a.status = 'ophalen' AND i.category = %s
                GROUP BY a.bedrijf_id
            """, (category,))
            historie = {r["bedrijf_id"]: r["n"] for r in cur.fetchall()}
    for b in alle:
        b["categorie_match"] = b["id"] in match_ids
        b["historie_count"]  = historie.get(b["id"], 0)
        b["al_aangeboden"]   = b["id"] in already_offered
    # Volgorde: eerder-opgehaald eerst (vaakst bovenaan), dan interesse-match, dan naam
    alle.sort(key=lambda b: (b["al_aangeboden"], -b["historie_count"], not b["categorie_match"], b["naam"]))
    return alle


@app.post("/api/bedrijven")
async def create_bedrijf(
    naam: str = Form(...),
    gemeente: str = Form(...),
    contactpersoon: str = Form(""),
    email: str = Form(""),
    telefoon: str = Form(""),
    categorieen: str = Form(""),
    login_username: str = Form(""),
    login_password: str = Form(""),
    user=Depends(require_admin),
):
    cat_list = [c.strip() for c in categorieen.split(",") if c.strip()]
    bedrijf_id = db.create_bedrijf(naam, gemeente, contactpersoon, email, telefoon, cat_list)
    if login_username and login_password:
        db.create_user(login_username, login_password, role="bedrijf",
                       gemeente=gemeente, bedrijf_id=bedrijf_id)
    return {"id": bedrijf_id}


@app.patch("/api/bedrijven/{bedrijf_id}")
async def update_bedrijf(
    bedrijf_id: int,
    naam: str = Form(...),
    contactpersoon: str = Form(""),
    email: str = Form(""),
    telefoon: str = Form(""),
    categorieen: str = Form(""),
    user=Depends(require_admin),
):
    if user["role"] != "superadmin" and not _bedrijf_werkt_in(bedrijf_id, _scope_gemeenten(user)):
        raise HTTPException(status_code=403, detail="Bedrijf valt buiten je gemeente-scope")
    cat_list = [c.strip() for c in categorieen.split(",") if c.strip()]
    db.update_bedrijf(bedrijf_id, naam, contactpersoon, email, telefoon, cat_list)
    return {"ok": True}


@app.delete("/api/bedrijven/{bedrijf_id}")
async def delete_bedrijf(bedrijf_id: int, user=Depends(require_admin)):
    if user["role"] != "superadmin" and not _bedrijf_werkt_in(bedrijf_id, _scope_gemeenten(user)):
        raise HTTPException(status_code=403, detail="Bedrijf valt buiten je gemeente-scope")
    db.delete_bedrijf(bedrijf_id)
    return {"ok": True}


# ── Aanbiedingen ──────────────────────────────────────────────────────────────

@app.post("/api/aanbiedingen")
async def create_aanbieding(
    item_id: int = Form(...),
    bedrijf_id: int = Form(...),
    user=Depends(get_current_user),
):
    _item = db.get_item(item_id)
    if not _item:
        raise HTTPException(status_code=404)
    if not _mag_item_beheren(user, _item):
        raise HTTPException(status_code=403, detail="Geen rechten voor dit item")
    # Geen gemeente-check op het bedrijf: de aanbiedlijst toont bewust ook
    # bedrijven buiten de eigen gemeente (organisatie-breed + landelijke
    # fallback als er lokaal geen categorie-match is)
    aanbieding_id = db.create_aanbieding(item_id, bedrijf_id, user_id=user["id"])
    fs.sync_aanbieding({"id": aanbieding_id, "item_id": item_id, "bedrijf_id": bedrijf_id, "status": "open"})
    gemeente = _gemeente_filter(user)
    gemeenten = _gemeenten_expand(gemeente)
    cache_key = f"items:{gemeenten or gemeente}:0:{user['id']}"
    cache_module.delete(cache_key, f"items:None:0:{user['id']}")
    _invalideer_bedrijf_items(bedrijf_id)               # ontvangend bedrijf ziet nieuw aanbod
    _invalideer_bedrijf_items(user.get("bedrijf_id"))   # aanbieder-bedrijf: eigen item nu 'aangeboden'

    # Push op de achtergrond — vertraagt het response niet
    async def _stuur_bedrijf_push():
        item = db.get_item(item_id)
        label = (item or {}).get("ai_label") or "nieuw materiaal"
        subscriptions = db.get_push_subscriptions_for_bedrijf(bedrijf_id)
        print(f"[push] Aanbieding voor bedrijf {bedrijf_id}: {len(subscriptions)} subscription(s)")
        for sub in subscriptions:
            ok = push_module.send_push(
                sub["subscription"],
                title="Nieuw aanbod — CIRQO",
                body=f"Er is {label} aangeboden.",
                url="/",
            )
            print(f"[push] Verzonden naar sub {sub['id']}: {'OK' if ok else 'MISLUKT'}")
            if not ok:
                db.delete_push_subscription(sub["subscription"])

    asyncio.create_task(_stuur_bedrijf_push())
    return {"id": aanbieding_id}


@app.post("/api/aanbiedingen/bulk")
async def create_aanbiedingen_bulk(
    request: Request,
    user=Depends(get_current_user),
):
    data = await request.json()
    item_id = data.get("item_id")
    bedrijf_ids = data.get("bedrijf_ids", [])
    if not item_id or not bedrijf_ids:
        raise HTTPException(status_code=400, detail="item_id en bedrijf_ids vereist")
    _item = db.get_item(int(item_id))
    if not _item:
        raise HTTPException(status_code=404)
    if not _mag_item_beheren(user, _item):
        raise HTTPException(status_code=403, detail="Geen rechten voor dit item")

    ids = []
    for bedrijf_id in bedrijf_ids:
        try:
            aanbieding_id = db.create_aanbieding(item_id, int(bedrijf_id), user_id=user["id"])
            ids.append(aanbieding_id)
            fs.sync_aanbieding({"id": aanbieding_id, "item_id": item_id, "bedrijf_id": int(bedrijf_id), "status": "open"})
        except Exception as e:
            db.registreer_fout("aanbieding_bulk", f"bedrijf {bedrijf_id}: {e}")

    gemeente = _gemeente_filter(user)
    gemeenten = _gemeenten_expand(gemeente)
    cache_key = f"items:{gemeenten or gemeente}:0:{user['id']}"
    cache_module.delete(cache_key, f"items:None:0:{user['id']}")
    for _bid in bedrijf_ids:
        _invalideer_bedrijf_items(int(_bid))            # elk ontvangend bedrijf
    _invalideer_bedrijf_items(user.get("bedrijf_id"))   # aanbieder-bedrijf

    async def _stuur_bulk_push():
        item = db.get_item(item_id)
        label = (item or {}).get("ai_label") or "nieuw materiaal"
        for bedrijf_id in bedrijf_ids:
            subscriptions = db.get_push_subscriptions_for_bedrijf(int(bedrijf_id))
            for sub in subscriptions:
                ok = push_module.send_push(
                    sub["subscription"],
                    title="Nieuw aanbod — CIRQO",
                    body=f"Er is {label} aangeboden.",
                    url="/",
                )
                if not ok:
                    db.delete_push_subscription(sub["subscription"])

    asyncio.create_task(_stuur_bulk_push())
    return {"ids": ids, "count": len(ids)}


@app.get("/api/push/vapid-key")
async def get_vapid_key():
    return {"public_key": push_module.get_public_key()}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request, user=Depends(get_current_user)):
    data = await request.json()
    subscription = data.get("subscription")
    if not subscription:
        raise HTTPException(status_code=400, detail="subscription vereist")
    import json as _json
    bedrijf_id = user.get("bedrijf_id")
    user_id = user["id"]
    db.save_push_subscription(_json.dumps(subscription), bedrijf_id=bedrijf_id, user_id=user_id)
    print(f"[push] Subscription opgeslagen voor user {user_id} (bedrijf_id={bedrijf_id})")
    return {"ok": True}


@app.post("/api/push/test")
async def push_test(user=Depends(get_current_user)):
    """Stuurt een test-pushmelding naar de eigen toestellen van de ingelogde gebruiker."""
    subs = db.get_push_subscriptions_voor_user(user["id"], ook_digest=True)
    if user.get("bedrijf_id"):
        seen = {s["id"] for s in subs}
        for s in db.get_push_subscriptions_for_bedrijf(user["bedrijf_id"], ook_digest=True):
            if s["id"] not in seen:
                subs.append(s); seen.add(s["id"])
    verstuurd = 0
    for s in subs:
        try:
            if push_module.send_push(
                s["subscription"],
                "CIRQO testmelding",
                "Gelukt! Pushmeldingen werken op dit toestel. 🎉",
                "/check",
            ):
                verstuurd += 1
        except Exception as e:
            print(f"[push-test] {e}")
    return {"subscriptions": len(subs), "verstuurd": verstuurd}


@app.get("/api/push/debug")
async def push_debug(user=Depends(require_admin)):
    """Toon alle push subscriptions (alleen voor beheerders)."""
    with db.get_cursor() as cur:
        cur.execute("SELECT bedrijf_id, id, LEFT(subscription, 60) as sub_preview FROM push_subscriptions ORDER BY bedrijf_id")
        return [dict(r) for r in cur.fetchall()]


@app.get("/api/aanbiedingen")
async def get_aanbiedingen(gemeente: Optional[str] = None, user=Depends(require_admin)):
    g = _gemeente_filter(user, gemeente)
    return db.get_aanbiedingen_voor_beheer(g)


@app.get("/api/mijn-aanbiedingen-als-aanbieder")
async def mijn_aanbiedingen_als_aanbieder(user=Depends(get_current_user)):
    cache_key = f"mijn_aanbiedingen:{user['id']}"
    cached = cache_module.get(cache_key)
    if cached is not None:
        return cached
    data = db.get_aanbiedingen_door_user(user["id"])
    cache_module.set(cache_key, data, ttl=30)
    return data


@app.get("/api/mijn-aanbiedingen")
async def mijn_aanbiedingen(
    limit: int = 15, offset: int = 0, status: Optional[str] = None,
    user=Depends(get_current_user)
):
    if user["role"] != "bedrijf" or not user.get("bedrijf_id"):
        raise HTTPException(status_code=403)
    return db.get_aanbiedingen_voor_bedrijf(user["bedrijf_id"], limit=limit, offset=offset, status=status)


@app.patch("/api/mijn-aanbiedingen/{aanbieding_id}")
async def update_mijn_aanbieding(aanbieding_id: int, status: Optional[str] = Form(None),
                                  reden: Optional[str] = Form(None),
                                  user=Depends(get_current_user)):
    if not user.get("bedrijf_id"):
        raise HTTPException(status_code=403)
    # Eigendomscheck: alleen aanbiedingen aan het eigen bedrijf zijn muteerbaar
    with db.get_cursor() as cur:
        cur.execute("SELECT 1 FROM aanbiedingen WHERE id = %s AND bedrijf_id = %s",
                    (aanbieding_id, user["bedrijf_id"]))
        if not cur.fetchone():
            raise HTTPException(status_code=403, detail="Geen rechten op deze aanbieding")
    # Optionele reden bij 'niet nodig' (losse vervolg-call vanuit de reden-chips)
    if reden is not None:
        with db.get_cursor() as cur:
            cur.execute("UPDATE aanbiedingen SET niet_nodig_reden = %s WHERE id = %s",
                        (reden.strip()[:120], aanbieding_id))
        if not status:
            return {"ok": True}
    if not status:
        raise HTTPException(status_code=400, detail="status of reden vereist")
    if status not in ("ophalen", "niet_nodig"):
        raise HTTPException(status_code=400, detail="Ongeldige status")
    db.update_aanbieding_status(aanbieding_id, status, door_user=user["id"])
    fs.update_aanbieding_status(aanbieding_id, status)
    _invalideer_bedrijf_items(user.get("bedrijf_id"))   # reagerend bedrijf: eigen lijststatus wijzigt

    async def _afhandel():
        with db.get_cursor() as cur:
            cur.execute("SELECT aangeboden_door, item_id FROM aanbiedingen WHERE id = %s", (aanbieding_id,))
            row = cur.fetchone()
        if not row or not row["aangeboden_door"]:
            return
        offerer_id = row["aangeboden_door"]
        item_id    = row["item_id"]
        # Aanbieder-lijst direct vers: statuswissel zichtbaar in 'Mijn reacties'
        cache_module.delete_pattern(f"items:*:0:{offerer_id}")
        item       = db.get_item(item_id)
        label      = (item or {}).get("ai_label") or "materiaal"
        bedrijf_naam = user.get("username", "het bedrijf")

        if status == "niet_nodig":
            # Auto-doorsturen als aanbieder dat heeft ingesteld
            aanbieder = db.get_user_by_id(offerer_id)
            if aanbieder and aanbieder.get("auto_doorsturen"):
                gemeente = (item or {}).get("gemeente")
                category = (item or {}).get("category")
                volgend  = db.get_volgend_bedrijf(item_id, gemeente, category, user_id=offerer_id)
                if volgend:
                    nieuw_id = db.create_aanbieding(item_id, volgend["id"], user_id=offerer_id)
                    cache_module.delete(f"items:{gemeente}:0:{offerer_id}", f"items:None:0:{offerer_id}")
                    _invalideer_bedrijf_items(volgend["id"])   # doorgestuurd bedrijf
                    # Push naar aanbieder: doorgestuurd
                    subs = db.get_push_subscriptions_voor_user(offerer_id)
                    for sub in subs:
                        push_module.send_push(sub["subscription"],
                            title="Automatisch doorgestuurd",
                            body=f"{label} is doorgestuurd naar {volgend['naam']}",
                            url="/")
                    # Push naar volgend bedrijf
                    subscriptions = db.get_push_subscriptions_for_bedrijf(volgend["id"])
                    for sub in subscriptions:
                        push_module.send_push(sub["subscription"],
                            title="Nieuw aanbod",
                            body=f"Er is {label} beschikbaar voor jou",
                            url="/")
                    return  # geen "niet nodig" push meer nodig

        # Standaard push naar aanbieder
        status_tekst = "wil het ophalen 🚚" if status == "ophalen" else "heeft het niet nodig"
        subs = db.get_push_subscriptions_voor_user(offerer_id)
        for sub in subs:
            push_module.send_push(sub["subscription"],
                title=f"{bedrijf_naam} reageert",
                body=f"{bedrijf_naam} {status_tekst}: {label}",
                url="/")

    asyncio.create_task(_afhandel())
    return {"ok": True}


# ── Berichten ─────────────────────────────────────────────────────────────────

@app.get("/api/aanbiedingen/{aanbieding_id}/berichten")
async def get_berichten(aanbieding_id: int, user=Depends(get_current_user)):
    # Toegang: aanbieder, bedrijf dat de aanbieding ontving, of admin
    info = db.get_aanbieding_deelnemers(aanbieding_id)
    if not info:
        raise HTTPException(status_code=404)
    is_aanbieder = info.get("aangeboden_door") is not None and info.get("aangeboden_door") == user["id"]
    is_bedrijf   = user.get("bedrijf_id") is not None and user.get("bedrijf_id") == info.get("bedrijf_id")
    is_admin     = user["role"] in ("admin", "superadmin")
    if not (is_aanbieder or is_bedrijf or is_admin):
        raise HTTPException(status_code=403)
    return db.get_berichten(aanbieding_id)


@app.post("/api/aanbiedingen/{aanbieding_id}/berichten")
async def stuur_bericht(
    aanbieding_id: int,
    tekst: str = Form(...),
    user=Depends(get_current_user),
):
    if not tekst.strip():
        raise HTTPException(status_code=400, detail="Bericht mag niet leeg zijn")
    info = db.get_aanbieding_deelnemers(aanbieding_id)
    if not info:
        raise HTTPException(status_code=404)
    is_aanbieder = info.get("aangeboden_door") is not None and info.get("aangeboden_door") == user["id"]
    is_bedrijf   = user.get("bedrijf_id") is not None and user.get("bedrijf_id") == info.get("bedrijf_id")
    is_admin     = user["role"] in ("admin", "superadmin")
    if not (is_aanbieder or is_bedrijf or is_admin):
        raise HTTPException(status_code=403)

    naam = localStorage_naam = user.get("username", "onbekend")
    bericht = db.stuur_bericht(aanbieding_id, user["id"], tekst)

    # Items-caches van beide partijen verversen: bericht_count/last_bericht_at
    # zitten in de lijst (ongelezen-badge) en in de client-fingerprint
    _invalideer_bedrijf_items(info.get("bedrijf_id"))
    if info.get("aangeboden_door"):
        cache_module.delete_pattern(f"items:*:0:{info['aangeboden_door']}")

    # Push naar de andere partij op de achtergrond
    async def _push_bericht():
        label = info.get("ai_label") or "materiaal"
        print(f"[push-chat] is_bedrijf={is_bedrijf}, aanbieding={aanbieding_id}, label={label!r}")
        if is_bedrijf:
            offerer_id = info.get("aangeboden_door")
            print(f"[push-chat] bedrijf→aanbieder offerer_id={offerer_id}")
            if offerer_id:
                subs = db.get_push_subscriptions_voor_user(offerer_id)
                print(f"[push-chat] {len(subs)} sub(s) voor user {offerer_id}")
                for sub in subs:
                    ok = push_module.send_push(sub["subscription"],
                        title=f"Nieuw bericht over {label}",
                        body=f"{naam}: {tekst[:80]}", url="/")
                    print(f"[push-chat] verzonden: {'OK' if ok else 'MISLUKT'}")
                    if not ok:
                        db.delete_push_subscription(sub["subscription"])
        else:
            bedrijf_id_push = info.get("bedrijf_id")
            print(f"[push-chat] aanbieder→bedrijf bedrijf_id={bedrijf_id_push}")
            if bedrijf_id_push:
                subs = db.get_push_subscriptions_for_bedrijf(bedrijf_id_push)
                print(f"[push-chat] {len(subs)} sub(s) voor bedrijf {bedrijf_id_push}")
                for sub in subs:
                    ok = push_module.send_push(sub["subscription"],
                        title=f"Nieuw bericht over {label}",
                        body=f"{naam}: {tekst[:80]}", url="/")
                    print(f"[push-chat] verzonden: {'OK' if ok else 'MISLUKT'}")
                    if not ok:
                        db.delete_push_subscription(sub["subscription"])

    asyncio.create_task(_push_bericht())
    return {**bericht, "user_id": user["id"],
            "naam": naam, "tekst": tekst.strip()}


# ── Inzamellijst ─────────────────────────────────────────────────────────────

@app.get("/api/inzamellijst")
async def get_inzamellijst(gemeente: Optional[str] = None, user=Depends(require_admin)):
    g = _gemeente_filter(user, gemeente) or user.get("gemeente") or ""
    if not g:
        raise HTTPException(status_code=400, detail="Gemeente vereist")
    return db.get_inzamellijst(g)


@app.post("/api/inzamellijst")
async def add_inzamellijst(
    product: str = Form(...),
    gemeente: Optional[str] = Form(None),
    user=Depends(require_admin),
):
    g = gemeente.strip() if gemeente and gemeente.strip() else user.get("gemeente") or ""
    if not g:
        raise HTTPException(status_code=400, detail="Gemeente vereist")
    if not product.strip():
        raise HTTPException(status_code=400, detail="Product mag niet leeg zijn")
    entry_id = db.add_to_inzamellijst(g, product)
    return {"id": entry_id, "product": product.strip(), "gemeente": g}


@app.put("/api/inzamellijst")
async def set_inzamellijst(request: Request, user=Depends(require_admin)):
    """Vervangt de volledige inzamellijst voor een gemeente (bulk)."""
    data = await request.json()
    g = (data.get("gemeente") or "").strip() or user.get("gemeente") or ""
    if not g:
        raise HTTPException(status_code=400, detail="Gemeente vereist")
    producten = [str(p).strip() for p in data.get("producten", []) if str(p).strip()]
    db.set_inzamellijst(g, producten)
    return {"ok": True, "count": len(producten)}


@app.delete("/api/inzamellijst/{entry_id}")
async def delete_inzamellijst(entry_id: int, gemeente: Optional[str] = None, user=Depends(require_admin)):
    g = _gemeente_filter(user, gemeente) or user.get("gemeente") or ""
    if not g:
        raise HTTPException(status_code=400, detail="Gemeente vereist")
    db.remove_from_inzamellijst(entry_id, g)
    return {"ok": True}


# ── Upload ────────────────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload(
    files: List[UploadFile] = File(...),
    manual_note: Optional[str] = Form(None),
    category: Optional[str] = Form(None),
    gemeente_override: Optional[str] = Form(None),
    user=Depends(get_current_user),
):
    try:
        import json as _json
        from PIL import Image, ImageOps
        import io as _io
        files = (files or [])[:4]   # maximaal 4 foto's
        if not files:
            raise HTTPException(status_code=400, detail="Geen foto ontvangen")
        contents = []
        for f in files:
            raw = await f.read()
            if not raw:
                continue
            try:
                img = Image.open(_io.BytesIO(raw))
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")
                if img.width > 512:
                    ratio = 512 / img.width
                    img = img.resize((512, int(img.height * ratio)), Image.LANCZOS)
                buf = _io.BytesIO()
                img.save(buf, format="JPEG", quality=72)
                raw = buf.getvalue()
            except Exception as e:
                print(f"[upload] Resize overgeslagen: {e}")
            contents.append(raw)
        if not contents:
            raise HTTPException(status_code=400, detail="Geen geldige foto")

        image_b64 = base64.b64encode(contents[0]).decode("utf-8")
        loop = asyncio.get_event_loop()
        # GPS-gemeente heeft voorrang boven account-gemeente
        gemeente = gemeente_override.strip() if gemeente_override and gemeente_override.strip() else (user.get("gemeente") or None)

        # Inzamellijst ophalen: eerst specifieke gemeente, dan fallback op alles
        inzamellijst_items = []
        if gemeente:
            inzamellijst_items = [e["product"] for e in db.get_inzamellijst(gemeente)]
        if not inzamellijst_items:
            # Geen gemeente of geen lijst voor dit gemeente → alle producten als fallback
            inzamellijst_items = [e["product"] for e in db.get_inzamellijst_alle()]

        _analyse = loop.run_in_executor(None, ai_module.analyse_photo, image_b64, inzamellijst_items)
        _uploads = [loop.run_in_executor(None, storage_module.upload_photo, c) for c in contents]
        _results = await asyncio.gather(_analyse, *_uploads)
        (label, detail, gewicht_kg, ai_category, geaccepteerd) = _results[0]
        photo_url_list = list(_results[1:])
        photo_url = photo_url_list[0]

        item_id = db.insert_item(photo_url, label, detail, gewicht_kg, gemeente, True,
                                 uploaded_by=user["id"],
                                 photo_urls=_json.dumps(photo_url_list) if len(photo_url_list) > 1 else None)
        # Gebruik AI-categorie tenzij handmatig overschreven
        final_category = category if category else ai_category
        if manual_note or final_category:
            db.update_item(item_id, manual_note, final_category)
        item = db.get_item(item_id)
        fs.sync_item(item)
        # Cache invalideren met org-expanded gemeenten zodat key matcht
        gemeenten_exp = _gemeenten_expand(user.get("gemeente"))
        user_gem = user.get("gemeente") or gemeente
        cache_module.delete(
            f"items:{gemeenten_exp or user_gem}:0:{user['id']}",
            f"items:None:0:{user['id']}",
            f"stats:{gemeente}", "stats:None"
        )
        _invalideer_bedrijf_items(user.get("bedrijf_id"))   # scanner-bedrijf: eigen nieuw item
        # Bedrijven ophalen op basis van account-gemeente (niet GPS), org-expanded
        acct_gemeente = user.get("gemeente") or None
        acct_gemeenten = _gemeenten_expand(acct_gemeente)
        alle_bedrijven = db.get_bedrijven(None if acct_gemeenten else acct_gemeente, gemeenten=acct_gemeenten)
        if user.get("bedrijf_id"):
            alle_bedrijven = [b for b in alle_bedrijven if b["id"] != user["bedrijf_id"]]
        if final_category:
            match_ids = {b["id"] for b in db.get_bedrijven_for_item(acct_gemeente, final_category, gemeenten=acct_gemeenten)}
            if not match_ids:
                match_ids = {b["id"] for b in db.get_bedrijven_for_item(None, final_category)}
        else:
            match_ids = set()
        for b in alle_bedrijven:
            b["categorie_match"] = b["id"] in match_ids
        alle_bedrijven.sort(key=lambda b: (not b["categorie_match"], b["naam"]))
        item["bedrijven"] = alle_bedrijven
        print(f"[main] Item {item_id}: {label} ({gewicht_kg} kg) [{gemeente}]")
        return item

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[upload] FOUT: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Items ─────────────────────────────────────────────────────────────────────

@app.get("/api/items")
async def list_items(limit: int = 200, offset: int = 0, gemeente: Optional[str] = None, user=Depends(get_current_user)):
    bedrijf_id = user.get("bedrijf_id")
    if bedrijf_id:
        # Per (bedrijf, gebruiker): 'ontvangen' is gedeeld binnen het bedrijf,
        # 'eigen' scans zijn per gebruiker. Cache dus op beide. Invalidatie gebeurt
        # gericht bij elke mutatie (aanbieding maken/status/scan) via
        # _invalideer_bedrijf_items — de 60s-TTL is enkel een vangnet.
        bedrijf_cache_key = f"items:bedrijf2:{bedrijf_id}:{user['id']}"
        cached = cache_module.get(bedrijf_cache_key)
        if cached is not None:
            return cached
        # Items aangeboden ÁÁN dit bedrijf
        ontvangen = db.get_items_voor_bedrijf(bedrijf_id)
        # Plus strikt de éígen scans van dit account — nooit gemeente-breed:
        # een afnemer hoort niet te zien wat anderen scannen of aangeboden krijgen
        user_id = user["id"]
        eigen = db.get_items(200, 0, None, user_id=user_id, own_user_id=user_id, alleen_eigen=True)
        ontvangen_ids = {i["id"] for i in ontvangen}
        extra = [i for i in eigen if i["id"] not in ontvangen_ids]
        result = ontvangen + extra
        # Lange TTL is veilig: élk mutatiepunt invalideert gericht
        # (_invalideer_bedrijf_items / _invalideer_item_caches)
        cache_module.set(bedrijf_cache_key, result, ttl=3600)
        return result
    gemeente = _gemeente_filter(user, gemeente)
    gemeenten = _gemeenten_expand(gemeente)
    user_id = user["id"]
    is_admin = user["role"] in ("admin", "superadmin")
    # Scanner always sees their own items regardless of GPS gemeente
    own_user_id = user_id if user["role"] == "user" else None
    cache_key = f"items:{gemeenten or gemeente}:{offset}:{user_id}"
    cached = cache_module.get(cache_key)
    if cached is not None:
        return cached
    items = db.get_items(limit, offset, None if gemeenten else gemeente, user_id=user_id, gemeenten=gemeenten, own_user_id=own_user_id, all_aanbiedingen=is_admin)
    # Lange TTL is veilig: mutaties invalideren gericht (o.a. items:*:0:{user_id})
    cache_module.set(cache_key, items, ttl=3600)
    return items


@app.get("/api/items/{item_id}")
async def get_item(item_id: int, user=Depends(get_current_user)):
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404)
    if not _mag_item_beheren(user, item):
        # Bedrijf mag een item zien dat aan hem is aangeboden
        bid = user.get("bedrijf_id")
        if not (bid and any(a.get("bedrijf_id") == bid
                            for a in db.get_aanbiedingen_voor_item(item_id))):
            raise HTTPException(status_code=403, detail="Geen rechten voor dit item")
    return item


@app.get("/api/items/{item_id}/aanbiedingen")
async def get_item_aanbiedingen(item_id: int, user=Depends(get_current_user)):
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404)
    # Alleen wie het item beheert (eigenaar/aanbieder of admin-in-scope) mag de
    # aanbiedingen ervan zien; anders lekken bedrijfsnamen over gemeentegrenzen.
    if not _mag_item_beheren(user, item):
        # Bedrijf mag wél zijn eigen aanbieding op dit item zien
        if user.get("bedrijf_id"):
            eigen = [a for a in db.get_aanbiedingen_voor_item(item_id)
                     if a.get("bedrijf_id") == user["bedrijf_id"]]
            if eigen:
                return eigen
        raise HTTPException(status_code=403, detail="Geen rechten voor dit item")
    return db.get_aanbiedingen_voor_item(item_id)


@app.patch("/api/aanbiedingen/{aanbieding_id}/status")
async def update_aanbieding_status_admin(
    aanbieding_id: int,
    status: str = Form(...),
    user=Depends(get_current_user),
):
    if status not in ("open", "ophalen", "niet_nodig"):
        raise HTTPException(status_code=400, detail="Ongeldige status")
    info = db.get_aanbieding_deelnemers(aanbieding_id)
    if not info:
        raise HTTPException(status_code=404)
    is_aanbieder = info.get("aangeboden_door") is not None and info.get("aangeboden_door") == user["id"]
    is_bedrijf   = user.get("bedrijf_id") is not None and user.get("bedrijf_id") == info.get("bedrijf_id")
    if not (is_aanbieder or is_bedrijf or user["role"] in ("admin", "superadmin")):
        raise HTTPException(status_code=403, detail="Geen rechten voor deze aanbieding")
    db.update_aanbieding_status(aanbieding_id, status, door_user=user["id"])
    fs.update_aanbieding_status(aanbieding_id, status)
    _invalideer_bedrijf_items(info.get("bedrijf_id"))
    if info.get("aangeboden_door"):
        cache_module.delete_pattern(f"items:*:0:{info['aangeboden_door']}")
    return {"ok": True}


@app.patch("/api/items/{item_id}")
async def update_item(
    item_id: int,
    manual_note: Optional[str] = Form(None),
    category: Optional[str] = Form(None),
    ai_detail: Optional[str] = Form(None),
    ai_label: Optional[str] = Form(None),
    user=Depends(get_current_user),
):
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404)
    if not _mag_item_beheren(user, item):
        raise HTTPException(status_code=403, detail="Geen rechten voor dit item")
    db.update_item(item_id, manual_note, category, ai_detail=ai_detail, ai_label=ai_label)
    fs.sync_item(db.get_item(item_id))   # aangepaste titel/beschrijving ook naar de app-kant
    _invalideer_item_caches(item_id, item)
    cache_module.delete(f"items:{_gemeenten_expand(user.get('gemeente')) or user.get('gemeente')}:0:{user['id']}",
                        f"items:None:0:{user['id']}")
    return {"ok": True}


@app.delete("/api/items/{item_id}")
async def delete_item(item_id: int, user=Depends(get_current_user)):
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404)
    if not _mag_item_beheren(user, item):
        raise HTTPException(status_code=403, detail="Geen rechten voor dit item")
    _invalideer_item_caches(item_id, item)   # vóór de delete (aanbiedingen-lookup)
    db.delete_item(item_id)
    fs.delete_item(item_id)
    gemeente = _gemeente_filter(user)
    cache_module.delete(f"items:{gemeente}:0:{user['id']}", f"items:None:0:{user['id']}", f"stats:{gemeente}", "stats:None")
    _invalideer_bedrijf_items(user.get("bedrijf_id"))
    return {"ok": True}


# ── Dashboard (gecombineerd endpoint) ────────────────────────────────────────

async def _bouw_dashboard_data(gemeente, gemeenten, days: int = 7):
    g = None if gemeenten else gemeente
    loop = asyncio.get_event_loop()
    stats, charts, recent = await asyncio.gather(
        loop.run_in_executor(None, lambda: db.get_stats(g, gemeenten=gemeenten)),
        loop.run_in_executor(None, lambda: db.get_chart_data(days, g, gemeenten=gemeenten)),
        loop.run_in_executor(None, lambda: db.get_items(6, 0, g, gemeenten=gemeenten)),
    )
    result = {"stats": stats, "charts": charts, "recent": recent}
    cache_module.set(f"dashboard:{gemeenten or gemeente}:{days}", result, ttl=150)
    return result


async def _bouw_netwerk_data(g, gemeenten):
    data = await asyncio.get_event_loop().run_in_executor(None, lambda: db.get_netwerk_data(g, gemeenten))
    cache_module.set(f"netwerk:{gemeenten or g}", data, ttl=150)
    return data


DIGEST_UUR = 16   # 16:00 NL-tijd — einde werkdag milieustraat

def _verstuur_digests():
    """Eén samenvattingspush per dag per gebruiker die dat zo heeft ingesteld."""
    from datetime import datetime, timedelta, timezone
    for u in db.get_digest_gebruikers():
        try:
            sinds = u.get("digest_verstuurd_op") or (datetime.now(timezone.utc) - timedelta(hours=24))
            samenvatting = db.get_digest_samenvatting(u["id"], u.get("bedrijf_id"), sinds)
            db.markeer_digest_verstuurd(u["id"])   # ook bij niets: geen herhaalpogingen vandaag
            delen = []
            n = samenvatting["aanbiedingen"]
            if n: delen.append(f"{n} nieuwe aanbieding{'en' if n != 1 else ''}")
            m = samenvatting["berichten"]
            if m: delen.append(f"{m} nieuw{'e berichten' if m != 1 else ' bericht'}")
            if not delen:
                continue   # stille dag → geen melding
            body = " en ".join(delen) + " — open de app voor de details."
            subs = db.get_push_subscriptions_voor_user(u["id"], ook_digest=True)
            for sub in subs:
                ok = push_module.send_push(sub["subscription"],
                    title="Je dagelijkse CIRQO-samenvatting", body=body, url="/")
                if not ok:
                    db.delete_push_subscription(sub["subscription"])
            print(f"[digest] user {u['id']}: {body!r} naar {len(subs)} toestel(len)")
        except Exception as e:
            try: db.registreer_fout(f"digest-user:{u['id']}", str(e))
            except Exception: pass


async def _digest_loop():
    """Controleert elke 10 minuten of de dagelijkse samenvatting eruit moet."""
    from zoneinfo import ZoneInfo
    await asyncio.sleep(90)
    while True:
        try:
            nu_nl = datetime.now(ZoneInfo("Europe/Amsterdam"))
            if nu_nl.hour >= DIGEST_UUR:
                await asyncio.get_event_loop().run_in_executor(None, _verstuur_digests)
        except Exception as e:
            try: db.registreer_fout("digest-loop", str(e))
            except Exception: pass
        await asyncio.sleep(600)


async def _prewarm_cache_loop():
    """Houd dashboard- en netwerkcaches proactief warm (elke 60s, TTL 150s),
    zodat gebruikers nooit de koude 2-3s-route voelen."""
    await asyncio.sleep(5)
    while True:
        try:
            scopes = set()
            with db.get_cursor() as cur:
                cur.execute("SELECT DISTINCT gemeente FROM items WHERE gemeente IS NOT NULL AND gemeente != ''")
                scopes.update(r["gemeente"] for r in cur.fetchall())
            scopes.update(ORGANISATIE_GEMEENTEN.keys())
            scopes.add(None)   # superadmin zonder filter
            for g in scopes:
                await _bouw_dashboard_data(g, _gemeenten_expand(g))
                await _bouw_netwerk_data(g, _gemeenten_expand(g) or ([g] if g else None))
        except Exception as e:
            print(f"[prewarm] Fout: {e}")
        await asyncio.sleep(60)


@app.get("/api/dashboard")
async def get_dashboard(days: int = 7, gemeente: Optional[str] = None, user=Depends(get_current_user)):
    # Bedrijfsaccounts zien alleen hun eigen stromen (geen gemeente-totalen)
    if user.get("bedrijf_id"):
        cache_key = f"dashboard-bedrijf:{user['bedrijf_id']}"
        cached = cache_module.get(cache_key)
        if cached is not None:
            return cached
        data = await asyncio.get_event_loop().run_in_executor(
            None, lambda: db.get_bedrijf_dashboard(user["bedrijf_id"]))
        cache_module.set(cache_key, data, ttl=60)
        return data
    gemeente = _gemeente_filter(user, gemeente)
    gemeenten = _gemeenten_expand(gemeente)
    cached = cache_module.get(f"dashboard:{gemeenten or gemeente}:{days}")
    if cached is not None:
        return cached
    return await _bouw_dashboard_data(gemeente, gemeenten, days)


# ── Statistieken & export ─────────────────────────────────────────────────────

@app.get("/api/mijn-volgorde")
async def get_mijn_volgorde(user=Depends(get_current_user)):
    return db.get_volgorde(user["id"])


@app.put("/api/mijn-volgorde")
async def sla_mijn_volgorde(request: Request, user=Depends(get_current_user)):
    bedrijf_ids = await request.json()
    if not isinstance(bedrijf_ids, list):
        raise HTTPException(status_code=400)
    db.sla_volgorde_op(user["id"], [int(i) for i in bedrijf_ids])
    return {"ok": True}


@app.get("/api/netwerk")
async def get_netwerk(gemeente: Optional[str] = None, user=Depends(get_current_user)):
    # Zichtbaar voor gemeente-/milieustraat-accounts; NIET voor bedrijven
    # (matchgegevens van andere bedrijven zijn niet hun zaak)
    if user.get("bedrijf_id") or user["role"] == "bedrijf":
        raise HTTPException(status_code=403, detail="Niet beschikbaar voor bedrijfsaccounts")
    g = _gemeente_filter(user, gemeente)
    # Organisatie-scope (bv. 'waardlanden') uitklappen naar de losse gemeenten
    gemeenten = _gemeenten_expand(g) or ([g] if g else None)
    cached = cache_module.get(f"netwerk:{gemeenten or g}")
    if cached is not None:
        return cached
    return await _bouw_netwerk_data(g, gemeenten)


@app.get("/api/deelnemers")
async def get_deelnemers(user=Depends(get_current_user)):
    """Alle deelnemende bedrijven in het netwerk — zichtbaar voor ingelogde bedrijfsaccounts."""
    gemeente = user.get("gemeente", "")
    gemeenten = _gemeenten_expand(gemeente)
    with db.get_cursor() as cur:
        if gemeenten:
            cur.execute("""
                SELECT b.id, b.naam, b.gemeente, b.email, b.telefoon,
                       COALESCE(array_agg(DISTINCT bc.category)
                         FILTER (WHERE bc.category IS NOT NULL), '{}') AS categorieen,
                       COUNT(DISTINCT a.id) FILTER (WHERE a.status != 'niet_nodig') AS aanbieding_count
                FROM bedrijven b
                LEFT JOIN bedrijf_categorieen bc ON bc.bedrijf_id = b.id
                LEFT JOIN aanbiedingen a ON a.bedrijf_id = b.id
                WHERE b.gemeente = ANY(%s)
                GROUP BY b.id
                ORDER BY b.naam
            """, (gemeenten,))
        else:
            cur.execute("""
                SELECT b.id, b.naam, b.gemeente, b.email, b.telefoon,
                       COALESCE(array_agg(DISTINCT bc.category)
                         FILTER (WHERE bc.category IS NOT NULL), '{}') AS categorieen,
                       COUNT(DISTINCT a.id) FILTER (WHERE a.status != 'niet_nodig') AS aanbieding_count
                FROM bedrijven b
                LEFT JOIN bedrijf_categorieen bc ON bc.bedrijf_id = b.id
                LEFT JOIN aanbiedingen a ON a.bedrijf_id = b.id
                WHERE b.gemeente = %s
                GROUP BY b.id
                ORDER BY b.naam
            """, (gemeente,))
        return {"gemeente": gemeente, "bedrijven": [dict(r) for r in cur.fetchall()]}


@app.get("/api/stats")
async def get_stats(gemeente: Optional[str] = None, user=Depends(get_current_user)):
    bedrijf_id = user.get("bedrijf_id")
    if bedrijf_id:
        items = db.get_items_voor_bedrijf(bedrijf_id)
        totaal_kg = sum(i["gewicht_kg"] or 0 for i in items)
        from collections import Counter
        cat_counts = Counter(i["category"] for i in items if i.get("category"))
        categories = [{"category": k, "count": v} for k, v in cat_counts.most_common()]
        return {"total": len(items), "today": 0, "totaal_kg": round(totaal_kg, 1), "categories": categories}
    if user["role"] == "superadmin":
        # Superadmin: vrij filteren op gemeente
        pass
    elif user["role"] in ("admin",):
        gemeente = _gemeente_filter(user, gemeente)
    else:
        # Gewone gebruiker: alleen eigen aangeboden items
        data = db.get_stats(user_id=user["id"])
        return data
    gemeenten = _gemeenten_expand(gemeente)
    cache_key = f"stats:{gemeenten or gemeente}"
    cached = cache_module.get(cache_key)
    if cached is not None:
        return cached
    g = None if gemeenten else gemeente
    data = db.get_stats(g, gemeenten=gemeenten)
    cache_module.set(cache_key, data, ttl=30)
    return data


@app.get("/api/charts")
async def get_charts(days: int = 30, gemeente: Optional[str] = None, user=Depends(get_current_user)):
    gemeente = _gemeente_filter(user, gemeente)
    gemeenten = _gemeenten_expand(gemeente)
    cache_key = f"charts:{gemeenten or gemeente}:{days}"
    cached = cache_module.get(cache_key)
    if cached is not None:
        return cached
    g = None if gemeenten else gemeente
    data = db.get_chart_data(days, g, gemeenten=gemeenten)
    cache_module.set(cache_key, data, ttl=60)
    return data


@app.get("/api/export/csv")
async def export_csv(gemeente: Optional[str] = None, user=Depends(require_admin)):
    csv_data = db.export_csv(_gemeente_filter(user, gemeente))
    fname = f"bouwkringloop_{gemeente or 'alle'}_{datetime.now().strftime('%Y%m%d')}.csv"
    return Response(
        content=csv_data.encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


# ── Pagina's ──────────────────────────────────────────────────────────────────

from fastapi.responses import FileResponse
import mimetypes

@app.get("/static/{path:path}")
async def static_files(path: str):
    file_path = f"static/{path}"
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404)
    media_type, _ = mimetypes.guess_type(file_path)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".html",):
        cache = "no-store"
    elif path == "manifest.json":
        # Manifest bepaalt install-kleuren/naam/iconen: altijd hervalideren,
        # anders installeren toestellen dagen later nog de oude huisstijl
        cache = "no-cache"
    elif ext in (".png", ".webp", ".jpg", ".jpeg", ".svg", ".ico", ".woff2"):
        cache = "public, max-age=604800, immutable"  # 7 dagen
    else:
        cache = "public, max-age=86400"  # 1 dag voor css/js
    return FileResponse(file_path, media_type=media_type or "application/octet-stream",
                        headers={"Cache-Control": cache})


@app.get("/sw.js")
async def service_worker():
    with open("static/sw.js", "r", encoding="utf-8") as f:
        return Response(content=f.read(), media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


DEFAULT_BRAND = os.getenv("BRAND", "cirqo")

# Hostnames die een specifiek brand activeren (ook als substring)
HOST_BRAND_MAP = {}


def _detect_brand(request: Request) -> str:
    host = request.headers.get("host", "").lower().split(":")[0]
    for keyword, brand in HOST_BRAND_MAP.items():
        if keyword in host:
            return brand
    return DEFAULT_BRAND


@app.get("/", response_class=HTMLResponse)
async def scan_app(request: Request):
    return _render_html("static/index.html", _detect_brand(request))


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return _render_html("static/login.html", _detect_brand(request))


@app.get("/auth-action", response_class=HTMLResponse)
async def auth_action_page(request: Request):
    return _render_html("static/auth-action.html", _detect_brand(request))


@app.get("/beheer", response_class=HTMLResponse)
async def beheer_page(request: Request):
    return _render_html("static/beheer.html", _detect_brand(request))


@app.get("/debug-brand")
async def debug_brand(request: Request):
    import os as _os2
    detected = _detect_brand(request)
    return {"DEFAULT_BRAND": DEFAULT_BRAND, "detected_brand": detected, "host": request.headers.get("host"), "BRAND_ENV": _os2.getenv("BRAND")}


@app.get("/.well-known/assetlinks.json")
async def assetlinks():
    """Digital Asset Links: koppelt de Play Store-app (TWA-schil) aan dit domein,
    zodat hij zonder browserbalk opent. Vingerafdrukken = upload- + Play-signing-
    certificaat van de bestaande CIRQO-app (uit Firebase, project database-e5575)."""
    return [{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": "com.cirqoapp.ios",
            "sha256_cert_fingerprints": [
                "07:B9:2E:02:75:D5:E2:F3:B3:51:EF:6C:44:C5:A6:74:C3:6B:E6:F4:36:9F:01:E0:13:34:AF:A3:7B:6D:6E:EF",
                "5F:D6:9F:19:1D:29:76:6B:26:CC:9E:30:2C:F8:3B:1A:FB:FD:D2:E9:02:B6:31:13:06:2F:A4:94:3E:59:93:F0",
                # Nieuwe upload-sleutel (cirqo-playstore, jul 2026)
                "2B:2D:C9:81:B9:86:B6:A1:74:34:7D:12:3A:2A:82:8C:7C:B9:C9:55:5D:31:6E:A6:18:F7:64:15:D5:49:7D:32",
            ],
        },
    }]


@app.get("/privacy", response_class=HTMLResponse)
async def privacy_page():
    """Privacyverklaring — verplicht veld voor App Store en Play Store."""
    return _render_html("static/privacy.html", DEFAULT_BRAND)


@app.get("/voorwaarden", response_class=HTMLResponse)
async def voorwaarden_page():
    """Algemene voorwaarden — bereikbaar via Over CIRQO in het accountpaneel."""
    return _render_html("static/voorwaarden.html", DEFAULT_BRAND)


@app.get("/installeren", response_class=HTMLResponse)
async def installeren_page(request: Request):
    """Openbare installatiepagina — voor mails en de QR-poster op de milieustraat."""
    return _render_html("static/installeren.html", _detect_brand(request))


@app.get("/bedrijf", response_class=HTMLResponse)
async def bedrijf_page(request: Request):
    # Kale pagina zonder token is een pilot-restant → naar de normale login.
    # De token-variant hieronder blijft werken (oude partnerlinks).
    return RedirectResponse("/login", status_code=302)


@app.get("/bedrijf/{token}", response_class=HTMLResponse)
async def bedrijf_page_token(token: str, request: Request):
    return _render_html("static/bedrijf.html", _detect_brand(request))



import os as _os, hashlib as _hashlib
_THUMB_DIR = "/tmp/thumbs"
_os.makedirs(_THUMB_DIR, exist_ok=True)

def _firebase_thumb_url(original_url: str) -> str:
    """Transform a Firebase Storage URL to its _1024x1024 resized variant."""
    import re, urllib.parse
    # Extract path from Firebase Storage URL
    # https://firebasestorage.googleapis.com/v0/b/BUCKET/o/PATH?alt=media&token=...
    m = re.match(r'(https://firebasestorage\.googleapis\.com/v0/b/[^/]+/o/)([^?]+)(\?.*)?', original_url)
    if not m:
        return original_url
    base, encoded_path, _ = m.group(1), m.group(2), m.group(3)
    path = urllib.parse.unquote(encoded_path)
    if not path.endswith('.jpg'):
        return original_url
    thumb_path = path[:-4] + '_1024x1024.jpg'
    return base + urllib.parse.quote(thumb_path, safe='') + '?alt=media'


def _thumb_url_toegestaan(u: str) -> bool:
    """Sta alleen https-URLs van vertrouwde opslag-hosts toe (tegen SSRF)."""
    try:
        from urllib.parse import urlparse
        p = urlparse(u or "")
        if p.scheme != "https":
            return False
        host = (p.hostname or "").lower()
        if host in ("firebasestorage.googleapis.com", "storage.googleapis.com"):
            return True
        if host.endswith(".supabase.co") or host.endswith(".supabase.in"):
            return True
        return False
    except Exception:
        return False


@app.get("/api/thumb")
async def get_thumb(url: str, size: int = 400, user=Depends(get_current_user)):
    import ssl, urllib.request, io
    from PIL import Image
    from fastapi.responses import Response

    if not _thumb_url_toegestaan(url):
        raise HTTPException(status_code=400, detail="Ongeldige URL")

    cache_key = _hashlib.md5(f"{url}{size}".encode()).hexdigest()
    thumb_path = f"{_THUMB_DIR}/{cache_key}.jpg"

    if _os.path.exists(thumb_path):
        with open(thumb_path, "rb") as f:
            return Response(content=f.read(), media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=604800"})

    # TLS-verificatie AAN (default context)
    ssl_ctx = ssl.create_default_context()

    # Try the _1024x1024 Firebase variant first (much smaller, no resize needed)
    thumb_url = _firebase_thumb_url(url)
    fetch_url = thumb_url if thumb_url != url else url
    need_resize = (fetch_url == url)

    try:
        with urllib.request.urlopen(fetch_url, timeout=10, context=ssl_ctx) as r:
            data = r.read()
    except Exception:
        if fetch_url != url:
            # Fallback to original
            try:
                with urllib.request.urlopen(url, timeout=10, context=ssl_ctx) as r:
                    data = r.read()
                need_resize = True
            except Exception as e:
                raise HTTPException(status_code=502, detail=str(e))
        else:
            raise HTTPException(status_code=502, detail="fetch failed")

    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        if need_resize:
            img.thumbnail((size, size), Image.LANCZOS)
        else:
            img.thumbnail((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=82)
        result = buf.getvalue()
        with open(thumb_path, "wb") as f:
            f.write(result)
        return Response(content=result, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=604800"})
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/tuya/test/{kleur}")
async def tuya_test(kleur: str, user=Depends(require_admin)):
    import tuya as t
    if kleur == "wit":
        return t.lamp_groen()
    elif kleur == "oranje":
        return t.lamp_rood()
    elif kleur == "uit":
        return t.lamp_uit()
    elif kleur == "status":
        return t.lamp_status()
    elif kleur == "functies":
        return t.lamp_functies()
    raise HTTPException(status_code=400, detail="wit / oranje / uit / status / functies")


# Kiosk draait op een onbeheerd apparaat zonder login; de sleutel in de URL
# (bookmark op het kiosk-apparaat) voorkomt dat de AI-analyse publiek misbruikt
# kan worden. Zonder KIOSK_TOKEN in de omgeving staat de kiosk uit.
KIOSK_TOKEN = os.getenv("KIOSK_TOKEN", "")
_KIOSK_SCANS: dict = {}   # ip → [timestamps], max 12 scans/minuut


@app.get("/kiosk", response_class=HTMLResponse)
async def kiosk_page(key: str = ""):
    if not KIOSK_TOKEN:
        raise HTTPException(status_code=503, detail="Kiosk is niet geconfigureerd")
    if key != KIOSK_TOKEN:
        raise HTTPException(status_code=403, detail="Ongeldige kiosk-sleutel")
    resp = _render_html("static/kiosk.html", DEFAULT_BRAND)
    html = resp.body.decode("utf-8").replace(
        "</head>", f'<script>window._KIOSK_KEY="{KIOSK_TOKEN}";</script></head>', 1)
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})


@app.post("/api/kiosk/scan")
async def kiosk_scan(request: Request, file: UploadFile = File(...), gemeente: str = Form("Almere")):
    import base64, asyncio
    from PIL import Image, ImageOps
    import io as _io
    import time as _t

    if not KIOSK_TOKEN or request.headers.get("X-Kiosk-Key", "") != KIOSK_TOKEN:
        raise HTTPException(status_code=401, detail="Kiosk-sleutel ontbreekt of is ongeldig")
    ip = request.client.host if request.client else "?"
    nu = _t.time()
    recent = [t for t in _KIOSK_SCANS.get(ip, []) if nu - t < 60]
    if len(recent) >= 12:
        raise HTTPException(status_code=429, detail="Te veel scans — wacht even")
    recent.append(nu)
    _KIOSK_SCANS[ip] = recent

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Foto te groot (max 10 MB)")
    try:
        img = Image.open(_io.BytesIO(content))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        if img.width > 768:
            ratio = 768 / img.width
            img = img.resize((768, int(img.height * ratio)), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        content = buf.getvalue()
    except Exception as e:
        print(f"[kiosk] resize fout: {e}")

    image_b64 = base64.b64encode(content).decode("utf-8")
    inzamellijst_items = [e["product"] for e in db.get_inzamellijst(gemeente)]
    if not inzamellijst_items:
        inzamellijst_items = [e["product"] for e in db.get_inzamellijst_alle()]

    loop = asyncio.get_event_loop()
    label, detail, gewicht_kg, category, geaccepteerd = await loop.run_in_executor(
        None, ai_module.analyse_photo, image_b64, inzamellijst_items
    )

    # Lamp aansturen — fire and forget
    import tuya as tuya_module
    async def stuur_lamp():
        try:
            if geaccepteerd:
                await loop.run_in_executor(None, tuya_module.lamp_groen)
            else:
                await loop.run_in_executor(None, tuya_module.lamp_rood)
        except Exception as e:
            print(f"[tuya] lamp fout: {e}")
    asyncio.create_task(stuur_lamp())

    return {
        "geaccepteerd": bool(geaccepteerd),
        "label": label or "Onbekend",
        "detail": detail or "",
        "gewicht_kg": gewicht_kg,
        "category": category,
    }


BRANDS = {
    "cirqo": {
        "primary": "#86bc97", "secondary": "#6aaa82",
        "logo": "/static/cirqo-logo.webp", "name": "CIRQO",
        "sub": "Digitaal productuitwisselingsnetwerk", "gemeente": "Almere",
    },
    "bouwkringloop": {
        "primary": "#e67026", "secondary": "#c45c1a",
        "logo": "/static/bouwkringloop-logo.jpg", "name": "De Bouwkringloop",
        "sub": "Milieustraat Almere-Buiten", "gemeente": "",
    },
    "rwm": {
        "primary": "#F5C200", "secondary": "#D4A800",
        "logo": "/static/rwm-logo.svg", "name": "RWM",
        "sub": "afval & reiniging", "gemeente": "Roermond",
    },
}

def _brand_css(brand: str) -> str:
    b = BRANDS.get(brand, BRANDS["cirqo"])
    return f""":root {{ --orange: {b['primary']}; --orange2: {b['secondary']}; }}
.hdr-logo-img, .cat-logo, .kiosk-logo {{ content: url('{b['logo']}') !important; }}"""

import glob as _glob, re as _re

def _compute_asset_version() -> str:
    """Versietoken voor cache-busting: nieuwste wijzigingstijd van alle JS/CSS.
    Verandert vanzelf bij elke deploy waarin een asset gewijzigd is."""
    try:
        files = _glob.glob("static/*.js") + _glob.glob("static/*.css")
        return str(int(max(os.path.getmtime(f) for f in files)))
    except Exception:
        return "1"

ASSET_VERSION = _compute_asset_version()


def _render_html(path: str, brand: str) -> HTMLResponse:
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    b = BRANDS.get(brand, BRANDS["cirqo"])
    # Inject brand CSS + app-versie (voor auto-update) inline
    head_inject = f'<style>{_brand_css(brand)}</style>\n<script>window._APP_VERSION="{ASSET_VERSION}";</script>'
    html = html.replace("</head>", f"{head_inject}\n</head>", 1)
    # Automatische cache-busting: vers versienummer op alle /static/*.js en *.css
    # let op: (?![\w]) voorkomt dat .js binnen .json/.jsonld matcht (zou manifest.json verminken)
    html = _re.sub(r'(/static/[\w./-]+\.(?:js|css))(?![\w])(\?v=[\w.]+)?', r'\1?v=' + ASSET_VERSION, html)
    # Manifest apart cache-busten (bewust buiten de regex hierboven): anders installeren
    # toestellen tot een dag lang de oude huisstijl uit hun HTTP-cache
    html = html.replace('href="/static/manifest.json"', f'href="/static/manifest.json?v={ASSET_VERSION}"')
    # Swap logo src — vervang alle bekende logo-paden
    for known_logo in ["/static/cirqo-logo.webp", "/static/bouwkringloop-logo.jpg"]:
        html = html.replace(known_logo, b["logo"])
    # Swap subtitle
    html = html.replace("Milieustraat Almere-Buiten", b["sub"])
    html = html.replace("CIRQO", b["name"])
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})


@app.get("/api/version")
async def app_version():
    return {"version": ASSET_VERSION}

@app.get("/brand.css")
async def brand_css(request: Request):
    css = _brand_css(_detect_brand(request))
    return Response(content=css, media_type="text/css", headers={"Cache-Control": "no-cache"})

@app.get("/rwm/brand.css")
async def rwm_brand_css():
    return Response(content=_brand_css("rwm"), media_type="text/css", headers={"Cache-Control": "no-cache"})

@app.get("/rwm", response_class=HTMLResponse)
@app.get("/rwm/", response_class=HTMLResponse)
async def rwm_home():
    return _render_html("static/index.html", "rwm")

@app.get("/rwm/login", response_class=HTMLResponse)
async def rwm_login():
    return _render_html("static/login.html", "rwm")

@app.get("/rwm/kiosk", response_class=HTMLResponse)
async def rwm_kiosk():
    return _render_html("static/kiosk.html", "rwm")

@app.get("/rwm/catalogus", response_class=HTMLResponse)
async def rwm_catalogus():
    return _render_html("static/catalogus.html", "rwm")

@app.get("/rwm/beheer", response_class=HTMLResponse)
async def rwm_beheer():
    return _render_html("static/beheer.html", "rwm")

@app.get("/rwm/bedrijf", response_class=HTMLResponse)
async def rwm_bedrijf():
    return _render_html("static/bedrijf.html", "rwm")


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page():
    return _render_html("static/dashboard.html", DEFAULT_BRAND)


@app.get("/check", response_class=HTMLResponse)
async def check_page():
    return _render_html("static/check.html", DEFAULT_BRAND)


@app.get("/catalogus", response_class=HTMLResponse)
@app.get("/pilotalmere", response_class=HTMLResponse)
@app.get("/pilotalmere/", response_class=HTMLResponse)
async def catalogus_page():
    html = _render_html("static/catalogus.html", DEFAULT_BRAND).body.decode()
    html = re.sub(r'class="cat-hdr-sub">[^<]*<', 'class="cat-hdr-sub">Ingezameld bouwmateriaal · Milieustraat Almere-Buiten<', html)
    return HTMLResponse(html)


@app.get("/api/catalogus")
async def get_catalogus(gemeente: str = "Almere", limit: int = 48, offset: int = 0,
                        user=Depends(get_optional_user)):
    if user:
        # Ingelogd: gemeente wordt geklemd op de eigen scope (admin: organisatie)
        gemeente = _gemeente_filter(user, gemeente)
    elif gemeente != "Almere":
        # Zonder login is alleen de publieke Almere-pilotcatalogus zichtbaar
        raise HTTPException(status_code=401, detail="Log in om deze catalogus te bekijken")

    if gemeente:
        gemeenten = _gemeenten_expand(gemeente)
        gem_filter = "gemeente = ANY(%s)" if gemeenten else "gemeente = %s"
        gem_params = [gemeenten if gemeenten else gemeente]
    else:
        gem_filter = "TRUE"    # superadmin zonder filter: alles
        gem_params = []
    with db.get_cursor() as cur:
        cur.execute(f"""
            SELECT id, ai_label, ai_detail, photo_url, photo_url_thumb, gewicht_kg, category
            FROM items
            WHERE {gem_filter} AND photo_url IS NOT NULL AND photo_url != '' AND NOT COALESCE(verwijderd, FALSE)
            ORDER BY timestamp DESC
            LIMIT %s OFFSET %s
        """, (*gem_params, limit, offset))
        rows = [dict(r) for r in cur.fetchall()]
        cur.execute(f"SELECT COUNT(*) AS cnt FROM items WHERE {gem_filter} AND photo_url IS NOT NULL AND photo_url != '' AND NOT COALESCE(verwijderd, FALSE)", gem_params)
        total = cur.fetchone()["cnt"]
        return {"items": rows, "total": total, "offset": offset, "limit": limit}


@app.post("/api/admin/bouw-thumb-urls")
async def bouw_thumb_urls(gemeente: str = "Almere", user=Depends(require_superadmin)):
    import re, urllib.parse as _up
    from firebase_admin import storage as _storage

    bucket = _storage.bucket()

    with db.get_cursor() as cur:
        cur.execute("""
            SELECT id, photo_url FROM items
            WHERE gemeente = %s AND photo_url IS NOT NULL AND photo_url_thumb IS NULL
        """, (gemeente,))
        items = cur.fetchall()

    updated = 0
    errors = 0
    for item in items:
        url = item["photo_url"]
        m = re.match(r'https://firebasestorage\.googleapis\.com/v0/b/([^/]+)/o/([^?]+)', url)
        if not m:
            continue
        bucket_name, encoded_path = m.group(1), m.group(2)
        path = _up.unquote(encoded_path)
        if not path.endswith('.jpg'):
            continue
        thumb_path = path[:-4] + '_1024x1024.jpg'
        try:
            blob = bucket.blob(thumb_path)
            blob.reload()
            token = (blob.metadata or {}).get('firebaseStorageDownloadTokens', '')
            if token:
                thumb_url = f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{_up.quote(thumb_path, safe='')}?alt=media&token={token}"
            else:
                # Fallback: use original
                thumb_url = url
            with db.get_cursor() as cur2:
                cur2.execute("UPDATE items SET photo_url_thumb = %s WHERE id = %s", (thumb_url, item["id"]))
            updated += 1
        except Exception:
            errors += 1

    return {"updated": updated, "errors": errors}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
