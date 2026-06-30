#!/usr/bin/env python3
"""
Seed-script — Waardlanden aansluitplan Stap 1 (milieustraat Hveld).

Doet twee dingen, idempotent en niet-destructief:
  1. Voegt nieuwe stromen toe aan BESTAANDE partners (categorieën worden alleen
     toegevoegd, nooit verwijderd).
  2. Maakt NIEUWE partners aan (alleen als ze nog niet bestaan op naam).

Cooloo pilot wordt bewust NIET aangemaakt (pilot gepauzeerd).

Gebruik:
    python scripts/seed_waardlanden_stap1.py            # dry-run (toont alleen)
    python scripts/seed_waardlanden_stap1.py --apply     # voert wijzigingen door

Vereist: DATABASE_URL in de omgeving (zelfde als de app).
"""
import os
import sys

# Zorg dat de projectroot (waar database.py staat) op het importpad staat,
# ongeacht vanaf waar het script gestart wordt.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database as db

DRY_RUN = "--apply" not in sys.argv

# Gemeente van milieustraat Hveld (Route A: koppelen op gemeente).
HVELD_GEMEENTE = "Hardinxveld-Giessendam"

# Bestaande partners: id -> verwachte naam (sanity-check) + toe te voegen stromen.
BESTAANDE_PARTNERS = [
    {"id": 20, "verwacht": "Kringloop Gorinchem", "stromen": ["kringloop"]},
    {"id": 21, "verwacht": "De Gezel",            "stromen": ["meubels", "fietsen", "diversen"]},
    {"id": 23, "verwacht": "SitY Academy",        "stromen": ["fietsen", "diversen"]},
]

# Nieuwe partners (gemeente = Hveld). Cooloo bewust weggelaten.
NIEUWE_PARTNERS = [
    {"naam": "Fictief account Terugwinning", "stromen": ["bouwmateriaal", "fietsen"]},
    {"naam": "Div kleine partners",          "stromen": ["diversen"]},
]


def _bedrijf_by_id(cur, bedrijf_id):
    cur.execute("SELECT id, naam FROM bedrijven WHERE id = %s", (bedrijf_id,))
    return cur.fetchone()


def _bedrijf_by_naam(cur, naam):
    cur.execute("SELECT id, naam FROM bedrijven WHERE lower(naam) = lower(%s)", (naam,))
    return cur.fetchone()


def _bestaande_cats(cur, bedrijf_id):
    cur.execute("SELECT category FROM bedrijf_categorieen WHERE bedrijf_id = %s", (bedrijf_id,))
    return {r["category"] for r in cur.fetchall()}


def run():
    mode = "DRY-RUN (geen wijzigingen)" if DRY_RUN else "APPLY (wijzigingen worden doorgevoerd)"
    print(f"== Waardlanden Stap 1 seed — {mode} ==\n")

    with db.get_cursor() as cur:
        # 1) Bestaande partners — stromen toevoegen
        print("-- Bestaande partners: stromen toevoegen --")
        for p in BESTAANDE_PARTNERS:
            row = _bedrijf_by_id(cur, p["id"])
            if not row:
                print(f"  [!] id {p['id']} bestaat NIET — overgeslagen (verwacht: {p['verwacht']})")
                continue
            if row["naam"].strip().lower() != p["verwacht"].strip().lower():
                print(f"  [!] id {p['id']} heet '{row['naam']}', verwacht '{p['verwacht']}' — overgeslagen voor de zekerheid")
                continue
            huidig = _bestaande_cats(cur, p["id"])
            toe_te_voegen = [c for c in p["stromen"] if c not in huidig]
            if not toe_te_voegen:
                print(f"  [=] {row['naam']} (id {p['id']}): al up-to-date {sorted(huidig)}")
                continue
            print(f"  [+] {row['naam']} (id {p['id']}): toevoegen {toe_te_voegen}  (had: {sorted(huidig)})")
            if not DRY_RUN:
                for cat in toe_te_voegen:
                    cur.execute(
                        "INSERT INTO bedrijf_categorieen (bedrijf_id, category) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                        (p["id"], cat),
                    )

        # 2) Nieuwe partners — aanmaken indien afwezig
        print("\n-- Nieuwe partners: aanmaken --")
        for p in NIEUWE_PARTNERS:
            bestaand = _bedrijf_by_naam(cur, p["naam"])
            if bestaand:
                print(f"  [=] '{p['naam']}' bestaat al (id {bestaand['id']}) — overgeslagen")
                continue
            print(f"  [+] '{p['naam']}' aanmaken — gemeente {HVELD_GEMEENTE}, stromen {p['stromen']}")
            if not DRY_RUN:
                nieuw_id = db.create_bedrijf(
                    naam=p["naam"],
                    gemeente=HVELD_GEMEENTE,
                    categorieen=p["stromen"],
                )
                print(f"      -> aangemaakt met id {nieuw_id}")

    print("\nKlaar." + ("  (dry-run — draai met --apply om door te voeren)" if DRY_RUN else ""))


if __name__ == "__main__":
    run()
