/* De Bouwkringloop — Scan app */
const CO2_PER_KG = 3.5;
function co2Label(kg) { return `${SVG.leaf} ${(kg * CO2_PER_KG).toFixed(1)} kg CO₂ bespaard`; }

const SVG = {
  chat: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  trash: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
  bell: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  leaf: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`,
};

const _BP = window._BP || "";
const token = localStorage.getItem("token");
if (!token) location.href = "/login?redirect=/";
document.documentElement.style.visibility = '';

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  if (res.status === 401) { localStorage.clear(); location.href = _BP + "/login"; return null; }
  return res;
}

function logout() { localStorage.clear(); location.href = _BP + "/login"; }

// Toon ingelogde gebruiker en beheer-link
const _role     = localStorage.getItem("role") || "user";
const _username = localStorage.getItem("username") || "";
const _gemeente = localStorage.getItem("gemeente") || "";
const _hdrUser  = document.getElementById("hdr-username");
if (_hdrUser && _username) _hdrUser.textContent = _username + (_gemeente ? ` · ${_gemeente}` : "");
if (_role === "superadmin") {
  const bl = document.getElementById("beheer-link");
  if (bl) bl.classList.remove("hidden");
}

// ── State ──────────────────────────────────────────────────────────────────────
let allItems        = [];
let stats           = null;
function _getUserId() {
  try { return parseInt(JSON.parse(atob(token.split('.')[1])).sub, 10) || 0; } catch { return 0; }
}
const _userId       = _getUserId();
const _isAdmin      = (_role === "admin" || _role === "superadmin");
let searchQuery     = "";
let activeMain      = "aanbieden";
let activeSubtab    = "aangeboden";
let adminGemeente   = "";
let currentItemId   = null;
let pendingFiles    = [];
const MAX_FOTOS     = 4;
let _listPage       = 0;
const _PAGE_SIZE    = 15;

// ── Admin layout ───────────────────────────────────────────────────────────────
if (_isAdmin) {
  document.getElementById("list-user-tabs").style.display = "none";
  document.getElementById("list-admin-filter").style.display = "block";
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
// Dashboard-tab: vooraf geladen iframe → wisselen is een pure schermwissel (instant)
function _laadDashboardFrame() {
  const fr = document.getElementById("dash-frame");
  if (fr && !fr.src) fr.src = "/dashboard?embed=1";
}
setTimeout(_laadDashboardFrame, 1200);   // preload zodra de app tot rust is

document.querySelectorAll(".tabbar-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbar-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "list") renderItems();
    if (btn.dataset.tab === "scan") resetScan();
    if (btn.dataset.tab === "stats") _laadDashboardFrame();
  });
});

// Direct een tab openen via ?tab=... (bijv. vanaf de dashboard-onderbalk)
(function () {
  const t = new URLSearchParams(location.search).get("tab");
  if (t === "list") document.querySelector('[data-tab="list"]')?.click();
})();

// ── Sync ───────────────────────────────────────────────────────────────────────
let _lastItemsJson = "";
let _syncInFlight  = false;

function _listTabActive() {
  return document.getElementById("tab-list")?.classList.contains("active");
}

let _itemsGeladen = false;   // pas na de eerste succesvolle fetch "Geen items" tonen

async function syncItems() {
  if (_syncInFlight) return;
  _syncInFlight = true;
  try {
    const url = _isAdmin
      ? "/api/items?limit=200&offset=0"
      : "/api/items?limit=50&offset=0";
    const res = await apiFetch(url);
    if (!res || !res.ok) return;
    const nieuw = await res.json();
    const eersteKeer = !_itemsGeladen;
    _itemsGeladen = true;
    const hash = `${nieuw.length}_${nieuw[0]?.id || 0}_${nieuw[nieuw.length - 1]?.id || 0}`;
    if (hash === _lastItemsJson && !eersteKeer) return;
    _lastItemsJson = hash;
    allItems = nieuw;
    if (_isAdmin) _vulGemeenteDropdown();
    if (_listTabActive()) renderItems();
  } finally {
    _syncInFlight = false;
  }
}

function _vulGemeenteDropdown() {
  const sel = document.getElementById("admin-gemeente-select");
  const gemeenten = [...new Set(allItems.map(i => i.gemeente).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">Alle gemeenten</option>' +
    gemeenten.map(g => `<option value="${_esc(g)}"${g === current ? " selected" : ""}>${_esc(g)}</option>`).join("");
}

document.getElementById("admin-gemeente-select").addEventListener("change", e => {
  adminGemeente = e.target.value;
  _listPage = 0;
  renderItems();
});
async function syncStats() {
  const gem = document.getElementById("stats-gemeente-sel")?.value || "";
  const url = gem ? `/api/stats?gemeente=${encodeURIComponent(gem)}` : "/api/stats";
  const res = await apiFetch(url);
  if (!res || !res.ok) return;
  stats = await res.json();
  renderStats();
}

async function _vulStatsGemeenteFilter() {
  if (_role !== "superadmin") return;
  const wrap = document.getElementById("stats-gemeente-filter");
  if (!wrap) return;
  wrap.style.display = "block";
  const res = await apiFetch("/api/gemeenten/stats");
  if (!res || !res.ok) return;
  const data = await res.json();
  _gemeenteStats = data;
  const sel = document.getElementById("stats-gemeente-sel");
  const huidig = sel.value;
  sel.innerHTML = '<option value="">Alle gemeenten</option>' +
    data.map(g => `<option value="${_esc(g.gemeente)}">${_esc(g.gemeente)}</option>`).join("");
  if (huidig) sel.value = huidig;
  sel.onchange = () => { syncStats(); if (_isAdmin) syncNetwerk(); };
}
function syncAll() { syncItems(); }

// ── Gemeenten voor kiezer ───────────────────────────────────────────────────────
let _allGemeenten = [];
let _huidigItemId = null;
let _huidigCategory = null;

let _milieustraten = {}; // { gemeente: [milieustraat, ...] }

function _vulMilieustraatSelect(sel, gemeente, huidig) {
  const lijst = (_milieustraten[gemeente] || []);
  if (!lijst.length) { sel.style.display = "none"; return; }
  sel.innerHTML = '<option value="">— Selecteer milieustraat —</option>' +
    lijst.map(m => `<option value="${_esc(m)}"${m === huidig ? " selected" : ""}>${_esc(m)}</option>`).join("");
  sel.style.display = "";
  if (lijst.length === 1) sel.value = lijst[0]; // auto-select als er maar 1 is
}

async function laadGemeenten() {
  const [gemRes, milRes] = await Promise.all([
    apiFetch("/api/gemeenten"),
    apiFetch("/api/milieustraten"),
  ]);
  if (!gemRes || !gemRes.ok) return;
  _allGemeenten = await gemRes.json();
  if (milRes && milRes.ok) _milieustraten = await milRes.json();

  // (De gemeente-kiezer in de scan-flow is verwijderd: bedrijven volgen de
  //  accountscope; koppeling bedrijf↔gemeente wordt centraal beheerd.)

  // ── Gebruikerspaneel selects ─────────────────────────────────────────────
  const upGem = document.getElementById("up-gemeente");
  if (upGem) {
    upGem.innerHTML = '<option value="">— Selecteer gemeente —</option>' +
      _allGemeenten.map(g => `<option value="${_esc(g)}">${_esc(g)}</option>`).join("");
    upGem.addEventListener("change", function () {
      const upMil = document.getElementById("up-milieustraat");
      if (upMil) _vulMilieustraatSelect(upMil, this.value, "");
    });
  }
}

let _scanBedrijven = []; // huidige lijst in scan-flow, herordeerbaar

async function laadBedrijvenVoorGemeente(gemeente, itemId, category) {
  const res = await apiFetch(`/api/bedrijven-voor-scan?gemeente=${encodeURIComponent(gemeente)}&category=${encodeURIComponent(category || "")}&item_id=${itemId}`);
  if (!res || !res.ok) return;
  const bedrijven = await res.json();
  _scanBedrijven = bedrijven;
  _renderBedrijvenLijst(itemId);
}

function _scanBedrijfOmhoog(i) {
  if (i === 0) return;
  [_scanBedrijven[i - 1], _scanBedrijven[i]] = [_scanBedrijven[i], _scanBedrijven[i - 1]];
  _renderBedrijvenLijst(_huidigItemId);
}

function _scanBedrijfOmlaag(i) {
  if (i === _scanBedrijven.length - 1) return;
  [_scanBedrijven[i], _scanBedrijven[i + 1]] = [_scanBedrijven[i + 1], _scanBedrijven[i]];
  _renderBedrijvenLijst(_huidigItemId);
}

async function aanbiedenAanSelectie(itemId) {
  const ids = [...document.querySelectorAll(".scan-bedrijf-check:checked")].map(c => parseInt(c.value, 10));
  if (!ids.length) { alert("Selecteer minstens één bedrijf."); return; }
  const btn = document.getElementById("btn-aanbied-selectie");
  if (btn) { btn.disabled = true; btn.textContent = "Bezig…"; }
  const res = await apiFetch("/api/aanbiedingen/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id: itemId, bedrijf_ids: ids }),
  });
  if (res && res.ok) {
    const data = await res.json();
    const gekozen = _scanBedrijven.filter(b => ids.includes(b.id));
    const label = gekozen.length === 1 ? gekozen[0].naam : `${gekozen.length} bedrijven`;
    _markeerAangeboden(itemId, label, data?.ids?.[0]);
    syncItems();
    _toonSucces("Aangeboden!", `Het item is aangeboden aan: ${gekozen.map(b => b.naam).join(", ")}.`);
  } else {
    if (btn) { btn.disabled = false; btn.textContent = "Opnieuw proberen"; }
  }
}

function _scanToggleAlle(aan) {
  document.querySelectorAll(".scan-bedrijf-check").forEach(c => { c.checked = aan; });
}

function _renderBedrijvenLijst(itemId, external) {
  // external = array als het direct vanuit analyse-resultaat komt (voor achterwaartse compatibiliteit)
  if (external) { _scanBedrijven = external; }
  const bedrijvenLijst = document.getElementById("bedrijven-lijst");
  const bedrijvenCard  = document.getElementById("bedrijven-card");
  if (!_scanBedrijven.length) {
    bedrijvenLijst.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;padding:8px 0;">Geen bedrijven gevonden voor deze gemeente.</p>`;
    bedrijvenCard.classList.remove("hidden");
    return;
  }
  bedrijvenLijst.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-size:0.72rem;color:var(--muted);">Kies één of meer bedrijven</span>
      <span style="font-size:0.72rem;">
        <a onclick="_scanToggleAlle(true)" style="color:var(--orange);cursor:pointer;font-weight:600;">Alles</a>
        &nbsp;·&nbsp;
        <a onclick="_scanToggleAlle(false)" style="color:var(--muted);cursor:pointer;">Geen</a>
      </span>
    </div>
    ${_scanBedrijven.map((b) => `
    <label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer;">
      <input type="checkbox" class="scan-bedrijf-check" value="${b.id}" ${(b.historie_count > 0 || b.categorie_match) ? "checked" : ""} style="width:18px;height:18px;flex-shrink:0;accent-color:var(--orange);">
      <span style="flex:1;">
        <span style="font-weight:600;font-size:0.88rem;">${_esc(b.naam)}</span>
        ${b.historie_count > 0 ? `<span style="font-size:0.6rem;font-weight:700;background:#fff3e0;color:#b4531a;padding:2px 7px;border-radius:100px;margin-left:6px;">★ haalde dit ${b.historie_count}× eerder op</span>`
          : (b.categorie_match ? `<span style="font-size:0.6rem;font-weight:700;background:#e8f5e9;color:#2e7d32;padding:2px 7px;border-radius:100px;margin-left:6px;">Match</span>` : "")}
        ${(b.contactpersoon || b.telefoon) ? `<span style="display:block;font-size:0.75rem;color:var(--muted);margin-top:2px;">${b.contactpersoon ? _esc(b.contactpersoon) : ""}${b.telefoon ? ` · ${_esc(b.telefoon)}` : ""}</span>` : ""}
      </span>
    </label>`).join("")}
    <button id="btn-aanbied-selectie" class="btn btn-primary" style="width:100%;margin-top:14px;"
      onclick="aanbiedenAanSelectie(${itemId})">
      Aanbieden aan geselecteerde bedrijven
    </button>`;
  bedrijvenCard.classList.remove("hidden");
}


// ── Camera ─────────────────────────────────────────────────────────────────────
const cameraInput = document.getElementById("camera-input");
const previewWrap   = document.getElementById("preview-wrap");
const previewThumbs = document.getElementById("preview-thumbs");
const addPhotoInput = document.getElementById("add-photo-input");
const analyseBtn  = document.getElementById("analyse-btn");
const resultCard  = document.getElementById("result-card");
const scanError   = document.getElementById("scan-error");
const locatieTxt  = document.getElementById("locatie-txt");
const scanHero    = document.getElementById("scan-hero");

function _voegFotosToe(fileList) {
  for (const f of fileList) {
    if (!f || !f.type || !f.type.startsWith("image/")) continue;
    if (pendingFiles.length >= MAX_FOTOS) break;
    pendingFiles.push(f);
  }
  if (!pendingFiles.length) return;
  _startGemeentePrefetch();   // locatie alvast bepalen terwijl de gebruiker foto's bekijkt
  scanHero.classList.add("hidden");
  previewWrap.classList.remove("hidden");
  analyseBtn.classList.remove("hidden");
  resultCard.classList.add("hidden");
  scanError.classList.add("hidden");
  _renderThumbs();
}

function _renderThumbs() {
  previewThumbs.innerHTML = "";
  pendingFiles.forEach((f, i) => {
    const cell = document.createElement("div");
    cell.className = "preview-thumb";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(f);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "preview-thumb-del";
    del.innerHTML = "&times;";
    del.setAttribute("aria-label", "Verwijder foto");
    del.addEventListener("click", () => {
      pendingFiles.splice(i, 1);
      if (!pendingFiles.length) resetScan(); else _renderThumbs();
    });
    cell.appendChild(img);
    cell.appendChild(del);
    previewThumbs.appendChild(cell);
  });
  if (pendingFiles.length < MAX_FOTOS) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "preview-thumb-add";
    add.innerHTML = "+";
    add.setAttribute("aria-label", "Foto toevoegen");
    add.addEventListener("click", () => addPhotoInput.click());
    previewThumbs.appendChild(add);
  }
}

cameraInput.addEventListener("change", () => { _voegFotosToe(cameraInput.files); cameraInput.value = ""; });
if (addPhotoInput) addPhotoInput.addEventListener("change", () => { _voegFotosToe(addPhotoInput.files); addPhotoInput.value = ""; });

function resetScan() {
  pendingFiles = [];
  _gpsPrefetch = null;   // locatie opnieuw bepalen bij de volgende scan
  cameraInput.value = "";
  if (addPhotoInput) addPhotoInput.value = "";
  previewThumbs.innerHTML = "";
  scanHero.classList.remove("hidden");
  previewWrap.classList.add("hidden");
  analyseBtn.classList.add("hidden");
  resultCard.classList.add("hidden");
  scanError.classList.add("hidden");
  locatieTxt.classList.add("hidden");
  document.getElementById("bedrijven-card").classList.add("hidden");
  _huidigItemId = null; _huidigCategory = null;
}

// ── GPS ────────────────────────────────────────────────────────────────────────
function getGPSLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      ()  => resolve(null),
      { timeout: 6000, maximumAge: 60000 }
    );
  });
}

async function getGemeenteFromCoords(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { "Accept-Language": "nl" } }
    );
    const data = await res.json();
    const addr = data.address || {};
    return addr.municipality || addr.city || addr.town || addr.village || null;
  } catch { return null; }
}

// ── Titel + beschrijving bewerken (AI-suggestie → eigen tekst) ─────────────────
["result-label", "result-detail"].forEach(id =>
  document.getElementById(id).addEventListener("input", () => {
    document.getElementById("result-bewerk-opslaan").classList.remove("hidden");
  }));
document.getElementById("result-bewerk-opslaan").addEventListener("click", async () => {
  if (!_huidigItemId) return;
  const btn = document.getElementById("result-bewerk-opslaan");
  btn.disabled = true; btn.textContent = "Opslaan…";
  const fd = new FormData();
  fd.append("ai_label", document.getElementById("result-label").value.trim());
  fd.append("ai_detail", document.getElementById("result-detail").value.trim());
  const res = await apiFetch(`/api/items/${_huidigItemId}`, { method: "PATCH", body: fd });
  btn.disabled = false;
  if (res && res.ok) {
    btn.textContent = "✓ Opgeslagen";
    syncItems();
    setTimeout(() => { btn.classList.add("hidden"); btn.textContent = "✓ Aanpassing opslaan"; }, 1400);
  } else {
    btn.textContent = "Opslaan mislukt — probeer opnieuw";
    setTimeout(() => { btn.textContent = "✓ Aanpassing opslaan"; }, 2200);
  }
});

// ── Foto's comprimeren vóór upload (grote winst op mobiel netwerk) ─────────────
async function _comprimeer(file, maxPx = 1280, kwaliteit = 0.8) {
  try {
    const bmp = await createImageBitmap(file);
    const schaal = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    if (schaal === 1 && file.size < 400 * 1024) return file;   // al klein genoeg
    const cvs = document.createElement("canvas");
    cvs.width = Math.round(bmp.width * schaal);
    cvs.height = Math.round(bmp.height * schaal);
    cvs.getContext("2d").drawImage(bmp, 0, 0, cvs.width, cvs.height);
    const blob = await new Promise(r => cvs.toBlob(r, "image/jpeg", kwaliteit));
    return blob && blob.size < file.size ? new File([blob], file.name || "foto.jpg", { type: "image/jpeg" }) : file;
  } catch (e) { return file; }   // compressie is best-effort
}

// ── Analyseren ─────────────────────────────────────────────────────────────────
// GPS + gemeente alvast bepalen zodra er foto's zijn — dan is dat klaar
// tegen de tijd dat de gebruiker op Analyseren tikt
let _gpsPrefetch = null;
function _startGemeentePrefetch() {
  if (_gpsPrefetch) return;
  _gpsPrefetch = (async () => {
    const gps = await getGPSLocation();
    return gps ? await getGemeenteFromCoords(gps.lat, gps.lon) : null;
  })();
}

analyseBtn.addEventListener("click", async () => {
  if (!pendingFiles.length) return;
  analyseBtn.disabled = true;
  const analyseTxt = document.getElementById("analyse-txt");
  analyseTxt.textContent = "Voorbereiden…";
  resultCard.classList.add("hidden");
  scanError.classList.add("hidden");

  // Compressie en locatiebepaling parallel (locatie is meestal al voorgeladen)
  _startGemeentePrefetch();
  const [gecomprimeerd, detectedGemeente] = await Promise.all([
    Promise.all(pendingFiles.map(f => _comprimeer(f))),
    _gpsPrefetch,
  ]);
  analyseTxt.textContent = "AI analyseert…";

  if (detectedGemeente) {
    locatieTxt.textContent = `Locatie: ${detectedGemeente}`;
    locatieTxt.classList.remove("hidden");
  } else {
    locatieTxt.classList.add("hidden");
  }

  try {
    const fd = new FormData();
    gecomprimeerd.forEach(f => fd.append("files", f));
    if (detectedGemeente) fd.append("gemeente_override", detectedGemeente);
    const res = await apiFetch("/api/upload", { method: "POST", body: fd });
    if (!res || !res.ok) {
      const err = res ? await res.json().catch(() => ({ detail: res.statusText })) : { detail: "Geen verbinding" };
      throw new Error(err.detail || res?.statusText);
    }
    const item = await res.json();
    document.getElementById("result-label").value = item.ai_label || "";
    document.getElementById("result-bewerk-opslaan").classList.add("hidden");
    document.getElementById("result-weight").textContent = "";
    const co2El = document.getElementById("result-co2");
    if (false && item.gewicht_kg != null) {
      co2El.textContent = co2Label(item.gewicht_kg);
      co2El.classList.remove("hidden");
    } else {
      co2El.classList.add("hidden");
    }
    // Beschrijving als AI-suggestie in een bewerkbaar veld
    document.getElementById("result-detail").value = item.ai_detail || "";

    const acceptatieBadge = document.getElementById("result-acceptatie");
    acceptatieBadge.className = "result-acceptatie hidden";

    resultCard.classList.remove("hidden");

    // Toon gekoppelde bedrijven met aanbieden-knop (scope = account/organisatie)
    _huidigItemId   = item.id;
    _huidigCategory = item.category || "";
    if (item.bedrijven && item.bedrijven.length) {
      _renderBedrijvenLijst(item.id, item.bedrijven);
    } else {
      document.getElementById("bedrijven-card").classList.add("hidden");
    }

    allItems.unshift(item);
    if (stats) { stats.total++; stats.today++; }
    pendingFiles = [];
    cameraInput.value = "";
    if (addPhotoInput) addPhotoInput.value = "";
    previewThumbs.innerHTML = "";
    previewWrap.classList.add("hidden");
    analyseBtn.classList.add("hidden");
  } catch (err) {
    scanError.textContent = "Fout: " + err.message;
    scanError.classList.remove("hidden");
  } finally {
    analyseBtn.disabled = false;
    analyseTxt.textContent = "Analyseren \u0026 opslaan";
  }
});

// ── Aanbieden ─────────────────────────────────────────────────────────────────
function _markeerAangeboden(itemId, bedrijfNaam, aanbiedingId) {
  const item = allItems.find(i => i.id === itemId);
  if (item) {
    item.aanbieding_status = "open";
    item.bedrijf_naam      = bedrijfNaam || null;
    if (aanbiedingId) item.aanbieding_id = aanbiedingId;
  }
  renderItems();
}

function _toonSucces(titel, tekst) {
  document.getElementById("succes-titel").textContent = titel;
  document.getElementById("succes-tekst").textContent = tekst;
  const el = document.getElementById("succes-overlay");
  el.style.display = "flex";
}

function sluitSucces() {
  document.getElementById("succes-overlay").style.display = "none";
  resetScan();
}

async function aanbieden(itemId, bedrijfId) {
  const btn = document.getElementById(`btn-aanbied-${bedrijfId}`);
  if (btn) { btn.disabled = true; btn.textContent = "Bezig…"; }
  const fd = new FormData();
  fd.append("item_id", itemId);
  fd.append("bedrijf_id", bedrijfId);
  const res = await apiFetch("/api/aanbiedingen", { method: "POST", body: fd });
  if (res && res.ok) {
    const data = await res.json();
    const bedrijf = _scanBedrijven.find(b => b.id === bedrijfId);
    const bedrijfNaam = bedrijf ? bedrijf.naam : "het bedrijf";
    _markeerAangeboden(itemId, bedrijfNaam, data?.id);
    syncItems();
    _toonSucces("Aangeboden!", `Het item is aangeboden aan ${bedrijfNaam}.`);
  } else {
    if (btn) { btn.disabled = false; btn.textContent = "Opnieuw proberen"; }
  }
}

// ── Lijst ──────────────────────────────────────────────────────────────────────
// Main tabs (Aanbieden / Ontvangen)
document.querySelectorAll(".list-maintab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".list-maintab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeMain = btn.dataset.main;
    document.getElementById("tab-list").dataset.main = activeMain;
    // Reset subtab naar eerste optie van de nieuwe sectie
    const subWrap = document.getElementById(`subtabs-${activeMain}`);
    document.getElementById("subtabs-aanbieden").style.display = activeMain === "aanbieden" ? "" : "none";
    document.getElementById("subtabs-ontvangen").style.display = activeMain === "ontvangen" ? "" : "none";
    const first = subWrap.querySelector(".list-subtab");
    subWrap.querySelectorAll(".list-subtab").forEach(b => b.classList.remove("active"));
    if (first) { first.classList.add("active"); activeSubtab = first.dataset.subtab; }
    _listPage = 0;
    renderItems();
  });
});

// Sub tabs
document.querySelectorAll(".list-subtab").forEach(btn => {
  btn.addEventListener("click", () => {
    btn.closest(".list-subtabs").querySelectorAll(".list-subtab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeSubtab = btn.dataset.subtab;
    _listPage = 0;
    renderItems();
  });
});

function _hasUnread(item) {
  if (!item.bericht_count || !item.last_bericht_at || !item.aanbieding_id) return false;
  const lastRead = localStorage.getItem(`chat_read_${item.aanbieding_id}`);
  if (!lastRead) return true;
  return item.last_bericht_at > lastRead;
}

function renderItems() {
  const list = document.getElementById("items-list");
  const q = searchQuery.toLowerCase();
  let source;

  if (_isAdmin) {
    source = adminGemeente
      ? allItems.filter(i => i.gemeente === adminGemeente)
      : allItems;
  } else if (activeMain === "aanbieden") {
    if (activeSubtab === "reacties") {
      source = allItems.filter(i =>
        !i.aangeboden_door_naam && i.aanbieding_id && i.aanbieding_status && i.aanbieding_status !== "open"
      );
    } else {
      // "Door mij aangeboden": eigen items die aangeboden zijn (hebben aanbieding_id, niet ontvangen van iemand anders)
      source = allItems.filter(i => i.aanbieding_id && !i.aangeboden_door_naam);
    }
  } else {
    // Ontvangen: items aangeboden ÁÁN mij (heeft aangeboden_door_naam) of voor user-rol leeg
    const ontvangenItems = _role === "bedrijf"
      ? allItems.filter(i => !!i.aangeboden_door_naam)
      : [];
    source = activeSubtab === "mijn-reacties"
      ? ontvangenItems.filter(i => i.aanbieding_status && i.aanbieding_status !== "open")
      : ontvangenItems;
  }

  const filtered = q
    ? source.filter(i =>
        (i.ai_label || "").toLowerCase().includes(q) ||
        (i.manual_note || "").toLowerCase().includes(q) ||
        (i.category || "").toLowerCase().includes(q) ||
        (i.gemeente || "").toLowerCase().includes(q))
    : source;
  if (!filtered.length) {
    // Nog aan het laden? Dan een laadindicatie i.p.v. verwarrend "geen items"
    list.innerHTML = _itemsGeladen
      ? `<p style="padding:24px 16px;color:var(--muted);">Geen items gevonden.</p>`
      : `<div style="display:flex;align-items:center;gap:10px;padding:24px 16px;color:var(--muted);">
           <span class="laad-spinner"></span> Items laden…
         </div>`;
    return;
  }
  const totalPages = Math.ceil(filtered.length / _PAGE_SIZE);
  if (_listPage >= totalPages) _listPage = totalPages - 1;
  const pagina = filtered.slice(_listPage * _PAGE_SIZE, (_listPage + 1) * _PAGE_SIZE);
  const kanVerwijderen = !_isAdmin && activeMain === "aanbieden" && !_isAdmin;
  list.innerHTML = pagina.map(item => {
    const rij = `
      <div class="item-row" onclick="openModal(${item.id})">
        <img class="item-thumb" src="${_esc(item.photo_url_thumb || item.photo_url)}" alt="" onerror="this.style.opacity=0" loading="lazy" decoding="async">
        <div class="item-info">
          <div class="item-name">${_esc(item.ai_label || "Niet herkend")}</div>
          <div class="item-meta">
            ${item.category ? `<span class="item-cat">${_esc(item.category)}</span>` : ""}
            ${_isAdmin && item.gemeente ? `<span class="item-cat" style="background:#e8f0fe;border-color:#c5d2f6;">${_esc(item.gemeente)}</span>` : ""}
            <span>${formatTime(item.timestamp)}</span>
            ${item.aangeboden_door_naam ? `<span class="aanbieder-van">${_esc(item.aangeboden_door_naam)}</span>` : ""}
            ${item.aangeboden_door_naam && item.bedrijf_naam ? `<span class="aanbieder-pijl">›</span>` : ""}
            ${item.bedrijf_naam ? `<span class="aanbieder-aan">${_esc(item.bedrijf_naam)}</span>` : ""}
          </div>
        </div>
        ${item.aanbieding_id ? `<span class="item-chat-icon${_hasUnread(item) ? ' has-unread' : ''}" onclick="event.stopPropagation();openModal(${item.id},true)">${SVG.chat}</span>` : ""}
        <span class="item-chevron">›</span>
      </div>`;
    if (!kanVerwijderen) return rij;
    return `
    <div class="swipe-wrap" data-id="${item.id}">
      <button class="swipe-del-btn" onclick="vraagVerwijderen(${item.id}, this)">${SVG.trash}</button>
      ${rij}
    </div>`;
  }).join("");
  if (kanVerwijderen && !_swipeReady) { _initSwipe(); _swipeReady = true; }

  if (totalPages > 1) {
    const from = _listPage * _PAGE_SIZE + 1;
    const to   = Math.min(from + pagina.length - 1, filtered.length);
    const nav  = document.createElement("div");
    nav.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:14px 16px 4px;gap:8px;";
    nav.innerHTML = `
      <button onclick="_goPagina(${_listPage - 1})" ${_listPage === 0 ? "disabled" : ""}
        style="padding:9px 18px;border:1px solid var(--border);border-radius:100px;background:none;font-family:'Inter',sans-serif;font-size:0.72rem;font-weight:700;color:var(--muted);cursor:pointer;${_listPage === 0 ? "opacity:0.3;cursor:default;" : ""}">
        ← Vorige
      </button>
      <span style="font-size:0.7rem;color:var(--muted);">${from}–${to} van ${filtered.length}</span>
      <button onclick="_goPagina(${_listPage + 1})" ${_listPage >= totalPages - 1 ? "disabled" : ""}
        style="padding:9px 18px;border:1px solid var(--border);border-radius:100px;background:none;font-family:'Inter',sans-serif;font-size:0.72rem;font-weight:700;color:var(--muted);cursor:pointer;${_listPage >= totalPages - 1 ? "opacity:0.3;cursor:default;" : ""}">
        Volgende →
      </button>`;
    list.appendChild(nav);
  }
}

function _goPagina(page) {
  _listPage = page;
  document.getElementById("items-list").parentElement.scrollTop = 0;
  renderItems();
}

document.getElementById("search-input").addEventListener("input", e => {
  searchQuery = e.target.value;
  _listPage = 0;
  renderItems();
});

// ── Stats ──────────────────────────────────────────────────────────────────────
let _gemeenteStats = null;

function renderStats() {
  if (!stats || !stats.categories) return;
  document.getElementById("s-total").textContent = stats.total ?? "–";
  document.getElementById("s-today").textContent = stats.today ?? "–";
  document.getElementById("s-kg").textContent    = (stats.totaal_kg ?? "–") + " kg";
  const totalCo2 = stats.totaal_kg != null ? (stats.totaal_kg * CO2_PER_KG).toFixed(1) : "–";
  document.getElementById("s-co2").textContent   = totalCo2 !== "–" ? totalCo2 + " kg" : "–";
  const catList = document.getElementById("categories-list");
  if (catList) {
    catList.innerHTML = stats.categories.length
      ? stats.categories.map(c => `
          <div class="cat-row">
            <span class="cat-name">${_esc(c.category)}</span>
            <span class="cat-count">${c.count}x${c.kg ? ' · ' + Math.round(c.kg) + ' kg' : ''}</span>
          </div>`).join("")
      : `<p style="color:var(--muted);font-size:0.9rem;padding:16px;">Nog geen categorieën.</p>`;
  }
  if (_role === "superadmin") renderGemeenteStats();
  renderDeelnemers();
}

async function renderDeelnemers() {
  const wrap = document.getElementById("deelnemers-list");
  if (!wrap) return;
  try {
    const res = await apiFetch("/api/deelnemers");
    if (!res || !res.ok) return;
    const data = await res.json();
    if (!data.bedrijven || !data.bedrijven.length) return;
    wrap.innerHTML = `
      <div class="deelnemers-header">Deelnemende bedrijven</div>
      ${data.bedrijven.map(b => `
        <div class="deelnemer-row">
          <div>
            <div class="deelnemer-naam">${_esc(b.naam)}</div>
            <div class="deelnemer-gem">${_esc(b.gemeente)}</div>
            <div class="deelnemer-cats">${(b.categorieen || []).map(c => `<span class="deelnemer-cat">${_esc(c)}</span>`).join("")}</div>
          </div>
        </div>`).join("")}
    `;
  } catch(e) {}
}

async function renderGemeenteStats() {
  const wrap = document.getElementById("gemeente-stats-list");
  if (!wrap) return;
  if (!_gemeenteStats) {
    const res = await apiFetch("/api/gemeenten/stats");
    if (!res || !res.ok) return;
    _gemeenteStats = await res.json();
  }
  const selected = document.getElementById("stats-gemeente-sel")?.value || "";
  const lijst = selected ? _gemeenteStats.filter(g => g.gemeente === selected) : _gemeenteStats;
  if (!lijst.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `
    <div class="gem-stats-header">Per gemeente</div>
    ${lijst.map(g => {
      const co2 = ((g.totaal_kg ?? 0) * CO2_PER_KG).toFixed(1);
      const kg  = (g.totaal_kg ?? 0).toFixed(1);
      const pct = _gemeenteStats.length ? Math.round((g.totaal_kg ?? 0) / Math.max(..._gemeenteStats.map(x => x.totaal_kg ?? 0)) * 100) : 0;
      return `
      <div class="gem-stat-row">
        <div class="gem-stat-top">
          <span class="gem-stat-naam">${_esc(g.gemeente)}</span>
          <span class="gem-stat-items">${g.item_count} items</span>
        </div>
        <div class="gem-stat-bars">
          <div class="gem-bar-wrap">
            <div class="gem-bar gem-bar-kg" style="width:${pct}%"></div>
            <span class="gem-bar-label">${kg} kg</span>
          </div>
          <div class="gem-bar-wrap">
            <div class="gem-bar gem-bar-co2" style="width:${pct}%"></div>
            <span class="gem-bar-label co2">${co2} kg CO₂</span>
          </div>
        </div>
      </div>`;
    }).join("")}
  `;
}

// ── Netwerk visualisatie ───────────────────────────────────────────────────────
const CAT_COLORS = {
  "Bouwmateriaal":          "#b5562e",
  "Gereedschap & machines": "#607D8B",
  "Meubels":                "#8B5E3C",
  "Sanitair & keuken":      "#4FC3F7",
  "Elektronica":            "#5C6BC0",
  "Verlichting":            "#c9a227",
  "Tuin & buiten":          "#4c9f70",
  "Huishoud & servies":     "#81C784",
  "Kleding & textiel":      "#8a6fb0",
  "Fietsen & vervoer":      "#e67026",
  "Speelgoed & spel":       "#d1495b",
  "Gemengde partij":        "#9E9E9E",
  "Overig":                 "#FFB74D",
};

async function syncNetwerk() {
  if (!_isAdmin) return;
  const gem = document.getElementById("stats-gemeente-sel")?.value || "";
  const url = gem ? `/api/netwerk?gemeente=${encodeURIComponent(gem)}` : "/api/netwerk";
  const res = await apiFetch(url);
  if (!res || !res.ok) return;
  const data = await res.json();
  renderNetwerk(data);
}

function renderNetwerk(data) {
  const wrap = document.getElementById("netwerk-wrap");
  if (wrap) wrap.style.display = "none";
}

// ── Carousel ───────────────────────────────────────────────────────────────────
let _carouselUrls = [];
let _carouselIdx  = 0;

function _initCarousel(item) {
  let urls = item.photo_urls;
  if (typeof urls === "string") { try { urls = JSON.parse(urls); } catch { urls = null; } }
  if (!Array.isArray(urls) || urls.length < 2) urls = [item.photo_url].filter(Boolean);
  _carouselUrls = urls;
  _carouselIdx  = 0;
  _renderCarousel();
}

function _renderCarousel() {
  const img   = document.getElementById("modal-img");
  const prev  = document.getElementById("carousel-prev");
  const next  = document.getElementById("carousel-next");
  const dots  = document.getElementById("carousel-dots");
  const multi = _carouselUrls.length > 1;

  img.src = _carouselUrls[_carouselIdx] || "";
  prev.classList.toggle("visible", multi && _carouselIdx > 0);
  next.classList.toggle("visible", multi && _carouselIdx < _carouselUrls.length - 1);

  dots.innerHTML = multi
    ? _carouselUrls.map((_, i) =>
        `<div class="carousel-dot${i === _carouselIdx ? " active" : ""}"></div>`
      ).join("")
    : "";
}

function carouselStep(dir) {
  _carouselIdx = Math.max(0, Math.min(_carouselUrls.length - 1, _carouselIdx + dir));
  _renderCarousel();
}

// ── Modal ──────────────────────────────────────────────────────────────────────
async function openModal(id, scrollToChat = false) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  currentItemId = id;
  _initCarousel(item);
  document.getElementById("modal-label").textContent  = item.ai_label || "Niet herkend";
  document.getElementById("modal-weight").textContent = "";
  document.getElementById("modal-co2").textContent = "";
  document.getElementById("modal-detail").textContent = item.ai_detail || "";
  document.getElementById("modal-ts").textContent     = new Date(item.timestamp).toLocaleString("nl-NL");
  document.getElementById("modal-note").value  = item.manual_note || "";
  document.getElementById("modal-cat").value   = item.category || "";

  // Ontvanger: bedrijf-rol én item is aangeboden ÁÁN dit bedrijf
  const isOntvanger = _role === "bedrijf" && !!item.aanbieding_id && !!item.aangeboden_door_naam;
  // Aanbieder: de ingelogde gebruiker heeft dit item zelf aangeboden (geen bedrijf-rol)
  const isAanbieder = !!item.aanbieding_id && !item.aangeboden_door_naam;
  document.getElementById("modal-bedrijf-acties").style.display    = isOntvanger ? "block" : "none";
  document.getElementById("modal-aanbieder-reactie").style.display = "none";
  document.getElementById("modal-edit-acties").style.display       = isOntvanger ? "none" : "block";
  document.getElementById("modal-bewerk-velden").style.display     = isOntvanger ? "none" : "block";
  if (isOntvanger) {
    document.getElementById("modal-aanbieder").textContent =
      `Aangeboden door: ${item.aangeboden_door_naam || "CIRQO"}`;
    const statusLabel = { open: "In afwachting", ophalen: "Wordt opgehaald ✓", niet_nodig: "Niet nodig" };
    document.getElementById("modal-aanbieding-status").textContent = statusLabel[item.aanbieding_status] || "";
    document.getElementById("modal-btn-ophalen").onclick    = () => reagerenOpAanbieding(item.aanbieding_id, "ophalen",    id);
    document.getElementById("modal-btn-niet-nodig").onclick = () => reagerenOpAanbieding(item.aanbieding_id, "niet_nodig", id);
  } else if (item.aanbieding_id && item.bedrijf_naam) {
    document.getElementById("modal-aanbieder").textContent = `Aangeboden aan ${item.bedrijf_naam}`;
    document.getElementById("modal-aanbieding-status").textContent = "";
  }

  document.getElementById("modal").classList.remove("hidden");

  // Chat: toon voor bedrijf (altijd) of admin (zodra er een aanbieding is)
  const chatWrap = document.getElementById("modal-chat");
  chatWrap.style.display = "none";
  document.getElementById("chat-berichten").innerHTML = "";
  document.getElementById("chat-input").value = "";
  if (isOntvanger || isAanbieder) {
    window._chatAanbiedingId = item.aanbieding_id;
    chatWrap.style.display = "block";
    laadBerichten(item.aanbieding_id).then(() => {
      if (scrollToChat) setTimeout(() => chatWrap.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    });
    _startChatPoll(item.aanbieding_id);
  }

  // Laad aanbiedingen voor dit item
  const aSection = document.getElementById("modal-aanbiedingen");
  const aList    = document.getElementById("modal-aanbiedingen-list");
  aSection.style.display = "none";
  aList.innerHTML = "";
  const res = await apiFetch(`/api/items/${id}/aanbiedingen`);
  if (res && res.ok) {
    const aanbiedingen = await res.json();
    if (aanbiedingen.length) {
      const slabel = { open: "In afwachting", ophalen: "Wordt opgehaald", niet_nodig: "Niet nodig" };
      const scls   = { open: "color:#e67e00", ophalen: "color:#2e7d32", niet_nodig: "color:#c0392b" };
      aList.innerHTML = aanbiedingen.map(a => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:0.86rem;">${_esc(a.bedrijf_naam || "—")}</div>
            <div style="font-size:0.75rem;${scls[a.status]||''};margin-top:2px;">${slabel[a.status]||a.status}</div>
          </div>
          <button onclick="openChatVoorAanbieding(${a.id})"
            title="Chat openen"
            style="padding:7px 10px;border-radius:100px;border:1.5px solid var(--border);background:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;gap:5px;font-size:0.75rem;">
            ${SVG.chat} Chat
          </button>
        </div>`).join("");
      aSection.style.display = "block";
    }
  }
}

