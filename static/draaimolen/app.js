/* Draaimolen 26 — timetable met setherinneringen.
   Alles draait op één JSON: dagen, stages, sets. Favorieten hangen aan de
   artiestnaam (niet aan een set-id), zodat ze een nieuwe timetable overleven. */

(() => {
"use strict";

const OPSLAG = {
  fav:    "dm26.favorieten",
  lead:   "dm26.lead",
  cache:  "dm26.timetable-cache",
  lokaal: "dm26.timetable-lokaal",
  code:   "dm26.code",
};

const S = {
  data: null,
  dag: null,
  stage: "alles",
  scherm: "timetable",
  fav: new Set(),
  lead: 15,
  reg: null,
  sub: null,
  timers: [],
  gemeld: new Set(),
};

const $ = (sel) => document.querySelector(sel);
const maakEl = (tag, klas, tekst) => {
  const el = document.createElement(tag);
  if (klas) el.className = klas;
  if (tekst != null) el.textContent = tekst;
  return el;
};

// ── Kleine hulpjes ──────────────────────────────────────────────────────────

const sleutel = (naam) => (naam || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function offset() {
  // Vaste festivalzone: zo klopt "nu" ook als de telefoon in een andere
  // tijdzone staat. September valt in de zomertijd.
  return (S.data && S.data.utc_offset) || "+02:00";
}

function datumVanDag(dagId) {
  const d = (S.data.dagen || []).find((x) => x.id === dagId);
  return d ? d.datum : null;
}

function moment(dagId, tijd) {
  const datum = datumVanDag(dagId);
  if (!datum || !tijd) return null;
  const [uur] = tijd.split(":").map(Number);
  const d = new Date(`${datum}T${tijd.padStart(5, "0")}:00${offset()}`);
  if (isNaN(d)) return null;
  // Alles vóór 06:00 hoort bij de nacht ná die festivaldag
  if (uur < 6) d.setDate(d.getDate() + 1);
  return d;
}

function setTijden(s) {
  const start = moment(s.dag, s.start);
  let eind = s.eind ? moment(s.dag, s.eind) : null;
  if (start && eind && eind <= start) eind = new Date(eind.getTime() + 864e5);
  return { start, eind };
}

const nu = () => new Date();

function klokTekst(d) {
  return new Intl.DateTimeFormat("nl-NL", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam",
  }).format(d);
}

// ── Opslag ──────────────────────────────────────────────────────────────────

function laadVoorkeuren() {
  try {
    const f = JSON.parse(localStorage.getItem(OPSLAG.fav) || "[]");
    S.fav = new Set(f);
  } catch { S.fav = new Set(); }
  const l = parseInt(localStorage.getItem(OPSLAG.lead) || "15", 10);
  S.lead = isNaN(l) ? 15 : l;
}

function bewaarFavorieten() {
  localStorage.setItem(OPSLAG.fav, JSON.stringify([...S.fav]));
}

// ── Timetable ophalen ───────────────────────────────────────────────────────

async function haalTimetable() {
  const eigen = localStorage.getItem(OPSLAG.lokaal);
  if (eigen) {
    try {
      S.data = JSON.parse(eigen);
      S.data.herkomst = "eigen import";
      return;
    } catch { localStorage.removeItem(OPSLAG.lokaal); }
  }
  try {
    const res = await fetch("/draaimolen/api/timetable", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    S.data = await res.json();
    localStorage.setItem(OPSLAG.cache, JSON.stringify(S.data));
  } catch {
    const cache = localStorage.getItem(OPSLAG.cache);
    if (!cache) throw new Error("geen timetable");
    S.data = JSON.parse(cache);
    S.data.herkomst = "offline kopie";
  }
}

function setsVanDag(dagId) {
  return (S.data.sets || [])
    .filter((s) => s.dag === dagId && s.start)
    .sort((a, b) => {
      const ta = setTijden(a).start, tb = setTijden(b).start;
      return (ta && tb) ? ta - tb : 0;
    });
}

function setsZonderTijd() {
  return (S.data.sets || [])
    .filter((s) => !s.start)
    .sort((a, b) => a.artiest.localeCompare(b.artiest, "nl"));
}

function stagesVanDag(dagId) {
  const namen = [];
  for (const s of setsVanDag(dagId)) {
    const st = s.stage || "Onbekend";
    if (!namen.includes(st)) namen.push(st);
  }
  // Vaste volgorde uit de timetable aanhouden; die staat in de affichevolgorde
  const vast = S.data.stages || [];
  if (vast.length) {
    namen.sort((a, b) => {
      const ia = vast.indexOf(a), ib = vast.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
  return namen;
}

// ── Renderen ────────────────────────────────────────────────────────────────

function renderDagen() {
  const bak = $("#dagen");
  bak.innerHTML = "";
  for (const d of S.data.dagen || []) {
    const knop = maakEl("button", "dagknop");
    knop.setAttribute("aria-current", String(d.id === S.dag));
    knop.appendChild(maakEl("span", "dagnaam", d.kort || d.naam));
    knop.appendChild(maakEl("span", "dagnummer", (d.datum || "").slice(8) || "--"));
    knop.onclick = () => { S.dag = d.id; S.stage = "alles"; render(); };
    bak.appendChild(knop);
  }
}

function renderStages() {
  const bak = $("#stagebalk");
  bak.innerHTML = "";
  const stages = stagesVanDag(S.dag);
  if (!stages.length) { bak.style.display = "none"; return; }
  bak.style.display = "flex";
  for (const naam of ["alles", ...stages]) {
    const knop = maakEl("button", "stageknop", naam === "alles" ? "Alle stages" : naam);
    knop.setAttribute("aria-current", String(S.stage === naam));
    knop.onclick = () => { S.stage = naam; renderStages(); renderLijst(); };
    bak.appendChild(knop);
  }
}

function setRegel(s, opties = {}) {
  const { start, eind } = setTijden(s);
  const rij = maakEl("button", "set");
  const isFav = S.fav.has(sleutel(s.artiest));
  rij.setAttribute("aria-pressed", String(isFav));

  const tijd = maakEl("div", "tijd", s.start || "—");
  if (s.eind) tijd.appendChild(maakEl("span", "tot", s.eind));
  rij.appendChild(tijd);

  const midden = maakEl("div");
  midden.appendChild(maakEl("div", "naam", s.artiest));

  const meta = maakEl("span", "meta");
  const delen = [];
  if (opties.toonStage && s.stage) delen.push(s.stage);
  if (s.soort && s.soort !== "dj") delen.push(s.soort);
  meta.textContent = delen.join(" · ");

  const n = nu();
  const bezig = start && ((eind && n >= start && n < eind) ||
                          (!eind && n >= start && n - start < 5400000));
  if (bezig) {
    if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(maakEl("span", "nu", "NU BEZIG"));
    rij.classList.add("bezig");
  } else if (start && (eind ? n > eind : n - start > 5400000)) {
    rij.classList.add("voorbij");
  }
  if (opties.botsing) {
    if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(maakEl("span", "botst", `botst met ${opties.botsing}`));
  }
  if (meta.textContent || meta.children.length) midden.appendChild(meta);
  rij.appendChild(midden);

  rij.appendChild(maakEl("div", "ruit"));

  rij.onclick = () => {
    const k = sleutel(s.artiest);
    if (S.fav.has(k)) S.fav.delete(k); else S.fav.add(k);
    bewaarFavorieten();
    rij.setAttribute("aria-pressed", String(S.fav.has(k)));
    updateTeller();
    planLokaleHerinneringen();
    syncAbonnement();
  };
  return rij;
}

function groepKop(titel, aantal) {
  const kop = maakEl("div", "groepkop");
  kop.appendChild(maakEl("h2", null, titel));
  kop.appendChild(maakEl("div", "streep"));
  if (aantal != null) kop.appendChild(maakEl("span", "aantal", String(aantal)));
  return kop;
}

function isVandaag(dagId) {
  const datum = datumVanDag(dagId);
  if (!datum) return false;
  const hier = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(nu());
  return hier === datum;
}

function nuLijn() {
  const el = maakEl("div", "nulijn");
  el.appendChild(maakEl("span", null, `NU ${klokTekst(nu())}`));
  el.appendChild(maakEl("div", "balkje"));
  return el;
}

function renderLijst() {
  const bak = $("#lijst");
  bak.innerHTML = "";
  const sets = setsVanDag(S.dag);

  if (!sets.length) {
    bak.appendChild(legeTimetable());
    return;
  }

  if (S.stage === "alles") {
    // Chronologisch over alle stages, met een streep op het huidige tijdstip
    const n = nu();
    let lijnGezet = !isVandaag(S.dag);
    for (const s of sets) {
      const { start } = setTijden(s);
      if (!lijnGezet && start && start > n) {
        bak.appendChild(nuLijn());
        lijnGezet = true;
      }
      bak.appendChild(setRegel(s, { toonStage: true }));
    }
  } else {
    const eigen = sets.filter((s) => (s.stage || "Onbekend") === S.stage);
    bak.appendChild(groepKop(S.stage, eigen.length));
    eigen.forEach((s) => bak.appendChild(setRegel(s)));
  }

  const zonder = setsZonderTijd();
  if (zonder.length && S.stage === "alles") {
    bak.appendChild(groepKop("Tijd nog niet bekend", zonder.length));
    zonder.forEach((s) => bak.appendChild(setRegel(s)));
  }
}

function legeTimetable() {
  const zonder = setsZonderTijd();
  const bak = document.createDocumentFragment();
  const leeg = maakEl("div", "leeg");
  leeg.appendChild(maakEl("strong", null, "Nog geen set-tijden voor deze dag"));
  leeg.appendChild(maakEl("p", null,
    "Tik hieronder je artiesten alvast aan. Zodra de officiële timetable is ingelezen " +
    "krijgen ze automatisch hun tijd én je meldingen."));
  const knop = maakEl("button", "knop-vlak", "Timetable inlezen");
  knop.onclick = () => toonScherm("import");
  leeg.appendChild(knop);
  bak.appendChild(leeg);
  if (zonder.length) {
    bak.appendChild(groepKop("Line-up", zonder.length));
    zonder.forEach((s) => bak.appendChild(setRegel(s)));
  }
  return bak;
}

function favorieteSets() {
  return (S.data.sets || [])
    .filter((s) => S.fav.has(sleutel(s.artiest)))
    .sort((a, b) => {
      const ta = setTijden(a).start, tb = setTijden(b).start;
      if (!ta && !tb) return a.artiest.localeCompare(b.artiest, "nl");
      if (!ta) return 1;
      if (!tb) return -1;
      return ta - tb;
    });
}

function renderMijn() {
  const bak = $("#mijn-lijst");
  bak.innerHTML = "";
  const alles = favorieteSets();
  const kop = $("#volgende");
  kop.innerHTML = "";

  if (!alles.length) {
    kop.style.display = "none";
    const leeg = maakEl("div", "leeg");
    leeg.appendChild(maakEl("strong", null, "Nog niets aangetikt"));
    leeg.appendChild(maakEl("p", null,
      "Tik in de timetable op een artiest — het ruitje kleurt op en de set komt hier te staan."));
    bak.appendChild(leeg);
    return;
  }

  // Eerstvolgende favoriet groot bovenaan
  const n = nu();
  const volgende = alles.find((s) => {
    const { start, eind } = setTijden(s);
    return start && (eind ? n < eind : n < new Date(start.getTime() + 5400000));
  });
  if (volgende) {
    const { start } = setTijden(volgende);
    const minuten = Math.round((start - n) / 60000);
    kop.style.display = "block";
    kop.appendChild(maakEl("div", "label", minuten <= 0 ? "Nu bezig" : "Eerstvolgende"));
    kop.appendChild(maakEl("span", "naam", volgende.artiest));
    const plek = volgende.stage || "stage onbekend";
    const dagNaam = (S.data.dagen.find((d) => d.id === volgende.dag) || {}).naam || "";
    let voor;
    if (minuten <= 0) voor = "";
    else if (minuten < 60) voor = `over ${minuten} min · `;
    else if (minuten < 720) voor = `over ${Math.floor(minuten / 60)} u ${minuten % 60} min · `;
    else voor = `${dagNaam.toLowerCase()} · `;
    const onder = `${voor}${volgende.start} · ${plek}`;
    kop.appendChild(maakEl("div", "onder", onder));
  } else {
    kop.style.display = "none";
  }

  // Per dag, met botsingsmelding
  for (const d of S.data.dagen || []) {
    const vanDag = alles.filter((s) => s.dag === d.id && s.start);
    if (!vanDag.length) continue;
    bak.appendChild(groepKop(`${d.naam} ${(d.datum || "").slice(8)}`, vanDag.length));
    vanDag.forEach((s, i) => {
      const { start, eind } = setTijden(s);
      let botsing = null;
      for (let j = 0; j < vanDag.length; j++) {
        if (i === j) continue;
        const ander = vanDag[j];
        const t = setTijden(ander);
        if (!start || !t.start) continue;
        const e1 = eind || new Date(start.getTime() + 3600000);
        const e2 = t.eind || new Date(t.start.getTime() + 3600000);
        if (start < e2 && t.start < e1) { botsing = ander.artiest; break; }
      }
      bak.appendChild(setRegel(s, { toonStage: true, botsing }));
    });
  }

  const zonder = alles.filter((s) => !s.start);
  if (zonder.length) {
    bak.appendChild(groepKop("Tijd nog niet bekend", zonder.length));
    zonder.forEach((s) => bak.appendChild(setRegel(s)));
  }
}

function updateTeller() {
  const t = $("#teller");
  t.textContent = S.fav.size ? String(S.fav.size) : "";
}

function render() {
  renderDagen();
  renderStages();
  renderLijst();
  renderMijn();
  updateTeller();
  $("#klok").textContent = klokTekst(nu());
  const bron = $("#bron-status");
  if (bron) {
    const metTijd = (S.data.sets || []).filter((s) => s.start).length;
    bron.textContent = `${(S.data.sets || []).length} acts, waarvan ${metTijd} met tijd. ` +
      `Bron: ${S.data.herkomst || "server"}, bijgewerkt ${S.data.bijgewerkt || "onbekend"}.`;
  }
}

function toonScherm(naam) {
  S.scherm = naam;
  for (const el of document.querySelectorAll(".scherm")) el.classList.add("verborgen");
  $(`#scherm-${naam}`).classList.remove("verborgen");
  $("#stagebalk").style.display = (naam === "timetable" && stagesVanDag(S.dag).length) ? "flex" : "none";
  $("#dagen").style.display = (naam === "timetable" || naam === "mijn") ? "flex" : "none";
  for (const knop of document.querySelectorAll(".balk-knop")) {
    knop.classList.toggle("actief", knop.dataset.scherm === naam);
  }
  window.scrollTo(0, 0);
  if (naam === "mijn") renderMijn();
}

// ── Meldingen ───────────────────────────────────────────────────────────────

function base64NaarUint8(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const ruw = atob(b64);
  return Uint8Array.from([...ruw].map((c) => c.charCodeAt(0)));
}

async function registreerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    S.reg = await navigator.serviceWorker.register("/draaimolen/sw.js", { scope: "/draaimolen/" });
    S.sub = await S.reg.pushManager.getSubscription().catch(() => null);
    return S.reg;
  } catch (e) {
    console.warn("[draaimolen] service worker mislukt:", e);
    return null;
  }
}

function pushStatus(tekst, fout) {
  const el = $("#push-status");
  el.textContent = tekst;
  el.classList.toggle("fout", !!fout);
}

async function zetPushAan() {
  if (!("Notification" in window)) {
    pushStatus("Deze browser kent geen meldingen.", true);
    return;
  }
  const reg = S.reg || await registreerWorker();
  if (!reg) { pushStatus("Meldingen lukken hier niet: de service worker start niet.", true); return; }

  const toestemming = await Notification.requestPermission();
  if (toestemming !== "granted") {
    pushStatus("Je hebt meldingen geweigerd. Zet ze aan in de instellingen van je browser.", true);
    return;
  }

  try {
    const { public_key } = await fetch("/draaimolen/api/vapid").then((r) => r.json());
    if (public_key) {
      S.sub = await reg.pushManager.getSubscription();
      if (!S.sub) {
        S.sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64NaarUint8(public_key),
        });
      }
      await syncAbonnement(true);
      pushStatus(`Meldingen staan aan. Je krijgt ${S.lead} minuten van tevoren een seintje.`);
    } else {
      pushStatus("De server verstuurt geen pushmeldingen (geen sleutel ingesteld). " +
                 "Zolang de app open staat krijg je wel meldingen van je toestel zelf.");
    }
  } catch (e) {
    console.warn(e);
    pushStatus("Aanmelden voor push mislukte. Meldingen werken wel zolang de app open staat.", true);
  }
  planLokaleHerinneringen();
  werkKnopBij();
}

let syncTimer = null;
function syncAbonnement(direct) {
  if (!S.sub) return;
  clearTimeout(syncTimer);
  const stuur = async () => {
    const namen = (S.data.sets || [])
      .filter((s) => S.fav.has(sleutel(s.artiest)))
      .map((s) => s.artiest);
    try {
      await fetch("/draaimolen/api/abonnement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: S.sub, artiesten: namen, lead_min: S.lead }),
      });
    } catch (e) { console.warn("[draaimolen] abonnement bijwerken mislukt", e); }
  };
  if (direct) stuur(); else syncTimer = setTimeout(stuur, 900);
}

/* Reservelijn: zolang de app open staat plant het toestel zelf de meldingen.
   Handig als de server geen push kan sturen, en als dubbele beveiliging op het
   terrein. De server-dedup en deze lijst kunnen elkaar niet dubbel triggeren
   binnen dezelfde sessie. */
function planLokaleHerinneringen() {
  S.timers.forEach(clearTimeout);
  S.timers = [];
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const n = nu();
  for (const s of favorieteSets()) {
    const { start } = setTijden(s);
    if (!start) continue;
    const wek = start.getTime() - S.lead * 60000;
    const over = wek - n.getTime();
    if (over <= 0 || over > 3 * 3600000) continue;   // hooguit drie uur vooruit
    const id = `${s.dag}|${s.start}|${s.artiest}`;
    S.timers.push(setTimeout(() => {
      if (S.gemeld.has(id)) return;
      S.gemeld.add(id);
      const body = `${s.start} · ${s.stage || "stage onbekend"} — begint over ${S.lead} min`;
      if (S.reg) S.reg.showNotification(s.artiest, {
        body, tag: id, icon: "/static/draaimolen/icon-192.png",
        badge: "/static/draaimolen/icon-192.png", data: { url: "/draaimolen/" },
      });
    }, over));
  }
}

function werkKnopBij() {
  const knop = $("#knop-push");
  const aan = ("Notification" in window) && Notification.permission === "granted";
  knop.textContent = aan ? "Meldingen staan aan" : "Meldingen aanzetten";
  knop.disabled = false;
}

function renderLeadChips() {
  const bak = $("#lead-chips");
  bak.innerHTML = "";
  for (const m of [5, 10, 15, 30, 45]) {
    const chip = maakEl("button", "chip", `${m} min`);
    chip.setAttribute("aria-pressed", String(m === S.lead));
    chip.onclick = () => {
      S.lead = m;
      localStorage.setItem(OPSLAG.lead, String(m));
      renderLeadChips();
      planLokaleHerinneringen();
      syncAbonnement(true);
      if (Notification.permission === "granted") {
        pushStatus(`Meldingen staan aan. Je krijgt ${m} minuten van tevoren een seintje.`);
      }
    };
    bak.appendChild(chip);
  }
}

// ── Agenda-export ───────────────────────────────────────────────────────────

function icsTijd(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function exporteerIcs() {
  const sets = favorieteSets().filter((s) => s.start);
  if (!sets.length) { alert("Je hebt nog geen sets met een tijd aangetikt."); return; }
  const regels = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//draaimolen//timetable//NL", "CALSCALE:GREGORIAN"];
  for (const s of sets) {
    const { start, eind } = setTijden(s);
    const stop = eind || new Date(start.getTime() + 3600000);
    regels.push("BEGIN:VEVENT",
      `UID:${sleutel(s.artiest)}-${icsTijd(start)}@draaimolen`,
      `DTSTAMP:${icsTijd(new Date())}`,
      `DTSTART:${icsTijd(start)}`,
      `DTEND:${icsTijd(stop)}`,
      `SUMMARY:${s.artiest}`,
      `LOCATION:${(s.stage || "Draaimolen").replace(/,/g, " ")}`,
      "END:VEVENT");
  }
  regels.push("END:VCALENDAR");
  const blob = new Blob([regels.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "draaimolen-2026.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── Timetable inlezen ───────────────────────────────────────────────────────

const DAGWOORDEN = [
  { test: /(vrijdag|friday|\bvr\b|\bfri\b|04[-./ ]?09|4 sep)/i, id: "vr" },
  { test: /(zaterdag|saturday|\bza\b|\bsat\b|05[-./ ]?09|5 sep)/i, id: "za" },
  { test: /(zondag|sunday|\bzo\b|\bsun\b|06[-./ ]?09|6 sep)/i, id: "zo" },
];

const TIJDBEREIK = /(\d{1,2})[:.](\d{2})\s*(?:[-–—]|tot|till|to)\s*(\d{1,2})[:.](\d{2})/;
const ENKELE_TIJD = /^(\d{1,2})[:.](\d{2})$/;

function tijdTekst(u, m) {
  return `${String(u).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function soortVan(naam) {
  const l = naam.toLowerCase();
  if (l.includes("(live)") || / live$/.test(l)) return "live";
  if (l.includes("(hybrid)")) return "hybrid";
  if (/\bb2b\b/.test(l)) return "b2b";
  return "dj";
}

function leesTimetable(tekst) {
  const schoon = tekst.trim();
  if (schoon.startsWith("{")) {
    const data = JSON.parse(schoon);
    if (!Array.isArray(data.sets)) throw new Error("JSON zonder sets");
    return data;
  }

  const dagen = (S.data.dagen || []).map((d) => ({ ...d }));
  const sets = [];
  let dag = dagen.length ? dagen[0].id : "vr";
  let stage = null;
  let wachtendeTijd = null;
  const waarschuwingen = [];

  const regels = schoon.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);

  for (const regel of regels) {
    const dagTreffer = DAGWOORDEN.find((d) => d.test.test(regel) && !TIJDBEREIK.test(regel));
    if (dagTreffer && regel.length < 40) {
      if (dagen.some((d) => d.id === dagTreffer.id)) { dag = dagTreffer.id; stage = null; continue; }
    }

    const bereik = regel.match(TIJDBEREIK);
    if (bereik) {
      const naam = regel.replace(TIJDBEREIK, "").replace(/^[\s·|:\-–—>]+/, "").trim();
      const start = tijdTekst(bereik[1], bereik[2]);
      const eind = tijdTekst(bereik[3], bereik[4]);
      if (naam) {
        sets.push({ artiest: naam, soort: soortVan(naam), stage, dag, start, eind });
      } else {
        wachtendeTijd = { start, eind };
      }
      continue;
    }

    const enkel = regel.match(ENKELE_TIJD);
    if (enkel) { wachtendeTijd = { start: tijdTekst(enkel[1], enkel[2]), eind: null }; continue; }

    if (wachtendeTijd) {
      sets.push({ artiest: regel, soort: soortVan(regel), stage, dag,
                  start: wachtendeTijd.start, eind: wachtendeTijd.eind });
      wachtendeTijd = null;
      continue;
    }

    // Geen tijd, geen wachtende tijd: dit is een stagenaam
    if (regel.length <= 40) { stage = regel.replace(/^[#·|\-–—\s]+/, "").trim(); continue; }
    waarschuwingen.push(`Overgeslagen: "${regel.slice(0, 48)}"`);
  }

  // Ontbrekende eindtijden aanvullen met de start van de volgende set op dezelfde stage
  const perStage = {};
  for (const s of sets) (perStage[`${s.dag}|${s.stage}`] ||= []).push(s);
  for (const groep of Object.values(perStage)) {
    groep.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < groep.length - 1; i++) {
      if (!groep[i].eind) groep[i].eind = groep[i + 1].start;
    }
  }

  const stages = [...new Set(sets.map((s) => s.stage).filter(Boolean))];
  if (!sets.length) throw new Error("Geen sets herkend — controleer of de tijden meegekopieerd zijn.");

  return {
    festival: S.data.festival, locatie: S.data.locatie, tijdzone: S.data.tijdzone,
    utc_offset: offset(), status: "ingelezen",
    bijgewerkt: new Date().toISOString().slice(0, 16).replace("T", " "),
    bron: "Ingelezen in de app", dagen, stages, sets, waarschuwingen,
  };
}

function toonImportUitslag(data) {
  const bak = $("#import-uitslag");
  bak.innerHTML = "";
  const uit = maakEl("div", "uitslag");
  uit.appendChild(maakEl("div", "kop-uitslag", `${data.sets.length} sets herkend`));

  const lijst = maakEl("ul");
  for (const d of data.dagen) {
    const n = data.sets.filter((s) => s.dag === d.id).length;
    const stages = [...new Set(data.sets.filter((s) => s.dag === d.id).map((s) => s.stage))];
    lijst.appendChild(maakEl("li", null, `${d.naam}: ${n} sets, ${stages.length} stages`));
  }
  for (const w of (data.waarschuwingen || []).slice(0, 6)) lijst.appendChild(maakEl("li", "fout", w));
  uit.appendChild(lijst);

  const voorbeeld = data.sets.slice(0, 6)
    .map((s) => `${s.start}–${s.eind || "?"}  ${s.stage || "?"}  ${s.artiest}`).join("\n");
  const pre = maakEl("pre", null, voorbeeld);
  pre.style.cssText = "font-family:var(--mono);font-size:11px;color:var(--gedempt);overflow-x:auto";
  uit.appendChild(pre);

  const acties = maakEl("div", "acties");
  const opslaan = maakEl("button", "knop", "Gebruik op dit toestel");
  opslaan.onclick = () => {
    localStorage.setItem(OPSLAG.lokaal, JSON.stringify(data));
    S.data = data;
    S.data.herkomst = "eigen import";
    S.dag = (data.dagen[0] || {}).id;
    render();
    toonScherm("timetable");
  };
  acties.appendChild(opslaan);

  const publiceren = maakEl("button", "knop-vlak", "Ook op de server zetten");
  publiceren.onclick = async () => {
    const code = prompt("Publicatiecode (DRAAIMOLEN_CODE):",
                        localStorage.getItem(OPSLAG.code) || "");
    if (!code) return;
    localStorage.setItem(OPSLAG.code, code);
    try {
      const res = await fetch("/draaimolen/api/timetable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, data }),
      });
      const uitslag = await res.json();
      if (!res.ok) throw new Error(uitslag.detail || res.status);
      localStorage.removeItem(OPSLAG.lokaal);
      alert(`Op de server gezet: ${uitslag.sets} sets. Pushherinneringen gebruiken nu deze tijden.`);
      await haalTimetable();
      S.dag = (S.data.dagen[0] || {}).id;
      render();
      toonScherm("timetable");
    } catch (e) {
      alert(`Publiceren mislukt: ${e.message}`);
    }
  };
  acties.appendChild(publiceren);
  uit.appendChild(acties);
  bak.appendChild(uit);
}

// ── Start ───────────────────────────────────────────────────────────────────

function koppelKnoppen() {
  for (const knop of document.querySelectorAll(".balk-knop")) {
    knop.onclick = () => toonScherm(knop.dataset.scherm);
  }
  $("#knop-push").onclick = zetPushAan;
  $("#knop-ics").onclick = exporteerIcs;
  $("#knop-wis").onclick = () => {
    if (!S.fav.size || !confirm("Alle aangetikte artiesten wissen?")) return;
    S.fav.clear();
    bewaarFavorieten();
    render();
    syncAbonnement(true);
  };
  $("#knop-test").onclick = async () => {
    if (Notification.permission !== "granted") { await zetPushAan(); return; }
    if (S.sub) {
      const res = await fetch("/draaimolen/api/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: S.sub }),
      }).then((r) => r.json()).catch(() => ({ ok: false }));
      if (res.ok) return;
    }
    if (S.reg) S.reg.showNotification("Draaimolen", {
      body: "Zo ziet een setherinnering eruit.",
      icon: "/static/draaimolen/icon-192.png",
      data: { url: "/draaimolen/" },
    });
  };
  $("#knop-import").onclick = () => toonScherm("import");
  $("#knop-terug").onclick = () => toonScherm("meldingen");
  $("#knop-ververs").onclick = async () => {
    localStorage.removeItem(OPSLAG.lokaal);
    await haalTimetable();
    S.dag = (S.data.dagen[0] || {}).id;
    render();
    toonScherm("timetable");
  };
  $("#knop-lees").onclick = () => {
    const tekst = $("#plak").value;
    if (!tekst.trim()) return;
    try {
      toonImportUitslag(leesTimetable(tekst));
    } catch (e) {
      $("#import-uitslag").innerHTML = "";
      const fout = maakEl("div", "uitslag");
      fout.appendChild(maakEl("div", "kop-uitslag fout", "Inlezen mislukt"));
      fout.appendChild(maakEl("p", "uitleg", e.message));
      $("#import-uitslag").appendChild(fout);
    }
  };
}

function kiesStartdag() {
  const vandaag = new Date().toISOString().slice(0, 10);
  const dagen = S.data.dagen || [];
  const lopend = dagen.find((d) => d.datum >= vandaag);
  S.dag = (lopend || dagen[0] || {}).id;
}

async function start() {
  laadVoorkeuren();
  try {
    await haalTimetable();
  } catch {
    document.body.innerHTML =
      '<p style="padding:40px 18px;font-family:var(--tekst)">Timetable niet gevonden en geen offline kopie. ' +
      'Ga even online en herlaad.</p>';
    return;
  }
  kiesStartdag();
  koppelKnoppen();
  renderLeadChips();
  render();
  werkKnopBij();
  await registreerWorker();
  if (Notification.permission === "granted") {
    pushStatus(`Meldingen staan aan. Je krijgt ${S.lead} minuten van tevoren een seintje.`);
    planLokaleHerinneringen();
    syncAbonnement(true);
  }
  // Klok en "nu bezig" bijhouden
  setInterval(() => {
    $("#klok").textContent = klokTekst(nu());
    if (S.scherm === "timetable") renderLijst();
    if (S.scherm === "mijn") renderMijn();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { planLokaleHerinneringen(); render(); }
  });
}

start();

})();
