"""
Supabase Storage — foto upload
"""
import os
import uuid
import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
BUCKET = "photos"

# Herbruikbare HTTP client (geen nieuwe verbinding per upload)
_client: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.Client(timeout=30)
    return _client


def upload_photo(content: bytes) -> str:
    """Upload JPEG bytes naar Supabase Storage. Geeft publieke URL terug."""
    key = f"{uuid.uuid4()}.jpg"
    r = _get_client().put(
        f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{key}",
        content=content,
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "image/jpeg",
        },
    )
    r.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{key}"


# ── Afgeschermde foto-URL's ───────────────────────────────────────────────────
# Foto's stonden in een publiek leesbare bucket: wie een URL had (of doorstuurde)
# kon hem voor altijd openen, ook zonder account. Daarom leveren we voortaan
# ondertekende links met korte geldigheid. De browser haalt de foto nog steeds
# rechtstreeks bij de opslag op (geen omweg via onze server), dus dit kost geen
# snelheid; alleen het ondertekenen zelf, en dat cachen we.
import datetime as _dt
import urllib.parse as _up

ONDERTEKEND_GELDIG = 6 * 3600      # 6 uur — ruim genoeg voor een sessie
_CACHE_TTL = 5 * 3600              # iets korter cachen dan de geldigheid
_CACHE_VERSIE = "v3"               # ophogen = alle gecachte links vervallen (v3: verlopen links uit de v2-cache)
_fb_bucket = None
# Snelle cache in het proces zelf: scheelt een Redis-rondje per foto. Redis
# blijft eronder liggen zodat een herstart of tweede proces niet opnieuw hoeft
# te ondertekenen.
_geheugen: dict = {}
_GEHEUGEN_MAX = 4000


def _uit_geheugen(sleutel):
    import time
    p = _geheugen.get(sleutel)
    if p and p[0] > time.time():
        return p[1]
    if p:
        _geheugen.pop(sleutel, None)
    return None


def _in_geheugen(sleutel, waarde):
    import time
    if len(_geheugen) > _GEHEUGEN_MAX:
        _geheugen.clear()
    _geheugen[sleutel] = (time.time() + _CACHE_TTL, waarde)


_fb_buckets: dict = {}


def _firebase_bucket(naam: str):
    """Bucket op naam openen. Belangrijk: de bucket uit de URL gebruiken en niet
    de standaardbucket — de oude config wijst naar '…appspot.com' terwijl de
    foto's in '…firebasestorage.app' staan (dat gaf 404 op ondertekende links)."""
    if naam in _fb_buckets:
        return _fb_buckets[naam]
    try:
        import firestore as _fs
        from firebase_admin import storage as _fbstorage
        _fs._get_db()
        _fb_buckets[naam] = _fbstorage.bucket(naam)
    except Exception as e:
        print(f"[storage] Firebase-bucket '{naam}' niet beschikbaar: {e}")
        _fb_buckets[naam] = None
    return _fb_buckets[naam]


def _supabase_pad(url: str):
    """Herkent zowel gewone foto's als de miniatuur-variant.
    → (bucket, pad, is_miniatuur, extra_parameters)"""
    for merk, is_mini in (("/storage/v1/object/public/", False),
                          ("/storage/v1/render/image/public/", True),
                          # Ook al ondertekende links: die staan in de database
                          # opgeslagen bij een deel van de items. Zonder deze
                          # regels worden ze nooit opnieuw ondertekend en is de
                          # foto na het verlopen van de handtekening stuk.
                          ("/storage/v1/object/sign/", False),
                          ("/storage/v1/render/image/sign/", True)):
        if merk in url:
            staart = url.split(merk, 1)[1]
            rest, _, query = staart.partition("?")
            bucket, _, pad = rest.partition("/")
            # de oude handtekening mag niet mee in de nieuwe link
            query = "&".join(d for d in query.split("&") if d and not d.startswith("token="))
            if bucket and pad:
                return bucket, pad, is_mini, query
    return None


def _firebase_pad(url: str):
    """Geeft (bucketnaam, objectpad) voor beide Google-vormen."""
    if "firebasestorage.googleapis.com" in url and "/o/" in url:
        bucket = url.split("/v0/b/", 1)[1].split("/o/", 1)[0]
        return bucket, _up.unquote(url.split("/o/", 1)[1].split("?")[0])
    if url.startswith("https://storage.googleapis.com/"):
        rest = url[len("https://storage.googleapis.com/"):].split("?")[0]
        bucket, _, pad = rest.partition("/")
        if bucket and pad:
            return bucket, _up.unquote(pad)
    return None