async function reagerenOpAanbieding(aanbiedingId, status, itemId) {
  // Optimistic: sluit modal en update UI direct
  const item = allItems.find(i => i.id === itemId);
  const prevStatus = item?.aanbieding_status;
  if (item) item.aanbieding_status = status;
  document.getElementById("modal").classList.add("hidden");
  renderItems();

  const fd = new FormData();
  fd.append("status", status);
  const res = await apiFetch(`/api/mijn-aanbiedingen/${aanbiedingId}`, { method: "PATCH", body: fd });
  if (!res || !res.ok) {
    // Terugdraaien bij fout
    if (item) item.aanbieding_status = prevStatus;
    renderItems();
    alert("Fout bij opslaan");
  }
}

function openChatVoorAanbieding(aanbiedingId) {
  window._chatAanbiedingId = aanbiedingId;
  const chatWrap = document.getElementById("modal-chat");
  chatWrap.style.display = "block";
  document.getElementById("chat-berichten").innerHTML = "";
  document.getElementById("chat-input").value = "";
  laadBerichten(aanbiedingId);
  _startChatPoll(aanbiedingId);
  chatWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

let _chatPollInterval = null;
let _chatRenderedCount = 0;

function _startChatPoll(aanbiedingId) {
  _stopChatPoll();
  _chatPollInterval = setInterval(() => {
    if (window._chatAanbiedingId === aanbiedingId) laadBerichten(aanbiedingId, true);
  }, 3000);
}

function _stopChatPoll() {
  if (_chatPollInterval) { clearInterval(_chatPollInterval); _chatPollInterval = null; }
  _chatRenderedCount = 0;
}

function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escJs(s){return _esc(String(s==null?"":s).replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/[\r\n]/g," "));}

