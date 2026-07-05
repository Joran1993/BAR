import os
import jwt
import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from typing import Optional

SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY ontbreekt als omgevingsvariabele — app weigert te starten (geen onveilige fallback)")
ALGORITHM = "HS256"
# Lang geldig: gebruikers blijven ingelogd, óók na maanden niet openen. Veilig
# omdat get_current_user elke ~60s bij de DB checkt of het account nog bestaat/
# welke rol het heeft — verwijderen/blokkeren werkt dus binnen een minuut,
# ongeacht de tokenduur. Het token rolt bovendien bij elke app-start vooruit.
TOKEN_EXPIRE_DAYS = 365

# Centraal wachtwoordbeleid — één plek zodat elk endpoint dezelfde regel gebruikt
WACHTWOORD_MIN = 6


def wachtwoord_ok(pw: str) -> Optional[str]:
    """Geeft None als het wachtwoord voldoet, anders een foutmelding (NL)."""
    if not pw or len(pw) < WACHTWOORD_MIN:
        return f"Wachtwoord moet minimaal {WACHTWOORD_MIN} tekens zijn."
    return None


def hash_password(password: str) -> str:
    """Nieuwe hashes altijd met bcrypt (adaptief, traag voor brute force)."""
    import bcrypt
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    if not hashed:
        return False
    if hashed.startswith("$2"):
        # bcrypt
        import bcrypt
        try:
            return bcrypt.checkpw(password.encode(), hashed.encode())
        except Exception:
            return False
    # Legacy: HMAC-SHA256 als "salt$hash" — wordt bij succesvolle login
    # stilzwijgend gemigreerd naar bcrypt (zie login-endpoint)
    try:
        salt, h = hashed.split("$")
        expected = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, h)
    except Exception:
        return False


def needs_rehash(hashed: str) -> bool:
    """True als de opgeslagen hash nog het oude (snelle) formaat heeft."""
    return not (hashed or "").startswith("$2")


def create_token(user_id: int, username: str, role: str = "user",
                 gemeente: str = "", bedrijf_id: Optional[int] = None) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "gemeente": gemeente,
        "bedrijf_id": bedrijf_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        return None
