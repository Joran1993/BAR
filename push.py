"""
Web Push notificaties via VAPID
"""
import os
import json
import base64
from pywebpush import webpush, WebPushException
from py_vapid import Vapid

VAPID_PRIVATE_KEY_B64 = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY_B64  = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_EMAIL           = os.environ.get("VAPID_EMAIL", "mailto:info@bouwkringloop.nl")

_vapid_instance = None


def _get_vapid():
    global _vapid_instance
    if _vapid_instance is None:
        pem = base64.b64decode(VAPID_PRIVATE_KEY_B64)
        _vapid_instance = Vapid.from_pem(pem)
    return _vapid_instance


def get_public_key() -> str:
    return VAPID_PUBLIC_KEY_B64


def _send_fcm(token: str, title: str, body: str, url: str) -> bool:
    """Native melding via Firebase Cloud Messaging (iOS-/Android-schil).
    Retourneert False bij een dood token zodat de aanroeper hem opruimt."""
    if not token:
        return False
    try:
        import firestore as _fs
        _fs._get_db()   # zorgt dat de Firebase-app geïnitialiseerd is
        from firebase_admin import messaging
        bericht = messaging.Message(
            token=token,
            notification=messaging.Notification(title=title, body=body),
            data={"url": url},
            apns=messaging.APNSConfig(payload=messaging.APNSPayload(
                aps=messaging.Aps(sound="default", badge=1))),
        )
        messaging.send(bericht)
        return True
    except Exception as e:
        naam = type(e).__name__
        print(f"[push-fcm] Fout ({naam}): {e}")
        # Ongeldig/verlopen token → False zodat het opgeruimd wordt
        return naam not in ("UnregisteredError", "SenderIdMismatchError", "InvalidArgumentError")


def send_push(subscription_json: str, title: str, body: str, url: str = "/") -> bool:
    # Native schil-token (Play Store/App Store-app)? → via FCM/APNs
    try:
        _sub = json.loads(subscription_json)
        if isinstance(_sub, dict) and _sub.get("type") == "fcm":
            return _send_fcm(_sub.get("token", ""), title, body, url)
    except Exception:
        pass
    if not VAPID_PRIVATE_KEY_B64:
        print("[push] VAPID_PRIVATE_KEY niet ingesteld")
        return False
    try:
        subscription = json.loads(subscription_json)
        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "url": url}),
            vapid_private_key=_get_vapid(),
            vapid_claims={"sub": VAPID_EMAIL},
        )
        return True
    except WebPushException as e:
        status = e.response.status_code if e.response is not None else "?"
        print(f"[push] Fout {status}: {e}")
        return status in (404, 410)
    except Exception as e:
        print(f"[push] Onverwachte fout: {e}")
        return False