async function laadBerichten(aanbiedingId, silent = false) {
  const res = await apiFetch(`/api/aanbiedingen/${aanbiedingId}/berichten`);
  if (!res || !res.ok) return;
  const berichten = await res.json();
  const mijnId = JSON.parse(atob(token.split(".")[1])).sub;
  const wrap = document.getElementById("chat-berichten");
  if (!berichten.length) {
    if (!silent) wrap.innerHTML = `<div class="chat-empty">Nog geen berichten — start het gesprek 👋</div>`;
    return;
  }
  // Alleen herschrijven als er nieuwe berichten zijn
  if (berichten.length === _chatRenderedCount && silent) return;
  const nieuweNaLoad = berichten.length > _chatRenderedCount;
  _chatRenderedCount = berichten.length;

  // Markeer als gelezen
  const lastAt = berichten[berichten.length - 1].created_at;
  localStorage.setItem(`chat_read_${aanbiedingId}`, lastAt);
  if (nieuweNaLoad) renderItems();

  const wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60;
  wrap.innerHTML = berichten.map((b, i) => {
    const mine = String(b.user_id) === String(mijnId);
    const prev = berichten[i-1];
    const sameAsPrev = prev && String(prev.user_id) === String(b.user_id);
    const showNaam = !mine && !sameAsPrev;
    const tijd = new Date(b.created_at).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    const spacer = i === 0 ? "" : `<div class="chat-spacer${sameAsPrev ? ' tight' : ''}"></div>`;
    return `${spacer}
      <div class="chat-msg ${mine ? 'mine' : 'theirs'}">
        ${showNaam ? `<div class="chat-msg-naam">${_esc(b.naam)}</div>` : ""}
        ${_esc(b.tekst)}
        <div class="chat-msg-tijd">${tijd}</div>
      </div>`;
  }).join("");
  if (!silent || wasAtBottom || nieuweNaLoad) wrap.scrollTop = wrap.scrollHeight;
}

