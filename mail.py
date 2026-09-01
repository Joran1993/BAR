"""E-mail via SMTP, geconfigureerd met omgevingsvariabelen.

SMTP_HOST, SMTP_PORT (465 = SSL, anders STARTTLS), SMTP_USER, SMTP_PASS,
MAIL_FROM (bv. "CIRQO <info@cirqo.nl>"), MAIL_BCC (optioneel: kopie naar CIRQO).
Zonder configuratie doet send_mail niets en geeft False terug — de rest van
de app blijft werken, alleen de bevestiging per mail blijft uit.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr


def geconfigureerd() -> bool:
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_USER")
                and os.environ.get("SMTP_PASS"))


def send_mail(aan, onderwerp: str, tekst: str, html: str = None,
              bijlagen: list = None, bcc=None) -> bool:
    """bijlagen: lijst van (bestandsnaam, bytes, mimetype). aan/bcc: str of lijst."""
    if not geconfigureerd():
        print("[mail] niet geconfigureerd — overgeslagen:", onderwerp)
        return False
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT") or 465)
    user = os.environ["SMTP_USER"]
    pw = os.environ["SMTP_PASS"]
    afzender = os.environ.get("MAIL_FROM") or user
    if "<" not in afzender:
        afzender = formataddr(("CIRQO", afzender))

    aan_lijst = [aan] if isinstance(aan, str) else list(aan or [])
    bcc_lijst = [bcc] if isinstance(bcc, str) else list(bcc or [])
    extra_bcc = os.environ.get("MAIL_BCC")
    if extra_bcc:
        bcc_lijst += [a.strip() for a in extra_bcc.split(",") if a.strip()]
    ontvangers = [a for a in aan_lijst + bcc_lijst if a]
    if not ontvangers:
        return False

    msg = EmailMessage()
    msg["From"] = afzender
    msg["To"] = ", ".join(aan_lijst)
    msg["Subject"] = onderwerp
    msg.set_content(tekst)
    if html:
        msg.add_alternative(html, subtype="html")
    for naam, data, mime in (bijlagen or []):
        hoofd, _, sub = (mime or "application/octet-stream").partition("/")
        msg.add_attachment(data, maintype=hoofd, subtype=sub or "octet-stream", filename=naam)

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as s:
                s.login(user, pw)
                s.send_message(msg, from_addr=parseaddr(afzender)[1], to_addrs=ontvangers)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.starttls(context=ssl.create_default_context())
                s.login(user, pw)
                s.send_message(msg, from_addr=parseaddr(afzender)[1], to_addrs=ontvangers)
        print(f"[mail] verstuurd: {onderwerp} → {ontvangers}")
        return True
    except Exception as e:
        print(f"[mail] mislukt: {e}")
        return False
