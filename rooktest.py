#!/usr/bin/env python3
"""
CIRQO rooktest — controleert in één commando of de kritieke paden werken.
Draai na elke deploy:   python3 rooktest.py

Gebruikt uitsluitend de afgeschermde Demo-omgeving (gemeente 'Demo'), dus
raakt geen echte gebruikersdata. Test tegen productie of een andere URL via:
    BASE_URL=https://app.cirqo.nl python3 rooktest.py
"""
import os
import sys
import requests

BASE = os.environ.get("BASE_URL", "https://app.cirqo.nl")
AFN = ("demo.afnemer", "Demo-8_t8qr66-RA")
MIL = ("demo.milieustraat", "Demo-dlRL3bjQFqk")

groen, rood = "\033[92m", "\033[91m"
reset = "\033[0m"
_fouten = 0


def check(naam, voorwaarde, extra=""):
    global _fouten
    if voorwaarde:
        print(f"  {groen}✓{reset} {naam}")
    else:
        _fouten += 1
        print(f"  {rood}✗ {naam}{reset} {extra}")


def login(cred):
    r = requests.post(f"{BASE}/api/auth/login",
                      files={"username": (None, cred[0]), "password": (None, cred[1])}, timeout=20)
    return r.json().get("token") if r.ok else None


def hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


print(f"\nCIRQO rooktest tegen {BASE}\n")

# 1. Inloggen
print("Authenticatie")
tok_afn = login(AFN)
tok_mil = login(MIL)
check("afnemer kan inloggen", tok_afn is not None)
check("milieustraat kan inloggen", tok_mil is not None)
check("fout wachtwoord wordt geweigerd", login(("demo.afnemer", "fout")) is None)
if not (tok_afn and tok_mil):
    print(f"\n{rood}Kan niet inloggen — rest overgeslagen.{reset}\n"); sys.exit(1)

# 2. Beveiliging (Golf 1)
print("\nBeveiliging")
r = requests.patch(f"{BASE}/api/users/47/password", headers=hdr(tok_afn),
                   files={"password": (None, "123")}, timeout=20)
check("te kort wachtwoord → 400", r.status_code == 400, f"kreeg {r.status_code}")
r = requests.get(f"{BASE}/api/items/1/aanbiedingen", headers=hdr(tok_afn), timeout=20)
check("aanbiedingen vreemd item → 403/404", r.status_code in (403, 404), f"kreeg {r.status_code}")
r = requests.get(f"{BASE}/api/admin/fouten", headers=hdr(tok_afn), timeout=20)
check("foutenlog afgeschermd voor niet-superadmin → 403", r.status_code == 403, f"kreeg {r.status_code}")

# 3. Kernfunctionaliteit
print("\nKernfunctionaliteit")
r = requests.get(f"{BASE}/api/items", headers=hdr(tok_afn), timeout=20)
items = r.json() if r.ok else []
check("aanbodlijst laadt", r.ok and isinstance(items, list) and len(items) > 0, f"{len(items)} items")
r = requests.get(f"{BASE}/api/stats", headers=hdr(tok_afn), timeout=20)
stats = r.json() if r.ok else {}
check("dashboard-stats laden", r.ok and "total" in stats, str(stats)[:60])
check("gewichten geteld (kg > 0)", stats.get("totaal_kg", 0) > 0, f"{stats.get('totaal_kg')} kg")
r = requests.get(f"{BASE}/api/charts?days=30", headers=hdr(tok_afn), timeout=20)
check("grafiekdata laadt (na timestamp-migratie)", r.ok and isinstance(r.json(), list))

# 4. Schrijfpad (chat — test dat writes na migratie nog casten)
print("\nSchrijfpaden")
item_met_chat = next((i for i in items if i.get("aanbieding_id")), None)
if item_met_chat:
    aid = item_met_chat["aanbieding_id"]
    r = requests.post(f"{BASE}/api/aanbiedingen/{aid}/berichten", headers=hdr(tok_mil),
                      files={"tekst": (None, "rooktest — mag genegeerd worden")}, timeout=20)
    check("chatbericht versturen", r.status_code == 200, f"kreeg {r.status_code}")
else:
    check("chatbericht versturen", False, "geen aanbieding met chat gevonden")

print()
if _fouten:
    print(f"{rood}{_fouten} test(s) gefaald.{reset}\n"); sys.exit(1)
print(f"{groen}Alle rooktests geslaagd.{reset}\n")