async function verstuurBericht() {
  const input = document.getElementById("chat-input");
  const tekst = input.value.trim();
  const aanbiedingId = window._chatAanbiedingId;
  if (!tekst || !aanbiedingId) return;

  // Optimistic
  const mijnId = JSON.parse(atob(token.split(".")[1])).sub;
  const wrap = document.getElementById("chat-berichten");
  const nu = new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  if (wrap.querySelector(".chat-empty")) wrap.innerHTML = "";
  wrap.innerHTML += `<div class="chat-spacer"></div>
    <div class="chat-msg mine">${_esc(tekst)}<div class="chat-msg-tijd">${nu}</div></div>`;
  wrap.scrollTop = wrap.scrollHeight;
  input.value = "";

  const fd = new FormData(); fd.append("tekst", tekst);
  const res = await apiFetch(`/api/aanbiedingen/${aanbiedingId}/berichten`, { method: "POST", body: fd });
  if (!res || !res.ok) { alert("Bericht niet verzonden"); laadBerichten(aanbiedingId); return; }
  const data = await res.json();
  if (data?.created_at) localStorage.setItem(`chat_read_${aanbiedingId}`, data.created_at);
}

// Enter-toets in chat-input
document.getElementById("chat-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); verstuurBericht(); }
});

async function updateAanbieding(aanbiedingId, status) {
  const fd = new FormData();
  fd.append("status", status);
  await apiFetch(`/api/aanbiedingen/${aanbiedingId}/status`, { method: "PATCH", body: fd });
  openModal(currentItemId); // herlaad modal
}

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("modal").classList.add("hidden");
  _stopChatPoll();
  window._chatAanbiedingId = null;
});
document.getElementById("modal").addEventListener("click", e => {
  if (e.target === document.getElementById("modal")) {
    document.getElementById("modal").classList.add("hidden");
    _stopChatPoll();
    window._chatAanbiedingId = null;
  }
});