def onderteken(urls):
    """Geef {originele_url: veilige_url}. Onbekende vormen blijven ongewijzigd."""
    import cache as _cache
    uniek = [u for u in {u for u in urls if u} if isinstance(u, str)]
    uit, nog_tekenen_sb, nog_tekenen_fb = {}, [], []

    for u in uniek:
        gecached = _uit_geheugen(u) or _cache.get(f"foto:{_CACHE_VERSIE}:{u}")
        if gecached:
            _in_geheugen(u, gecached)
            uit[u] = gecached
        elif _supabase_pad(u):
            nog_tekenen_sb.append(u)
        elif _firebase_pad(u):
            nog_tekenen_fb.append(u)
        else:
            uit[u] = u                       # externe/onbekende URL: laten staan

    # Supabase: in één keer ondertekenen (scheelt een netwerkcall per foto)
    per_bucket = {}
    for u in nog_tekenen_sb:
        b, p, mini, query = _supabase_pad(u)
        per_bucket.setdefault(b, []).append((u, p, mini, query))
    for bucket, paren in per_bucket.items():
        try:
            r = _get_client().post(
                f"{SUPABASE_URL}/storage/v1/object/sign/{bucket}",
                headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                         "Content-Type": "application/json"},
                json={"expiresIn": ONDERTEKEND_GELDIG, "paths": [p for _, p, _m, _q in paren]},
            )
            r.raise_for_status()
            per_pad = {x.get("path"): x.get("signedURL") for x in r.json() if not x.get("error")}
            for orig, pad, mini, query in paren:
                s = per_pad.get(pad)
                if s and mini:
                    # miniatuur: zelfde token, maar via de beeldbewerkings-route,
                    # met de oorspronkelijke parameters (breedte/kwaliteit) erbij
                    token = s.split("token=", 1)[1] if "token=" in s else ""
                    extra = "&" + query if query else ""
                    veilig = (f"{SUPABASE_URL}/storage/v1/render/image/sign/{bucket}/{pad}"
                              f"?token={token}{extra}")
                elif s:
                    veilig = f"{SUPABASE_URL}/storage/v1{s}"
                else:
                    veilig = orig
                uit[orig] = veilig
                if s:
                    _cache.set(f"foto:{_CACHE_VERSIE}:{orig}", veilig, ttl=_CACHE_TTL)
                    _in_geheugen(orig, veilig)
        except Exception as e:
            print(f"[storage] ondertekenen Supabase mislukt: {e}")
            for orig, _pad, _mini, _query in paren:
                uit[orig] = orig             # liever een werkende foto dan een gebroken pagina

    # Firebase: lokaal ondertekenen met de servicesleutel
    for u in nog_tekenen_fb:
        veilig = u
        naam, pad = _firebase_pad(u)
        bucket = _firebase_bucket(naam)
        if bucket is not None:
            try:
                veilig = bucket.blob(pad).generate_signed_url(
                    expiration=_dt.timedelta(seconds=ONDERTEKEND_GELDIG), method="GET")
                _cache.set(f"foto:{_CACHE_VERSIE}:{u}", veilig, ttl=_CACHE_TTL)
                _in_geheugen(u, veilig)
            except Exception as e:
                print(f"[storage] ondertekenen Firebase mislukt: {e}")
        uit[u] = veilig
    return uit


VELDEN = ("photo_url", "photo_url_thumb")


def beveilig_items(items):
    """Vervang foto-URL's in een lijst items door ondertekende varianten."""
    if not items:
        return items
    verzamel = []
    for it in items:
        if not isinstance(it, dict):
            continue
        for v in VELDEN:
            if it.get(v):
                verzamel.append(it[v])
        pu = it.get("photo_urls")
        if isinstance(pu, list):
            verzamel += [x for x in pu if x]
    if not verzamel:
        return items
    kaart = onderteken(verzamel)
    for it in items:
        if not isinstance(it, dict):
            continue
        for v in VELDEN:
            if it.get(v):
                it[v] = kaart.get(it[v], it[v])
        if isinstance(it.get("photo_urls"), list):
            it["photo_urls"] = [kaart.get(x, x) for x in it["photo_urls"]]
    return items