document.getElementById("modal-save").addEventListener("click", async () => {
  if (!currentItemId) return;
  const note = document.getElementById("modal-note").value;
  const cat  = document.getElementById("modal-cat").value;
  const idx = allItems.findIndex(i => i.id === currentItemId);
  if (idx !== -1) { allItems[idx].manual_note = note; allItems[idx].category = cat; }
  document.getElementById("modal").classList.add("hidden");
  renderItems();
  const fd = new FormData();
  fd.append("manual_note", note);
  fd.append("category", cat);
  apiFetch(`/api/items/${currentItemId}`, { method: "PATCH", body: fd });
});

document.getElementById("modal-del").addEventListener("click", async () => {
  if (!currentItemId || !confirm("Verwijderen?")) return;
  const id = currentItemId;
  allItems = allItems.filter(i => i.id !== id);
  if (stats) stats.total = Math.max(0, stats.total - 1);
  document.getElementById("modal").classList.add("hidden");
  renderItems();
  renderStats();
  apiFetch(`/api/items/${id}`, { method: "DELETE" });
});

// ── Swipe-to-delete ───────────────────────────────────────────────────────────
let _swipeReady = false;
async function deleteItemById(id) {
  allItems = allItems.filter(i => i.id !== id);
  if (stats) stats.total = Math.max(0, stats.total - 1);
  renderItems();
  renderStats();
  apiFetch(`/api/items/${id}`, { method: "DELETE" });
}

// Tweetraps verwijderen: eerste tik vraagt bevestiging, tweede tik (binnen 3,5s) verwijdert
function vraagVerwijderen(id, btn) {
  if (btn.dataset.bevestig === "1") { deleteItemById(id); return; }
  btn.dataset.bevestig = "1";
  btn.classList.add("confirm");
  btn.textContent = "Zeker?";
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.bevestig === "1") {
      btn.dataset.bevestig = "";
      btn.classList.remove("confirm");
      btn.innerHTML = SVG.trash;
    }
  }, 3500);
}

function _initSwipe() {
  const list = document.getElementById("items-list");
  let startX = 0, startY = 0, activeWrap = null, dragging = false, didSwipe = false;
  const THRESHOLD = 72; // px om delete-knop te tonen (verwijderen kan nooit direct via swipe)

  list.addEventListener("touchstart", e => {
    const wrap = e.target.closest(".swipe-wrap");
    if (!wrap) return;
    // reset andere open swipes
    list.querySelectorAll(".swipe-wrap").forEach(w => { if (w !== wrap) _resetSwipe(w); });
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    activeWrap = wrap;
    dragging = false; didSwipe = false;
  }, { passive: true });

  list.addEventListener("touchmove", e => {
    if (!activeWrap) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!dragging && Math.abs(dy) > Math.abs(dx)) { activeWrap = null; return; }
    if (dx > 0) { _resetSwipe(activeWrap); return; }
    dragging = true; didSwipe = true;
    const offset = Math.min(Math.abs(dx), THRESHOLD + 28);
    const row = activeWrap.querySelector(".item-row");
    row.style.transform = `translateX(-${offset}px)`;
    row.style.transition = "none";
    const btn = activeWrap.querySelector(".swipe-del-btn");
    btn.style.opacity = Math.min(1, offset / THRESHOLD);
  }, { passive: true });

  list.addEventListener("touchend", e => {
    if (!activeWrap) return;
    const dx = startX - e.changedTouches[0].clientX;
    const row = activeWrap.querySelector(".item-row");
    row.style.transition = "transform 0.25s ease";
    if (dx > THRESHOLD) {
      // genoeg geswiped → toon alleen de verwijderknop (verwijderen gaat via
      // de knop zelf, met bevestigingsstap — nooit direct door de swipe)
      row.style.transform = `translateX(-${THRESHOLD}px)`;
    } else {
      _resetSwipe(activeWrap);
    }
    activeWrap = null;
  });

  // tik buiten swipe-wrap → reset
  list.addEventListener("touchstart", e => {
    if (!e.target.closest(".swipe-wrap")) {
      list.querySelectorAll(".swipe-wrap").forEach(_resetSwipe);
    }
  }, { passive: true });
}

function _resetSwipe(wrap) {
  const row = wrap.querySelector(".item-row");
  if (row) { row.style.transition = "transform 0.25s ease"; row.style.transform = ""; }
  const btn = wrap.querySelector(".swipe-del-btn");
  if (btn) btn.style.opacity = "0";
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const min = Math.floor((new Date() - d) / 60000);
  if (min < 1)    return "Zojuist";
  if (min < 60)   return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} uur`;
  return d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}

// ── Push meldingen ─────────────────────────────────────────────────────────────
let _swReg = null;

async function initPush() {
  const btn    = document.getElementById("push-btn");
  const status = document.getElementById("push-status");
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
  try {
    _swReg = await navigator.serviceWorker.register("/sw.js");
  } catch (e) { return; }

  const Notif = window.Notification;
  if (!Notif) return;
  if (Notif.permission === "granted") {
    try {
      await _abonneerPush();
      status.textContent = "✓ Meldingen staan aan voor dit account";
      status.style.display = "block";
      btn.style.display = "none";
    } catch (e) {
      // Geen/kapotte subscription — laat de gebruiker 'm via een tik (her)activeren.
      status.textContent = "Tik op de knop om meldingen voor dit account te activeren.";
      status.style.display = "block";
      btn.innerHTML = `${SVG.bell} Meldingen activeren`;
      btn.disabled = false;
      btn.style.display = "block";
    }
  } else if (Notif.permission === "denied") {
    status.textContent = "Meldingen staan geblokkeerd in je iPhone-instellingen.";
    status.style.display = "block";
  } else {
    btn.style.display = "block";
  }
}

async function meldingInschakelen() {
  const btn    = document.getElementById("push-btn");
  const status = document.getElementById("push-status");
  btn.disabled = true; btn.textContent = "Bezig…";
  const Notif = window.Notification;
  if (!Notif) {
    btn.innerHTML = `${SVG.bell} Meldingen inschakelen`;
    status.textContent = "Push wordt niet ondersteund in deze browser.";
    status.style.display = "block";
    return;
  }
  try {
    const perm = await Notif.requestPermission();
    if (perm === "granted") {
      await _abonneerPush();
      btn.style.display = "none";
      status.textContent = "✓ Pushmeldingen ingeschakeld!";
      status.style.display = "block";
    } else {
      btn.textContent = "Toestemming geweigerd";
      status.textContent = "Sta meldingen toe via de browserinstellingen.";
      status.style.display = "block";
    }
  } catch (e) {
    btn.innerHTML = `${SVG.bell} Meldingen inschakelen`;
    btn.disabled = false;
    alert("Push fout: " + (e.message || e.name || JSON.stringify(e)));
  }
}

// Bewaar het account-token in IndexedDB zodat de service worker een verlopen
// subscription op de achtergrond kan vernieuwen (pushsubscriptionchange).
function _idbPut(key, val) {
  return new Promise((res, rej) => {
    try {
      const o = indexedDB.open("cirqo-push", 1);
      o.onupgradeneeded = () => o.result.createObjectStore("kv");
      o.onsuccess = () => {
        const tx = o.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      };
      o.onerror = () => rej(o.error);
    } catch (e) { rej(e); }
  });
}

async function _abonneerPush() {
  if (!_swReg) _swReg = await navigator.serviceWorker.ready;
  // Hergebruik een bestaande subscription (NIET afmelden — dat faalt stil op iOS).
  let sub = await _swReg.pushManager.getSubscription();
  if (!sub) {
    const keyRes = await fetch("/api/push/vapid-key");
    const keyData = await keyRes.json();
    const public_key = keyData.public_key;
    if (!public_key) throw new Error("Geen VAPID public key ontvangen");
    const padding = "=".repeat((4 - public_key.length % 4) % 4);
    const raw = atob((public_key + padding).replace(/-/g, "+").replace(/_/g, "/"));
    const appKey = Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    sub = await _swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  }
  // Koppel de subscription aan het NU ingelogde account (server doet upsert op user_id).
  await apiFetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  _idbPut("token", token).catch(() => {});
}

// Bij app-start: als toestemming al is gegeven, koppel de (bestaande) subscription
// aan het ingelogde account. Zo "claimt" het account dat nu op dit apparaat is
// ingelogd altijd zijn eigen pushmeldingen — ook na inloggen of herstart, zonder
// dat je eerst het accountpaneel hoeft te openen. Vraagt zelf geen toestemming.
async function _ensurePushRegistered() {
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
  if (window.Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;  // geen bestaande subscription; op iOS kan dat alleen via een tik (knop)
    // Koppel de bestaande subscription aan het nu ingelogde account.
    await apiFetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    _idbPut("token", token).catch(() => {});
  } catch (e) { /* stil — push is best-effort */ }
}

// ── Gebruikerspaneel ───────────────────────────────────────────────────────────
async function openUserPanel() {
  const gem = localStorage.getItem("gemeente") || "";
  const mil = localStorage.getItem("milieustraat") || "";
  const upGem = document.getElementById("up-gemeente");
  if (upGem) upGem.value = gem;
  // Herstel milieustraat cascade
  const upMil = document.getElementById("up-milieustraat");
  if (upMil && gem) _vulMilieustraatSelect(upMil, gem, mil);
  document.getElementById("up-organisatie").value = localStorage.getItem("organisatie") || "";
  document.getElementById("up-status").textContent = "";
  document.getElementById("up-pwd").value = "";
  // Rol label
  const rolLabels = { superadmin: "Platform", admin: "Beheerder", user: "Scanner", bedrijf: "Afnemer" };
  const rolEl = document.getElementById("up-rol-label");
  if (rolEl) rolEl.textContent = "Rol: " + (rolLabels[_role] || _role);
  // Volgorde + toggle voor scanners en bedrijven (die ook aanbieden)
  const kanAanbieden = (_role === "user" || _role === "bedrijf");
  document.getElementById("auto-doorsturen-wrap").style.display = kanAanbieden ? "block" : "none";
  document.getElementById("volgorde-wrap").style.display = kanAanbieden ? "block" : "none";
  document.getElementById("user-panel").classList.remove("hidden");
  initPush();
  const res = await apiFetch("/api/auth/me");
  if (res && res.ok) {
    const me = await res.json();
    const org = me.organisatie || me.username || _username || "";
    document.getElementById("up-organisatie").value = org;
    localStorage.setItem("organisatie", org);
    if (kanAanbieden) {
      document.getElementById("up-auto-doorsturen").checked = !!me.auto_doorsturen;
      const gem = me.gemeente || localStorage.getItem("gemeente") || "";
      if (gem) laadVolgorde(gem);
    }
  }
}

// ── Volgorde bedrijven ─────────────────────────────────────────────────────────
let _volgordeData = []; // [{id, naam, gemeente}]

async function laadVolgorde(gemeente) {
  const [volgordeRes, bedrijvenRes] = await Promise.all([
    apiFetch("/api/mijn-volgorde"),
    apiFetch(`/api/bedrijven-voor-scan?gemeente=${encodeURIComponent(gemeente || "")}&category=`),
  ]);
  const volgorde  = (volgordeRes && volgordeRes.ok)  ? await volgordeRes.json()  : [];
  const bedrijven = (bedrijvenRes && bedrijvenRes.ok) ? await bedrijvenRes.json() : [];

  // Merge: eerst de ingestelde volgorde, dan resterende bedrijven
  const inVolgorde  = volgorde.map(v => bedrijven.find(b => b.id === v.id) || v);
  const resterende  = bedrijven.filter(b => !volgorde.find(v => v.id === b.id));
  _volgordeData = [...inVolgorde, ...resterende].filter(b => b.id);
  _renderVolgorde();
}

function _renderVolgorde() {
  const lijst = document.getElementById("volgorde-lijst");
  lijst.innerHTML = _volgordeData.map((b, i) => `
    <div data-id="${b.id}" style="display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
      <span style="font-size:0.7rem;font-weight:700;color:var(--orange);min-width:18px;">${i + 1}</span>
      <span style="flex:1;font-size:0.88rem;font-weight:600;">${_esc(b.naam)}</span>
      <button onclick="_volgordeOmhoog(${i})" ${i === 0 ? "disabled" : ""} style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:0.9rem;${i === 0 ? "opacity:.3;" : ""}">↑</button>
      <button onclick="_volgordeOmlaag(${i})" ${i === _volgordeData.length - 1 ? "disabled" : ""} style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:0.9rem;${i === _volgordeData.length - 1 ? "opacity:.3;" : ""}">↓</button>
    </div>`).join("");
}

function _volgordeOmhoog(i) {
  if (i === 0) return;
  [_volgordeData[i - 1], _volgordeData[i]] = [_volgordeData[i], _volgordeData[i - 1]];
  _renderVolgorde();
}

function _volgordeOmlaag(i) {
  if (i === _volgordeData.length - 1) return;
  [_volgordeData[i], _volgordeData[i + 1]] = [_volgordeData[i + 1], _volgordeData[i]];
  _renderVolgorde();
}

async function slaVolgorde() {
  const ids = _volgordeData.map(b => b.id);
  const res = await apiFetch("/api/mijn-volgorde", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids),
  });
  const status = document.getElementById("volgorde-status");
  status.textContent = (res && res.ok) ? "✓ Opgeslagen" : "Fout bij opslaan";
  status.style.color = (res && res.ok) ? "#2e7d32" : "var(--danger)";
  setTimeout(() => { status.textContent = ""; }, 2000);
}

async function saveAutoDoorsturen(enabled) {
  const userId = JSON.parse(atob(token.split(".")[1])).sub;
  const fd = new FormData(); fd.append("enabled", enabled);
  await apiFetch(`/api/users/${userId}/auto-doorsturen`, { method: "PATCH", body: fd });
}

function closeUserPanel() {
  document.getElementById("user-panel").classList.add("hidden");
}

async function saveUserPanel() {
  const gemeente    = (document.getElementById("up-gemeente")?.value || "").trim();
  const milieustraat = (document.getElementById("up-milieustraat")?.value || "").trim();
  const organisatie = document.getElementById("up-organisatie").value.trim();
  const pwd         = document.getElementById("up-pwd").value;
  const statusEl    = document.getElementById("up-status");
  const userId      = JSON.parse(atob(token.split(".")[1])).sub;

  statusEl.textContent = "Opslaan…"; statusEl.style.color = "var(--muted)";

  try {
    if (gemeente !== (localStorage.getItem("gemeente") || "")) {
      const fd = new FormData(); fd.append("gemeente", gemeente);
      const res = await apiFetch(`/api/users/${userId}/gemeente`, { method: "PATCH", body: fd });
      if (res && res.ok) {
        const data = await res.json();
        localStorage.setItem("token", data.token);
        localStorage.setItem("gemeente", data.gemeente);
        window.token !== undefined && (window.token = data.token);
      }
    }
    if (milieustraat) localStorage.setItem("milieustraat", milieustraat);
    if (organisatie !== (localStorage.getItem("organisatie") || "")) {
      const fd = new FormData(); fd.append("organisatie", organisatie);
      const res = await apiFetch(`/api/users/${userId}/organisatie`, { method: "PATCH", body: fd });
      if (res && res.ok) {
        localStorage.setItem("organisatie", organisatie);
      }
    }
    if (pwd) {
      const fd = new FormData(); fd.append("password", pwd);
      await apiFetch(`/api/users/${userId}/password`, { method: "PATCH", body: fd });
    }
    statusEl.textContent = "✓ Opgeslagen"; statusEl.style.color = "#2e7d32";
    if (_username) document.getElementById("hdr-username").textContent = _username + (gemeente ? ` · ${gemeente}` : "");
  } catch (e) {
    statusEl.textContent = "Fout bij opslaan"; statusEl.style.color = "var(--danger)";
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────

// Bedrijf-rol: standaard op "Ontvangen" starten
if (_role === "bedrijf") {
  const ontvangenTab = document.querySelector('.list-maintab[data-main="ontvangen"]');
  if (ontvangenTab) {
    document.querySelectorAll(".list-maintab").forEach(b => b.classList.remove("active"));
    ontvangenTab.classList.add("active");
  }
  document.getElementById("subtabs-aanbieden").style.display = "none";
  document.getElementById("subtabs-ontvangen").style.display = "";
  document.querySelector('.list-maintab[data-main="aanbieden"]')?.classList.remove("active");
  document.querySelector('[data-subtab="ontvangen-alles"]')?.classList.add("active");
  activeMain = "ontvangen";
  activeSubtab = "ontvangen-alles";
  document.getElementById("tab-list").dataset.main = "ontvangen";
}

// ── PWA-installatie (instructie per browser) ───────────────────────────────────
let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); _deferredInstallPrompt = e; });

function _installPlatform() {
  const ua = navigator.userAgent || "";
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  if (standalone) return "installed";
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) {
    if (/CriOS/i.test(ua)) return "ios-chrome";
    if (/FxiOS/i.test(ua)) return "ios-firefox";
    return "ios-safari";
  }
  if (/android/i.test(ua)) return "android";
  if (/Edg/i.test(ua)) return "desktop-edge";
  if (/Firefox/i.test(ua)) return "desktop-firefox";
  if (/Chrome/i.test(ua)) return "desktop-chrome";
  return "desktop-other";
}

const _OL = "style='margin:8px 0 0 18px;padding:0;display:flex;flex-direction:column;gap:6px;'";
const _SHARE_ICON = "<svg width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' style='vertical-align:middle'><path d='M12 3v12'/><path d='M8 7l4-4 4 4'/><path d='M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1'/></svg>";
const _SHARE_CUE = "<div style='display:flex;align-items:center;gap:10px;margin:10px 0;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;'><span style='display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;background:#fff;border:1px solid var(--border);color:var(--orange);flex-shrink:0;'>" + _SHARE_ICON + "</span><span style='font-size:.8rem;color:var(--muted);'>Zoek dit <b>deel-icoon</b> — onderin (iPhone) of rechtsboven (iPad) in Safari.</span></div>";
const _ADD_ICON = "<span style='display:inline-flex;vertical-align:middle;color:var(--orange);margin-left:3px;'><svg width='17' height='17' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='4'/><line x1='12' y1='8' x2='12' y2='16'/><line x1='8' y1='12' x2='16' y2='12'/></svg></span>";
const _INSTALL_STAPPEN = {
  "installed": "✓ De app is al op dit apparaat geïnstalleerd.",
  "ios-safari": "<b>iPhone / iPad — Safari</b>" + _SHARE_CUE + "<ol " + _OL + "><li>Tik op het <b>deel-icoon</b> hierboven.</li><li>Scroll en kies <b>‘Zet op beginscherm’</b>" + _ADD_ICON + ".</li><li>Tik rechtsboven op <b>‘Voeg toe’</b>.</li></ol>",
  "ios-chrome": "<b>iPhone / iPad — Chrome</b>" + _SHARE_CUE + "<ol " + _OL + "><li>Tik op het <b>deel-icoon</b> (of het <b>⋯</b>-menu).</li><li>Kies <b>‘Zet op beginscherm’</b>" + _ADD_ICON + ".</li></ol><p style='margin-top:8px;color:var(--muted);font-size:.8rem;'>Werkt het niet? Open deze pagina in <b>Safari</b>.</p>",
  "ios-firefox": "<b>iPhone / iPad — Firefox</b><p style='margin-top:6px;'>Op iOS gaat installeren het makkelijkst via <b>Safari</b>:</p>" + _SHARE_CUE + "<ol " + _OL + "><li>Open deze pagina in <b>Safari</b>.</li><li>Tik op het <b>deel-icoon</b> → <b>‘Zet op beginscherm’</b>" + _ADD_ICON + ".</li></ol>",
  "android": "<b>Android — Chrome</b><ol " + _OL + "><li>Tik rechtsboven op <b>⋮</b> (menu).</li><li>Kies <b>‘App installeren’</b> of <b>‘Toevoegen aan startscherm’</b>.</li></ol><p style='margin-top:8px;color:var(--muted);font-size:.8rem;'>Of gebruik de knop hieronder als die verschijnt.</p>",
  "desktop-chrome": "<b>Computer — Chrome</b><ol " + _OL + "><li>Klik rechts in de <b>adresbalk</b> op het <b>installatie-icoon</b>.</li><li>Of: menu <b>⋮ → ‘App installeren’</b> → <b>Installeren</b>.</li></ol>",
  "desktop-edge": "<b>Computer — Edge</b><ol " + _OL + "><li>Klik rechtsboven op <b>⋯</b> → <b>Apps</b> → <b>‘Deze site als app installeren’</b>.</li></ol>",
  "desktop-firefox": "<b>Computer — Firefox</b><p style='margin-top:6px;'>Firefox kan web-apps niet standaard installeren. Gebruik <b>Chrome</b> of <b>Edge</b>.</p>",
  "desktop-other": "<b>App installeren</b><p style='margin-top:6px;'>Open deze site in <b>Chrome</b>/<b>Edge</b> (computer/Android) of <b>Safari</b> (iPhone/iPad) en kies <b>‘App installeren’</b> of <b>‘Zet op beginscherm’</b>.</p>",
};

window.toonInstallInstructie = function () {
  const p = _installPlatform();
  const steps = document.getElementById("app-install-steps");
  const nowBtn = document.getElementById("app-install-now");
  steps.innerHTML = _INSTALL_STAPPEN[p] || _INSTALL_STAPPEN["desktop-other"];
  steps.style.display = "block";
  nowBtn.style.display = (_deferredInstallPrompt && (p === "android" || p.indexOf("desktop") === 0)) ? "block" : "none";
};

window.installNu = function () {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  _deferredInstallPrompt.userChoice.then(() => {
    _deferredInstallPrompt = null;
    ["app-install-now", "install-pop-now"].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = "none"; });
    const s = document.getElementById("install-pop-steps"); if (s) s.innerHTML = "✓ Installatie gestart — volg de melding van je browser.";
  });
};

// Zwevende install-knop (popup)
window.openInstallPopup = function () {
  const p = _installPlatform();
  document.getElementById("install-pop-steps").innerHTML = _INSTALL_STAPPEN[p] || _INSTALL_STAPPEN["desktop-other"];
  const nowBtn = document.getElementById("install-pop-now");
  nowBtn.style.display = (_deferredInstallPrompt && (p === "android" || p.indexOf("desktop") === 0)) ? "block" : "none";
  document.getElementById("install-pop").style.display = "flex";
};
window.closeInstallPopup = function () { document.getElementById("install-pop").style.display = "none"; };

// Verberg alle install-suggesties als de app al geïnstalleerd is
function _verbergInstallUI() {
  ["install-fab", "app-install-field", "install-pop"].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = "none";
  });
}
// Detecteer installatie — ook wanneer de site in de browser wordt bekeken (niet standalone)
async function _appReedsGeinstalleerd() {
  if (_installPlatform() === "installed") return true;
  if (navigator.getInstalledRelatedApps) {
    try {
      const apps = await navigator.getInstalledRelatedApps();
      if (apps && apps.some(a => a.platform === "webapp")) return true;
    } catch (e) {}
  }
  return false;
}
window.addEventListener("appinstalled", _verbergInstallUI);
_appReedsGeinstalleerd().then(installed => {
  if (installed) { _verbergInstallUI(); return; }
  const _fab = document.getElementById("install-fab");
  if (_fab) _fab.style.display = "flex";
});

laadGemeenten().then(() => syncAll());
_ensurePushRegistered();
setInterval(syncItems, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncItems(); });

// ── Auto-update: herlaad zodra er een nieuwe versie live staat ──────────────────
let _pendingUpdate = false;
async function _checkAppVersie() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.version && window._APP_VERSION && d.version !== window._APP_VERSION) {
      _pendingUpdate = true;
      _pasUpdateToe();
    }
  } catch (e) { /* offline o.i.d. — later opnieuw */ }
}
function _pasUpdateToe() {
  if (!_pendingUpdate) return;
  const ae = document.activeElement;
  const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
  const modalOpen = !document.getElementById("modal").classList.contains("hidden");
  if (typing || modalOpen) return;  // niet storen; opnieuw bij volgende check/focus
  const t = document.createElement("div");
  t.textContent = "App wordt bijgewerkt…";
  t.style.cssText = "position:fixed;left:50%;bottom:calc(90px + var(--sab));transform:translateX(-50%);z-index:900;background:var(--ink);color:#fff;padding:10px 16px;border-radius:100px;font-size:0.85rem;box-shadow:0 4px 16px rgba(0,0,0,.3);";
  document.body.appendChild(t);
  setTimeout(() => location.reload(), 1200);
}
setInterval(_checkAppVersie, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { _checkAppVersie(); _pasUpdateToe(); } });
