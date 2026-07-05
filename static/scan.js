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

// apiFetch, logout, _esc en escJs komen uit cirqo-core.js (gedeelde kern).

// Toon ingelogde gebruiker en beheer-link
const _role     = localStorage.getItem("role") || "user";
const _username = localStorage.getItem("username") || "";
const _gemeente = localStorage.getItem("gemeente") || "";
// Gemeenten die onder Waardlanden vallen → dan het Waardlanden-logo in de avatar
const _WAARDLANDEN_GEMEENTEN = new Set([
  "waardlanden", "Gorinchem", "Hardinxveld-Giessendam", "Vijfheerenlanden", "Molenlanden",
]);
function _isWaardlanden() {
  const g = (localStorage.getItem("gemeente") || "").trim();
  // Alleen de milieustraat-kant (scanner/beheerder), niet externe afnemers
  return _WAARDLANDEN_GEMEENTEN.has(g) && (_role === "user" || _role === "admin");
}
function _zetHeaderAccount() {
  const org = localStorage.getItem("organisatie") || _username || "";
  const naamEl = document.getElementById("hdr-orgnaam");
  const avEl = document.getElementById("hdr-avatar");
  if (naamEl) naamEl.textContent = org;
  if (!avEl) return;
  if (_isWaardlanden()) {
    avEl.classList.add("hdr-avatar-logo");
    avEl.innerHTML = '<img src="/static/waardlanden-globe.png" alt="Waardlanden">';
  } else {
    avEl.classList.remove("hdr-avatar-logo");
    avEl.textContent = (org || "?").charAt(0).toUpperCase();
  }
}
_zetHeaderAccount();
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
const _ITEMS_CACHE_KEY = `cirqo_items_v1_${_userId}`;

function _listTabActive() {
  return document.getElementById("tab-list")?.classList.contains("active");
}

let _itemsGeladen = false;   // pas na de eerste succesvolle fetch "Geen items" tonen

// Vingerafdruk die álle zichtbare wijzigingen dekt: nieuwe items, statuswissels,
// nieuwe reacties én nieuwe chatberichten. (Voorheen alleen aantal+eerste+laatste
// id — dan miste een aanbieding/status op een bestaand item de update volledig.)
function _itemsFingerprint(arr) {
  return arr.map(i =>
    `${i.id}:${i.aanbieding_id || 0}:${i.aanbieding_status || ""}:${i.bericht_count || 0}:${i.last_bericht_at || ""}`
  ).join("|");
}

// Stale-while-revalidate: toon direct de laatst bekende lijst uit localStorage,
// zodat het openen van de app/aanbodtab een splitsecond voelt. Daarna revalideert
// syncItems op de achtergrond en werkt bij zodra er iets écht wijzigt.
function _laadItemsUitCache() {
  try {
    const raw = localStorage.getItem(_ITEMS_CACHE_KEY);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return false;
    allItems = arr;
    _itemsGeladen = true;
    _lastItemsJson = _itemsFingerprint(arr);
    _updateAanbodTeller();
    if (_isAdmin) _vulGemeenteDropdown();
    if (_listTabActive()) renderItems();
    return true;
  } catch { return false; }
}

// Houd de lokale cache in sync na optimistische wijzigingen (verwijderen/aanbieden),
// zodat een net-gewijzigd item niet terugknippert bij snel heropenen.
function _bewaarItemsCache() {
  try {
    localStorage.setItem(_ITEMS_CACHE_KEY, JSON.stringify(allItems));
    _lastItemsJson = _itemsFingerprint(allItems);
  } catch {}
}

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
    const hash = _itemsFingerprint(nieuw);
    try { localStorage.setItem(_ITEMS_CACHE_KEY, JSON.stringify(nieuw)); } catch {}
    if (hash === _lastItemsJson && !eersteKeer) return;
    _lastItemsJson = hash;
    allItems = nieuw;
    _updateAanbodTeller();
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

// Gemeenten/milieustraten zijn alléén nodig voor het accountpaneel — lazy laden,
// zodat de items-sync bij het opstarten nergens op hoeft te wachten.
let _gemeentenPromise = null;
function _zorgGemeentenGeladen() {
  if (!_gemeentenPromise) _gemeentenPromise = laadGemeenten();
  return _gemeentenPromise;
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

  // ── Gebruikerspaneel: gemeente-keuze alleen binnen de eigen scope.
  //    Organisatie-accounts (meerdere gemeenten/milieustraten) kunnen hun scope
  //    niet zelf wijzigen — die wordt centraal beheerd (vast label i.p.v. keuze).
  const upGem = document.getElementById("up-gemeente");
  if (upGem) {
    let scopeGem = _allGemeenten, orgScope = false, orgLabel = "";
    try {
      const mg = await apiFetch("/api/mijn-gemeenten");
      if (mg && mg.ok) {
        const d = await mg.json();
        if (Array.isArray(d.gemeenten) && d.gemeenten.length) scopeGem = d.gemeenten;
        if (d.milieustraten || (d.gemeenten || []).length > 1) {
          orgScope = _role !== "superadmin";
          orgLabel = (localStorage.getItem("organisatie") || "Organisatie") +
            (d.milieustraten ? ` — alle ${d.milieustraten.length} milieustraten` : " — alle gemeenten");
        }
      }
    } catch (e) {}
    if (orgScope) {
      const vast = document.createElement("div");
      vast.style.cssText = "padding:11px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:0.88rem;color:var(--muted);";
      vast.textContent = orgLabel;
      upGem.replaceWith(vast);
      const upMil = document.getElementById("up-milieustraat");
      if (upMil) upMil.style.display = "none";
    } else {
      upGem.innerHTML = '<option value="">— Selecteer gemeente —</option>' +
        scopeGem.map(g => `<option value="${_esc(g)}">${_esc(g)}</option>`).join("");
      upGem.addEventListener("change", function () {
        const upMil = document.getElementById("up-milieustraat");
        if (upMil) _vulMilieustraatSelect(upMil, this.value, "");
      });
    }
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
  if (!ids.length) { (window.uxToast || alert)("Selecteer minstens één bedrijf", "info"); return; }
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
    // Snelmodus: onthoud deze keuze per categorie voor de volgende scan
    try { localStorage.setItem("snel_selectie_" + (_huidigCategory || "alle"), JSON.stringify(ids)); } catch (e) {}
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

// Ecopark Groot-Ammers (gemeente Molenlanden): aanbod standaard aan álle partners
// aangevinkt — wens Waardlanden ("automatisch aan div. partijen aanbieden").
// Eén tik op 'Aanbieden' is dan genoeg; uitvinken blijft mogelijk.
const _ALLES_VOORAF_AAN = (_gemeente === "Molenlanden");

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

  // Snelmodus: is er een onthouden keuze voor deze categorie die nog geldig is?
  let onthouden = [];
  try { onthouden = JSON.parse(localStorage.getItem("snel_selectie_" + (_huidigCategory || "alle")) || "[]"); } catch (e) {}
  const geldigeIds = new Set(_scanBedrijven.map(b => b.id));
  onthouden = onthouden.filter(id => geldigeIds.has(id));
  const snelmodus = onthouden.length > 0;
  const onthoudenNamen = _scanBedrijven.filter(b => onthouden.includes(b.id)).map(b => b.naam);
  const snelLabel = onthoudenNamen.length <= 2
    ? onthoudenNamen.join(" en ")
    : `${onthoudenNamen.slice(0, 2).join(", ")} +${onthoudenNamen.length - 2}`;

  // Voorvinken: in snelmodus exact de onthouden keuze, anders de bestaande logica
  const isVoorgevinkt = (b) => snelmodus
    ? onthouden.includes(b.id)
    : (_ALLES_VOORAF_AAN || b.historie_count > 0 || b.categorie_match);

  bedrijvenLijst.innerHTML = `
    ${snelmodus ? `
    <button id="btn-aanbied-selectie" class="btn btn-primary" style="width:100%;display:flex;flex-direction:column;gap:2px;padding:14px;"
      onclick="aanbiedenAanSelectie(${itemId})">
      <span>Direct aanbieden</span>
      <span style="font-size:0.8rem;font-weight:600;opacity:.85;text-transform:none;letter-spacing:0;">aan ${_esc(snelLabel)} — zoals vorige keer</span>
    </button>
    <button type="button" onclick="_scanToonKeuze()" id="scan-keuze-toggle"
      style="width:100%;margin-top:8px;background:none;border:none;cursor:pointer;font-family:inherit;font-size:0.82rem;font-weight:600;color:var(--muted);padding:8px;">
      Andere bedrijven kiezen ▾
    </button>` : ""}
    <div id="scan-keuze-lijst" style="${snelmodus ? "display:none;" : ""}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-size:0.8rem;color:var(--muted);">Kies één of meer bedrijven</span>
      <span style="font-size:0.8rem;">
        <button type="button" onclick="_scanToggleAlle(true)" style="background:none;border:none;cursor:pointer;font-family:inherit;color:var(--orange);font-weight:600;font-size:0.8rem;padding:4px;">Alles</button>
        ·
        <button type="button" onclick="_scanToggleAlle(false)" style="background:none;border:none;cursor:pointer;font-family:inherit;color:var(--muted);font-size:0.8rem;padding:4px;">Geen</button>
      </span>
    </div>
    ${_scanBedrijven.map((b) => `
    <label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer;">
      <input type="checkbox" class="scan-bedrijf-check" value="${b.id}" ${isVoorgevinkt(b) ? "checked" : ""} style="width:20px;height:20px;flex-shrink:0;accent-color:var(--orange);">
      <span style="flex:1;">
        <span style="font-weight:600;font-size:0.88rem;">${_esc(b.naam)}</span>
        ${b.historie_count > 0 ? `<span style="font-size:0.7rem;font-weight:700;background:#fff3e0;color:#b4531a;padding:2px 7px;border-radius:100px;margin-left:6px;">★ haalde dit ${b.historie_count}× eerder op</span>`
          : (b.categorie_match ? `<span style="font-size:0.7rem;font-weight:700;background:#e8f5e9;color:#2e7d32;padding:2px 7px;border-radius:100px;margin-left:6px;">Match</span>` : "")}
        ${(b.contactpersoon || b.telefoon) ? `<span style="display:block;font-size:0.8rem;color:var(--muted);margin-top:2px;">${b.contactpersoon ? _esc(b.contactpersoon) : ""}${b.telefoon ? ` · ${_esc(b.telefoon)}` : ""}</span>` : ""}
      </span>
    </label>`).join("")}
    ${snelmodus ? `
    <button class="btn btn-primary" style="width:100%;margin-top:14px;" onclick="aanbiedenAanSelectie(${itemId})">
      Aanbieden aan geselecteerde bedrijven
    </button>` : `
    <button id="btn-aanbied-selectie" class="btn btn-primary" style="width:100%;margin-top:14px;" onclick="aanbiedenAanSelectie(${itemId})">
      Aanbieden aan geselecteerde bedrijven
    </button>`}
    </div>`;
  bedrijvenCard.classList.remove("hidden");
}

// Snelmodus: keuzelijst tonen (en de snelknop laten staan voor wie zich bedenkt)
function _scanToonKeuze() {
  const lijst = document.getElementById("scan-keuze-lijst");
  const toggle = document.getElementById("scan-keuze-toggle");
  if (lijst) lijst.style.display = "";
  if (toggle) toggle.style.display = "none";
}
window._scanToonKeuze = _scanToonKeuze;


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
    const res = await apiFetch("/api/upload", { method: "POST", body: fd, _stil: true });
    if (!res) {
      // Geen verbinding: scan lokaal bewaren — wordt automatisch verstuurd
      // zodra de verbinding terug is (zie offline-scanwachtrij onderaan)
      await _wachtrijTx(true, s => s.add({ fotos: gecomprimeerd, gemeente: detectedGemeente || null, tijd: Date.now() }));
      _wachtrijToon();
      pendingFiles = [];
      cameraInput.value = "";
      if (addPhotoInput) addPhotoInput.value = "";
      previewThumbs.innerHTML = "";
      previewWrap.classList.add("hidden");
      analyseBtn.classList.add("hidden");
      scanHero.classList.remove("hidden");
      (window.uxToast || alert)("Geen verbinding — scan bewaard, wordt automatisch verstuurd", "info");
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
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
    (window.uxHaptic || (() => {}))("licht");

    // Toon gekoppelde bedrijven met aanbieden-knop (scope = account/organisatie)
    _huidigItemId   = item.id;
    _huidigCategory = item.category || "";
    if (item.bedrijven && item.bedrijven.length) {
      _renderBedrijvenLijst(item.id, item.bedrijven);
    } else {
      document.getElementById("bedrijven-card").classList.add("hidden");
    }

    allItems.unshift(item);
    _bewaarItemsCache();   // verse scan direct in de lokale kopie — nooit "zoek"
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
  _bewaarItemsCache();
  renderItems();
}

// Klein feestje (confetti + trilling) bij succesmomenten — puur decoratief,
// pointer-events:none en met reduced-motion-respect
function _confettiBurst(anker) {
  try {
    if (!anker || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = anker.getBoundingClientRect();
    const kleuren = ["#86bc97", "#6aaa82", "#f5c26b", "#3a9ab5", "#e8865a"];
    for (let i = 0; i < 22; i++) {
      const s = document.createElement("div");
      const maat = 5 + Math.random() * 5;
      s.style.cssText = `position:fixed;left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;` +
        `width:${maat}px;height:${maat}px;background:${kleuren[i % kleuren.length]};` +
        `border-radius:${Math.random() < 0.4 ? "50%" : "2px"};pointer-events:none;z-index:9999;`;
      document.body.appendChild(s);
      const hoek = Math.random() * Math.PI * 2;
      const afstand = 60 + Math.random() * 110;
      s.animate([
        { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
        { transform: `translate(${Math.cos(hoek) * afstand}px, ${Math.sin(hoek) * afstand + 70}px) rotate(${Math.round(Math.random() * 540 - 270)}deg)`, opacity: 0 },
      ], { duration: 650 + Math.random() * 250, easing: "cubic-bezier(.16,.8,.32,1)" }).onfinish = () => s.remove();
    }
    if (navigator.vibrate) navigator.vibrate([12, 40, 18]);
  } catch (e) { /* decoratie mag nooit de flow breken */ }
}

function _toonSucces(titel, tekst) {
  document.getElementById("succes-titel").textContent = titel;
  document.getElementById("succes-tekst").textContent = tekst;
  const el = document.getElementById("succes-overlay");
  el.style.display = "flex";
  (window.uxHaptic || (() => {}))("succes");
  setTimeout(() => _confettiBurst(el.querySelector(".succes-cirkel")), 220);
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

// Status van de eigen aanbieding (aanbieder-weergave) als badge.
// Beheerders zien de badge ook op ontvangen-items (overzicht per stroom).
function _statusBadge(item) {
  if (item.aangeboden_door_naam && !_isAdmin) return "";
  if (!item.aanbieding_id) {
    // Gescand maar nog niet aangeboden: benoem dat — anders lijkt het item zoek
    return _isAdmin ? "" : `<span class="st-badge st-wacht">Nog niet aangeboden</span>`;
  }
  if (item.aanbieding_status === "ophalen")    return `<span class="st-badge st-match">Match</span>`;
  if (item.aanbieding_status === "niet_nodig") return `<span class="st-badge st-nee" title="${_esc(item.niet_nodig_reden || "")}">Niet nodig${item.niet_nodig_reden ? " · " + _esc(item.niet_nodig_reden) : ""}</span>`;
  const d = item.aanbieding_created_at ? Math.floor((Date.now() - new Date(item.aanbieding_created_at)) / 864e5) : null;
  return `<span class="st-badge st-wacht">Wacht${d > 0 ? ` · ${d}d` : ""}</span>`;
}
// Nog te beoordelen aanbod (ontvanger-weergave)
function _nieuwBadge(item) {
  if (_role !== "bedrijf" || !item.aangeboden_door_naam) return "";
  return (item.aanbieding_status === "open" || item.aanbieding_status === "beschikbaar")
    ? `<span class="st-badge st-nieuw">Nieuw</span>` : "";
}
// Tweede regel: status + (waar relevant) afzender — op één rustige lijn.
// "Aan wie aangeboden" staat bewust NIET in de lijst: dat detail (incl. status
// per bedrijf) staat op de detailpagina; alleen beheer ziet het hier wel.
function _itemSubRegel(item) {
  const delen = [];
  const badge = _statusBadge(item) + _nieuwBadge(item);
  if (badge) delen.push(badge);
  if (item.aangeboden_door_naam) delen.push(`<span class="item-partij">van <b>${_esc(item.aangeboden_door_naam)}</b></span>`);
  if (_isAdmin && item.bedrijf_naam) delen.push(`<span class="item-partij">aan <b>${_esc(item.bedrijf_naam)}</b></span>`);
  if (_isAdmin && item.gemeente) delen.push(`<span class="item-cat" style="background:#e8f0fe;border-color:#c5d2f6;">${_esc(item.gemeente)}</span>`);
  return delen.length ? `<div class="item-sub">${delen.join("")}</div>` : "";
}
// Nog niet bekeken reactie op eigen aanbod (aanbieder-kant): een bedrijf heeft
// gereageerd (match/niet nodig) en de aanbieder heeft het item sindsdien niet geopend
function _reactieOngezien(item) {
  if (item.aangeboden_door_naam || !item.aanbieding_id) return false;
  if (item.aanbieding_status !== "ophalen" && item.aanbieding_status !== "niet_nodig") return false;
  return localStorage.getItem(`reactie_gezien_${item.aanbieding_id}`) !== item.aanbieding_status;
}

// Rood bolletje op de Aanbod-tab: alles wat aandacht vraagt, voor elke rol —
// nieuw aanbod (bedrijf), ongelezen chatberichten en ongeziene reacties (aanbieder)
function _updateAanbodTeller() {
  const btn = document.querySelector('.tabbar-btn[data-tab="list"]');
  if (!btn) return;
  const n = allItems.filter(i =>
    (_role === "bedrijf" && i.aangeboden_door_naam &&
      (i.aanbieding_status === "open" || i.aanbieding_status === "beschikbaar")) ||
    _hasUnread(i) ||
    (!_isAdmin && _reactieOngezien(i))
  ).length;
  let b = btn.querySelector(".tab-teller");
  _zetAppBadge(n);
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement("span"); b.className = "tab-teller"; btn.appendChild(b); }
  b.textContent = n > 9 ? "9+" : String(n);
}

// Badge op het app-icoon (beginscherm) — zelfde teller als het bolletje in de
// onderbalk. De service worker verhoogt hem bij pushmeldingen als de app dicht
// is; zodra de app opent zet deze functie hem op het werkelijke aantal.
function _zetAppBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
    _idbPut("badge", n).catch(() => {});
  } catch (e) { /* niet ondersteund — geen probleem */ }
}

// Foto's zacht laten infaden zodra ze binnenkomen; cache-hits verschijnen direct
function _fadeInFotos(scope) {
  scope.querySelectorAll("img.item-thumb, img.modal-img").forEach(img => {
    if (img.complete) return;
    img.style.opacity = "0";
    img.addEventListener("load", () => {
      img.style.transition = "opacity .3s ease";
      img.style.opacity = "1";
    }, { once: true });
  });
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
      // "Mijn items": strikt eigen items — zelf geüpload (ook nog niet aangeboden)
      // of zelf aangeboden. Gemeente-genoten (bv. collega-scanners) horen hier
      // NIET tussen, ook al zitten hun items in de data.
      source = allItems.filter(i =>
        !i.aangeboden_door_naam && (i.uploaded_by === _userId || i.aanbieding_id));
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
    if (!_itemsGeladen) {
      // Skeleton-rijen: de lijst krijgt meteen zijn vorm, laden voelt korter
      list.innerHTML = Array.from({ length: 4 }, (_, i) => `
        <div class="item-row sk-row" style="--stagger:${i * 60}ms">
          <div class="skeleton sk-thumb"></div>
          <div class="item-info">
            <div class="skeleton sk-lijn" style="width:${62 - i * 7}%"></div>
            <div class="skeleton sk-lijn kort" style="width:${38 - i * 4}%"></div>
          </div>
        </div>`).join("");
      return;
    }
    let leeg = `<div class="wachtstand">
      <div class="wachtstand-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2c6e3f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg></div>
      <div class="wachtstand-titel">Geen items gevonden</div>
      <p>Er staat hier op dit moment niets.</p>
    </div>`;
    if (q) {
      leeg = `<div class="wachtstand">
        <div class="wachtstand-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2c6e3f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>
        <div class="wachtstand-titel">Niets gevonden</div>
        <p>Geen items die passen bij &lsquo;${_esc(q)}&rsquo;. Probeer een ander zoekwoord.</p>
      </div>`;
    } else if (activeMain === "aanbieden" && activeSubtab === "aangeboden") {
      leeg = `<div class="wachtstand">
        <div class="wachtstand-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2c6e3f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5a2 2 0 0 1 2-2h1.6l1.2-1.8a1.5 1.5 0 0 1 1.25-.7h5.9a1.5 1.5 0 0 1 1.25.7l1.2 1.8H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.6"/></svg></div>
        <div class="wachtstand-titel">Nog geen items aangeboden</div>
        <p>Scan je eerste item en bied het aan lokale afnemers aan — binnen een minuut staat het hier.</p>
        <button class="btn btn-primary wachtstand-knop" onclick="document.querySelector('[data-tab=scan]').click()">Eerste item scannen</button>
      </div>`;
    }
    if (!q && _role === "bedrijf" && activeMain !== "aanbieden") {
      leeg = `<div class="wachtstand">
        <div class="wachtstand-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2c6e3f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></div>
        <div class="wachtstand-titel">Nog geen aanbod voor jou</div>
        <p>Zodra de milieustraat iets aanbiedt dat bij jouw bedrijf past, krijg je direct een melding en verschijnt het hier.</p>
      </div>`;
    } else if (!q && activeMain === "aanbieden" && activeSubtab === "reacties") {
      leeg = `<div class="wachtstand">
        <div class="wachtstand-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2c6e3f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
        <div class="wachtstand-titel">Nog geen reacties</div>
        <p>Je krijgt een melding zodra een bedrijf reageert op je aanbiedingen.</p>
      </div>`;
    }
    list.innerHTML = leeg;
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
          <div class="item-kop">
            <span class="item-titel">${_esc(item.ai_label || "Niet herkend")}</span>
          </div>
          ${_itemSubRegel(item)}
        </div>
        <div class="item-rechts">
          <span class="item-tijd">${formatTime(item.timestamp)}</span>
          ${item.aanbieding_id ? `<span class="item-chat-icon${_hasUnread(item) ? ' has-unread' : ''}" onclick="event.stopPropagation();openModal(${item.id},true)">${SVG.chat}</span>` : ""}
        </div>
      </div>`;
    if (!kanVerwijderen) return rij;
    return `
    <div class="swipe-wrap" data-id="${item.id}">
      <button class="swipe-del-btn" onclick="vraagVerwijderen(${item.id}, this)">${SVG.trash}</button>
      ${rij}
    </div>`;
  }).join("");
  _fadeInFotos(list);
  if (kanVerwijderen && !_swipeReady) { _initSwipe(); _swipeReady = true; }

  if (totalPages > 1) {
    const from = _listPage * _PAGE_SIZE + 1;
    const to   = Math.min(from + pagina.length - 1, filtered.length);
    const nav  = document.createElement("div");
    nav.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:14px 16px 4px;gap:8px;";
    nav.innerHTML = `
      <button onclick="_goPagina(${_listPage - 1})" ${_listPage === 0 ? "disabled" : ""}
        style="padding:9px 18px;border:1px solid var(--border);border-radius:100px;background:none;font-family:'Inter',sans-serif;font-size:0.8rem;font-weight:700;color:var(--muted);cursor:pointer;${_listPage === 0 ? "opacity:0.3;cursor:default;" : ""}">
        ← Vorige
      </button>
      <span style="font-size:0.8rem;color:var(--muted);">${from}–${to} van ${filtered.length}</span>
      <button onclick="_goPagina(${_listPage + 1})" ${_listPage >= totalPages - 1 ? "disabled" : ""}
        style="padding:9px 18px;border:1px solid var(--border);border-radius:100px;background:none;font-family:'Inter',sans-serif;font-size:0.8rem;font-weight:700;color:var(--muted);cursor:pointer;${_listPage >= totalPages - 1 ? "opacity:0.3;cursor:default;" : ""}">
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
  const wrap  = document.getElementById("modal-carousel");
  if (wrap && _carouselUrls[_carouselIdx])
    wrap.style.setProperty("--foto", `url("${_carouselUrls[_carouselIdx]}")`);
  const prev  = document.getElementById("carousel-prev");
  const next  = document.getElementById("carousel-next");
  const dots  = document.getElementById("carousel-dots");
  const multi = _carouselUrls.length > 1;

  img.src = _carouselUrls[_carouselIdx] || "";
  _fadeInFotos(img.parentElement || document);
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
  document.getElementById("modal-ts").textContent = new Date(item.timestamp)
    .toLocaleString("nl-NL", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const chips = [];
  if (item.category) chips.push(`<span class="m-chip">${_esc(item.category)}</span>`);
  if (item.gemeente) chips.push(`<span class="m-chip">📍 ${_esc(item.gemeente)}</span>`);
  document.getElementById("modal-chips").innerHTML = chips.join("");
  document.getElementById("modal-note").value  = item.manual_note || "";
  document.getElementById("modal-cat").value   = item.category || "";

  // Herstel de standaard actieknoppen (kunnen vervangen zijn door match-/reden-kaart)
  if (!window._bedrijfActiesHTML) window._bedrijfActiesHTML = document.getElementById("modal-bedrijf-acties").innerHTML;
  document.getElementById("modal-bedrijf-acties").innerHTML = window._bedrijfActiesHTML;

  // Reactie op eigen aanbod bekeken → bolletje op de Aanbod-tab bijwerken
  if (item.aanbieding_id && !item.aangeboden_door_naam && item.aanbieding_status) {
    localStorage.setItem(`reactie_gezien_${item.aanbieding_id}`, item.aanbieding_status);
    _updateAanbodTeller();
  }

  // Ontvanger: bedrijf-rol én item is aangeboden ÁÁN dit bedrijf
  const isOntvanger = _role === "bedrijf" && !!item.aanbieding_id && !!item.aangeboden_door_naam;
  // Aanbieder: de ingelogde gebruiker heeft dit item zelf aangeboden (geen bedrijf-rol)
  const isAanbieder = !!item.aanbieding_id && !item.aangeboden_door_naam;
  document.getElementById("modal-bedrijf-acties").style.display    = isOntvanger ? "block" : "none";
  document.getElementById("modal-aanbieder-reactie").style.display = "none";
  document.getElementById("modal-edit-acties").style.display       = isOntvanger ? "none" : "block";
  document.getElementById("modal-bewerk-velden").style.display     = isOntvanger ? "none" : "block";
  if (isOntvanger) {
    const aanbiederNaam = item.aangeboden_door_naam || "CIRQO";
    document.getElementById("modal-aanbieder").textContent = aanbiederNaam;
    const avatar = document.getElementById("modal-aanbieder-avatar");
    if (avatar) avatar.textContent = aanbiederNaam.trim().charAt(0).toUpperCase();
    const statusInfo = { open: ["In afwachting", "msb-open"], ophalen: ["Wordt opgehaald ✓", "msb-ophalen"], niet_nodig: ["Niet nodig", "msb-niet_nodig"] };
    const si = statusInfo[item.aanbieding_status];
    const stEl = document.getElementById("modal-aanbieding-status");
    stEl.textContent = si ? si[0] : "";
    stEl.className = "modal-status-badge " + (si ? si[1] : "");
    stEl.style.display = si ? "inline-block" : "none";
    const btnOp  = document.getElementById("modal-btn-ophalen");
    const btnNee = document.getElementById("modal-btn-niet-nodig");
    btnOp.onclick  = () => reagerenOpAanbieding(item.aanbieding_id, "ophalen",    id);
    btnNee.onclick = () => reagerenOpAanbieding(item.aanbieding_id, "niet_nodig", id);
    // Al gereageerd? Toon de gekozen knop nadrukkelijk en demp de andere —
    // wijzigen blijft mogelijk, maar de staat is in één oogopslag duidelijk
    btnOp.classList.toggle("actie-gedempt",  item.aanbieding_status === "niet_nodig");
    btnNee.classList.toggle("actie-gedempt", item.aanbieding_status === "ophalen");
  } else if (item.aanbieding_id && item.bedrijf_naam) {
    document.getElementById("modal-aanbieder").textContent = `Aangeboden aan ${item.bedrijf_naam}`;
    document.getElementById("modal-aanbieding-status").textContent = "";
  }

  document.getElementById("modal").classList.remove("hidden");

  // Chat: opent als apart scherm via de knop (niet meer inline in de detailpagina)
  const chatWrap = document.getElementById("modal-chat");
  chatWrap.style.display = "none";
  if (isOntvanger || isAanbieder) {
    chatWrap.style.display = "block";
    document.getElementById("modal-chat-open").onclick = () => openChatScherm(item.aanbieding_id, item.ai_label || "");
    if (scrollToChat) openChatScherm(item.aanbieding_id, item.ai_label || "");
  }

  // Reacties-lijst met Chat-per-bedrijf: alleen voor de aanbieder/beheerder.
  // Een ontvangend bedrijf heeft al de "Gesprek openen"-knop — anders staat er
  // dubbel een chat-ingang op de detailpagina.
  const aSection = document.getElementById("modal-aanbiedingen");
  const aList    = document.getElementById("modal-aanbiedingen-list");
  aSection.style.display = "none";
  aList.innerHTML = "";
  const res = isOntvanger ? null : await apiFetch(`/api/items/${id}/aanbiedingen`);
  if (res && res.ok) {
    const aanbiedingen = await res.json();
    if (aanbiedingen.length) {
      // Meerdere gesprekken mogelijk (één per bedrijf) → de lijst is de chat-ingang;
      // de generieke "Gesprek openen"-knop verdwijnt dan
      chatWrap.style.display = "none";
      const slabel = { open: "Wacht op reactie", ophalen: "Match — wordt opgehaald", niet_nodig: "Niet nodig" };
      const scls   = { open: "color:#e67e00", ophalen: "color:#2e7d32", niet_nodig: "color:#c0392b" };
      aList.innerHTML = aanbiedingen.map(a => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:0.86rem;">${_esc(a.bedrijf_naam || "—")}</div>
            <div style="font-size:0.8rem;${scls[a.status]||''};margin-top:2px;">${slabel[a.status]||a.status}</div>
          </div>
          <button onclick="openChatScherm(${a.id}, '${escJs(a.bedrijf_naam || "")}')"
            title="Chat openen"
            style="padding:7px 10px;border-radius:100px;border:1.5px solid var(--border);background:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;gap:5px;font-size:0.8rem;">
            ${SVG.chat} Chat
          </button>
        </div>`).join("");
      aSection.style.display = "block";
    }
  }
}

// ── Ophaaladressen van de Waardlanden-milieustraten (match-vervolg) ────────────
const MILIEUSTRAAT_INFO = {
  "Hardinxveld-Giessendam": { naam: "Milieustraat Hardinxveld-Giessendam", adres: "Schrank 10, Hardinxveld-Giessendam" },
  "Gorinchem":              { naam: "Milieustraat Gorinchem",              adres: "Boezem 3, Gorinchem" },
  "Vijfheerenlanden":       { naam: "Milieustraat Leerdam",                adres: "Handelstraat 15, Leerdam" },
  "Molenlanden":            { naam: "Ecopark Groot-Ammers",                adres: "Transportweg 6, Groot-Ammers" },
};

async function reagerenOpAanbieding(aanbiedingId, status, itemId) {
  const item = allItems.find(i => i.id === itemId);
  const fd = new FormData();
  fd.append("status", status);
  const res = await apiFetch(`/api/mijn-aanbiedingen/${aanbiedingId}`, { method: "PATCH", body: fd });
  if (!res || !res.ok) { (window.uxToast || alert)("Opslaan mislukt — probeer het opnieuw", "error"); return; }
  if (item) item.aanbieding_status = status;
  (window.uxHaptic || (() => {}))(status === "ophalen" ? "succes" : "licht");
  _bewaarItemsCache();
  renderItems();
  _updateAanbodTeller();

  // Vervolgstap in de modal: match-info of reden-chips
  const wrap = document.getElementById("modal-bedrijf-acties");
  if (status === "ophalen") {
    const info = MILIEUSTRAAT_INFO[item?.gemeente];
    wrap.innerHTML = `<hr class="divider">
      <div class="match-titel">Match — dit staat voor je klaar!</div>
      ${info
        ? `<div class="match-adres"><b>${_esc(info.naam)}</b><br>${_esc(info.adres)}</div>`
        : (item?.gemeente ? `<div class="match-adres">Op te halen bij de milieustraat in <b>${_esc(item.gemeente)}</b></div>` : "")}
      <button class="btn btn-primary" style="width:100%;margin-top:12px;" onclick="_stemOphaalAf(${aanbiedingId}, '${escJs(item?.ai_label || "")}')">${SVG.chat} Stem het ophaalmoment af</button>
      <button class="btn btn-ghost" style="width:100%;margin-top:8px;" onclick="document.getElementById('modal').classList.add('hidden')">Klaar</button>`;
    setTimeout(() => _confettiBurst(wrap.querySelector(".match-titel")), 120);
  } else {
    wrap.innerHTML = `<hr class="divider">
      <div class="match-titel">Genoteerd — niet nodig.</div>
      <p style="font-size:0.8rem;color:var(--muted);margin:6px 0 10px;">Mogen we weten waarom? Dat helpt de milieustraat gerichter aanbieden (optioneel).</p>
      <div class="reden-chips">
        ${["Te groot", "Geen ruimte", "Verkeerde soort", "Anders"].map(r =>
          `<button class="reden-chip" onclick="_stuurReden(${aanbiedingId}, '${escJs(r)}', this)">${r}</button>`).join("")}
      </div>
      <button class="btn btn-ghost" style="width:100%;margin-top:12px;" onclick="document.getElementById('modal').classList.add('hidden')">Overslaan</button>`;
  }
}

async function _stemOphaalAf(aanbiedingId, titel) {
  document.getElementById("modal").classList.add("hidden");
  openChatScherm(aanbiedingId, titel);
  const inp = document.getElementById("chat-input");
  if (inp && !inp.value) inp.value = "Hoi! Wanneer komt het uit dat ik dit kom ophalen?";
}

async function _stuurReden(aanbiedingId, reden, knop) {
  document.querySelectorAll(".reden-chip").forEach(c => { c.disabled = true; });
  knop.classList.add("gekozen");
  const fd = new FormData();
  fd.append("reden", reden);
  await apiFetch(`/api/mijn-aanbiedingen/${aanbiedingId}`, { method: "PATCH", body: fd });
  const item = allItems.find(i => i.aanbieding_id === aanbiedingId);
  if (item) item.niet_nodig_reden = reden;
  setTimeout(() => document.getElementById("modal").classList.add("hidden"), 700);
}
window._stemOphaalAf = _stemOphaalAf;
window._stuurReden = _stuurReden;

function openChatVoorAanbieding(aanbiedingId) {
  openChatScherm(aanbiedingId, "");
}

// "Reacties"-knop op het scanscherm: rolbewust — een bedrijf heeft zijn reacties
// onder Ontvangen › Mijn reacties, een scanner onder Aanbieden › Reacties
function gaNaarReacties() {
  document.querySelector('[data-tab=list]')?.click();
  setTimeout(() => {
    if (_role === "bedrijf") {
      document.querySelector('.list-maintab[data-main="ontvangen"]')?.click();
      setTimeout(() => document.querySelector('[data-subtab="mijn-reacties"]')?.click(), 60);
    } else {
      document.querySelector('[data-subtab="reacties"]')?.click();
    }
  }, 100);
}
window.gaNaarReacties = gaNaarReacties;

// ── Chatscherm (apart, volledig scherm) ─────────────────────────────────────
function openChatScherm(aanbiedingId, titel) {
  window._chatAanbiedingId = aanbiedingId;
  document.getElementById("chat-kop-sub").textContent = titel || "";
  document.getElementById("chat-berichten").innerHTML = "";
  document.getElementById("chat-input").value = "";
  document.getElementById("chat-scherm").classList.remove("hidden");
  laadBerichten(aanbiedingId);
  _startChatPoll(aanbiedingId);
}
function sluitChatScherm() {
  document.getElementById("chat-scherm").classList.add("hidden");
  _stopChatPoll();
  window._chatAanbiedingId = null;
}
window.sluitChatScherm = sluitChatScherm;

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

// _esc en escJs komen uit cirqo-core.js.

// Lege chat: uitnodigende start met rolbewuste openingszinnen (één tik = versturen)
function _chatStarterHTML() {
  const isAfnemer = _role === "bedrijf";
  const openers = isAfnemer
    ? ["Hoi! Ik heb hier interesse in.",
       "Is dit nog beschikbaar?",
       "Wanneer kan ik het ophalen?"]
    : ["Hoi! Dit ligt voor je klaar.",
       "Interesse? Ik hoor het graag.",
       "Wanneer komt ophalen je uit?"];
  const chips = openers.map(t =>
    `<button type="button" class="chat-opener" onclick="_chatStart('${escJs(t)}')">${_esc(t)}</button>`
  ).join("");
  return `<div class="chat-starter">
    <span class="chat-starter-ico" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2c6e3f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </span>
    <div class="chat-starter-titel">Begin het gesprek</div>
    <div class="chat-starter-sub">Kies een opener of typ zelf iets hieronder.</div>
    <div class="chat-openers">${chips}</div>
  </div>`;
}

// Opener-tik: zet de tekst in het invoerveld en verstuur meteen
function _chatStart(tekst) {
  const input = document.getElementById("chat-input");
  input.value = tekst;
  verstuurBericht();
}
window._chatStart = _chatStart;

async function laadBerichten(aanbiedingId, silent = false) {
  const res = await apiFetch(`/api/aanbiedingen/${aanbiedingId}/berichten`);
  if (!res || !res.ok) return;
  const berichten = await res.json();
  const mijnId = JSON.parse(atob(token.split(".")[1])).sub;
  const wrap = document.getElementById("chat-berichten");
  if (!berichten.length) {
    if (!silent && !wrap.querySelector(".chat-starter")) wrap.innerHTML = _chatStarterHTML();
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
  if (wrap.querySelector(".chat-empty, .chat-starter")) wrap.innerHTML = "";
  wrap.innerHTML += `<div class="chat-spacer"></div>
    <div class="chat-msg mine">${_esc(tekst)}<div class="chat-msg-tijd">${nu}</div></div>`;
  wrap.scrollTop = wrap.scrollHeight;
  input.value = "";
  (window.uxHaptic || (() => {}))("licht");

  const fd = new FormData(); fd.append("tekst", tekst);
  const res = await apiFetch(`/api/aanbiedingen/${aanbiedingId}/berichten`, { method: "POST", body: fd });
  if (!res || !res.ok) {
    // Verzending mislukt: zet de getypte tekst terug zodat niets verloren gaat
    (window.uxToast || alert)("Bericht niet verzonden — je tekst staat er nog", "error");
    if (!input.value.trim()) input.value = tekst;
    laadBerichten(aanbiedingId);
    return;
  }
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
  if (!currentItemId) return;
  const zeker = window.uxBevestig
    ? await uxBevestig("Item verwijderen?", "Het item verdwijnt uit je lijsten. De dashboard-tellingen blijven bewaard.")
    : confirm("Verwijderen?");
  if (!zeker) return;
  const id = currentItemId;
  allItems = allItems.filter(i => i.id !== id);
  _bewaarItemsCache();
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
  _bewaarItemsCache();
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
  const status = document.getElementById("push-status");
  const standaardSub = "Bericht bij nieuw aanbod en reacties";
  // Native schil: status via het app-kanaal
  if (_isNativeSchil()) {
    try {
      const PN = window.Capacitor?.Plugins?.PushNotifications;
      const perm = PN ? await PN.checkPermissions() : null;
      if (perm && perm.receive === "granted") {
        _zetPushChip("aan");
        status.textContent = "Meldingen staan aan voor dit account";
        document.querySelector("#user-panel .acc-rij-ico")?.classList.add("actief");
      } else if (perm && perm.receive === "denied") {
        _zetPushChip("blok");
        status.textContent = "Sta meldingen toe via de toestelinstellingen";
      } else {
        _zetPushChip("uit");
        status.textContent = standaardSub;
      }
    } catch (e) { _zetPushChip("uit"); }
    return;
  }
  if (!("serviceWorker" in navigator) || !("Notification" in window)) { _zetPushChip("uit"); return; }
  try {
    _swReg = await navigator.serviceWorker.register("/sw.js");
  } catch (e) { _zetPushChip("uit"); return; }

  const Notif = window.Notification;
  if (!Notif) { _zetPushChip("uit"); return; }
  if (Notif.permission === "granted") {
    try {
      const bestaand = await _swReg.pushManager.getSubscription();
      if (!bestaand) await _abonneerPush();
      _zetPushChip("aan");
      status.textContent = "Meldingen staan aan voor dit account";
      document.querySelector("#user-panel .acc-rij-ico")?.classList.add("actief");
    } catch (e) {
      _zetPushChip("uit");
      status.textContent = "Tik om meldingen opnieuw te activeren";
    }
  } else if (Notif.permission === "denied") {
    _zetPushChip("blok");
    status.textContent = "Meldingen staan geblokkeerd in je browserinstellingen";
  } else {
    _zetPushChip("uit");
    status.textContent = standaardSub;
  }
}

async function meldingInschakelen() {
  const status = document.getElementById("push-status");
  status.textContent = "Bezig…";
  // Native schil: meldingen via het app-kanaal (FCM/APNs) i.p.v. web push
  if (_isNativeSchil()) {
    try {
      await _registreerNativePush();
      _zetPushChip("aan");
      status.textContent = "Meldingen staan aan voor dit account";
      document.querySelector("#user-panel .acc-rij-ico")?.classList.add("actief");
      _toonPushGelukt();
    } catch (e) {
      _zetPushChip("uit");
      status.textContent = e.message || "Meldingen inschakelen is niet gelukt.";
    }
    return;
  }
  const Notif = window.Notification;
  if (!Notif) {
    _zetPushChip("uit");
    status.textContent = "Push wordt niet ondersteund in deze browser.";
    return;
  }
  try {
    const perm = await Notif.requestPermission();
    if (perm === "granted") {
      await _abonneerPush();
      _zetPushChip("aan");
      status.textContent = "Meldingen staan aan voor dit account";
      document.querySelector("#user-panel .acc-rij-ico")?.classList.add("actief");
      _toonPushGelukt();
    } else {
      _zetPushChip("blok");
      status.textContent = "Sta meldingen toe via de browserinstellingen.";
    }
  } catch (e) {
    _zetPushChip("uit");
    status.textContent = "Inschakelen is niet gelukt — probeer het opnieuw.";
  }
}

function _toonPushGelukt() {
  const status = document.getElementById("push-status");
  status.textContent = "✓ Meldingen staan aan voor dit account";
  status.style.display = "block";
  document.querySelector("#user-panel .acc-rij-ico")?.classList.add("actief");
  const kaart = document.getElementById("push-btn")?.closest(".acc-kaart");
  if (!kaart || kaart.querySelector(".push-gelukt")) return;
  const el = document.createElement("div");
  el.className = "push-gelukt";
  el.innerHTML = `
    <span class="push-gelukt-cirkel" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline class="push-gelukt-vink" points="20 6 9 17 4 12"/></svg>
    </span>
    <div class="push-gelukt-titel">Meldingen staan aan!</div>
    <p class="push-gelukt-tekst">Je krijgt vanaf nu direct bericht bij nieuw aanbod en reacties — ook als de app dicht is.</p>
    <button type="button" class="btn btn-primary push-gelukt-knop">Begrepen</button>`;
  el.querySelector(".push-gelukt-knop").onclick = () => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  };
  kaart.appendChild(el);
  if (window._confettiBurst || typeof _confettiBurst === "function")
    setTimeout(() => _confettiBurst(el.querySelector(".push-gelukt-cirkel")), 250);
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

// ── Native schil (Play Store/App Store-app via Capacitor) ──────────────────────
// In de schil werkt web push niet; meldingen lopen dan via het native kanaal
// (FCM/APNs). Het token wordt via hetzelfde subscribe-endpoint opgeslagen.
function _isNativeSchil() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

async function _registreerNativePush() {
  const PN = window.Capacitor?.Plugins?.PushNotifications;
  if (!PN) throw new Error("Pushmodule niet beschikbaar in deze app-versie");
  const perm = await PN.requestPermissions();
  if (perm.receive !== "granted") throw new Error("Toestemming geweigerd");
  return new Promise((res, rej) => {
    const klaar = setTimeout(() => rej(new Error("Registratie duurde te lang")), 15000);
    PN.addListener("registration", async (t) => {
      clearTimeout(klaar);
      try {
        await apiFetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: { type: "fcm", token: t.value } }),
        });
        res(true);
      } catch (e) { rej(e); }
    });
    PN.addListener("registrationError", () => { clearTimeout(klaar); rej(new Error("Registratie mislukt")); });
    PN.register();
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
  // Native schil: token bij elke start opnieuw aan dit account koppelen
  if (_isNativeSchil()) {
    try {
      const PN = window.Capacitor?.Plugins?.PushNotifications;
      const perm = PN ? await PN.checkPermissions() : null;
      if (perm && perm.receive === "granted") await _registreerNativePush();
    } catch (e) { /* stil — best-effort */ }
    return;
  }
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
  // Gemeente-opties lazy: paneel opent direct, dropdowns vullen zodra geladen
  _zorgGemeentenGeladen().then(() => {
    const upGem = document.getElementById("up-gemeente");
    if (upGem) upGem.value = gem;
    const upMil = document.getElementById("up-milieustraat");
    if (upMil && gem) _vulMilieustraatSelect(upMil, gem, mil);
  });
  const orgInit = localStorage.getItem("organisatie") || _username || "";
  document.getElementById("up-organisatie").value = orgInit;
  _zetAccWaardes(orgInit);
  // Alle uitklap-secties dicht bij openen
  ["org", "loc", "pwd"].forEach(k => accToggle(k, true));
  document.getElementById("up-pwd").value = "";
  const pwd2 = document.getElementById("up-pwd2"); if (pwd2) pwd2.value = "";
  // Identiteitskop: naam, avatar-initiaal en rol-pill
  const rolLabels = { superadmin: "Platform", admin: "Beheerder", user: "Scanner", bedrijf: "Afnemer" };
  _vulAccountKop(orgInit, rolLabels[_role] || _role);
  document.getElementById("user-panel").classList.remove("hidden");
  initPush();
  const res = await apiFetch("/api/auth/me");
  if (res && res.ok) {
    const me = await res.json();
    const org = me.organisatie || me.username || _username || "";
    document.getElementById("up-organisatie").value = org;
    document.getElementById("up-email").value = me.email || "";
    document.getElementById("up-contactpersoon").value = me.contactpersoon || "";
    document.getElementById("up-telefoon").value = me.telefoon || "";
    document.getElementById("up-adres").value = me.adres || "";
    localStorage.setItem("organisatie", org);
    _vulAccountKop(org, rolLabels[_role] || _role);
    _zetAccWaardes(org);
    _zetHeaderAccount();
    _zetDigestUI(!!me.melding_digest);
  }
}

// ── Meldingsritme: direct of één samenvatting per dag (S3.8) ──────────────────
function _zetDigestUI(dagelijks) {
  document.getElementById("digest-direct")?.classList.toggle("actief", !dagelijks);
  document.getElementById("digest-dag")?.classList.toggle("actief", dagelijks);
  const sub = document.getElementById("digest-sub");
  if (sub) sub.textContent = dagelijks
    ? "Eén samenvatting per dag, rond 16:00"
    : "Direct bij nieuw aanbod en berichten";
}
async function zetDigest(dagelijks) {
  const fd = new FormData();
  fd.append("melding_digest", dagelijks ? "true" : "false");
  const res = await apiFetch(`/api/users/${_userId}/profiel`, { method: "PATCH", body: fd });
  if (res && res.ok) {
    _zetDigestUI(dagelijks);
    (window.uxHaptic || (() => {}))("licht");
    (window.uxToast || (() => {}))(dagelijks
      ? "Je krijgt voortaan 1 samenvatting per dag"
      : "Je krijgt meldingen weer direct", "success");
  }
}
window.zetDigest = zetDigest;

// Waarde-labels rechts in de rijen: de pagina leest als een overzicht
function _zetAccWaardes(org) {
  const orgW = document.getElementById("org-waarde");
  if (orgW) orgW.textContent = org || "—";
  const locW = document.getElementById("loc-waarde");
  if (locW) {
    const gem = localStorage.getItem("gemeente") || "";
    const mil = localStorage.getItem("milieustraat") || "";
    locW.textContent = mil || gem || "—";
  }
}

// Uitklap-secties (accordeon): één tegelijk open
function accToggle(key, forceDicht) {
  const uit = document.getElementById(`${key}-uitklap`);
  const chevron = document.getElementById(`${key}-chevron`);
  if (!uit) return;
  const isOpen = uit.classList.contains("open");
  if (forceDicht === true || isOpen) {
    uit.classList.remove("open");
    if (chevron) chevron.style.transform = "";
    return;
  }
  ["org", "loc", "pwd"].filter(k => k !== key).forEach(k => accToggle(k, true));
  uit.classList.add("open");
  if (chevron) chevron.style.transform = "rotate(90deg)";
  if (key === "org") setTimeout(() => document.getElementById("up-organisatie").focus(), 60);
  if (key === "pwd") setTimeout(() => document.getElementById("up-pwd").focus(), 60);
}
window.accToggle = accToggle;

// Mijn gegevens: alle profielvelden in één keer opslaan
async function slaProfielOp() {
  const organisatie = document.getElementById("up-organisatie").value.trim();
  const userId = JSON.parse(atob(token.split(".")[1])).sub;
  try {
    const fd = new FormData();
    fd.append("organisatie", organisatie);
    fd.append("contactpersoon", document.getElementById("up-contactpersoon").value.trim());
    fd.append("telefoon", document.getElementById("up-telefoon").value.trim());
    fd.append("adres", document.getElementById("up-adres").value.trim());
    const res = await apiFetch(`/api/users/${userId}/profiel`, { method: "PATCH", body: fd });
    if (!res || !res.ok) throw new Error();
    if (organisatie) {
      localStorage.setItem("organisatie", organisatie);
      _vulAccountKop(organisatie, document.getElementById("up-rol-label")?.textContent);
      _zetHeaderAccount();
    }
    _zetAccWaardes(organisatie || _username);
    accToggle("org", true);
    (window.uxToast || (() => {}))("Gegevens opgeslagen", "success");
  } catch (e) {
    (window.uxToast || (() => {}))("Opslaan is niet gelukt — probeer opnieuw", "error");
  }
}
window.slaProfielOp = slaProfielOp;

// Locatie: wijzigingen in de dropdowns worden direct opgeslagen
async function slaLocatieOp() {
  const gemeente = (document.getElementById("up-gemeente")?.value || "").trim();
  const milieustraat = (document.getElementById("up-milieustraat")?.value || "").trim();
  const userId = JSON.parse(atob(token.split(".")[1])).sub;
  try {
    if (gemeente && gemeente !== (localStorage.getItem("gemeente") || "")) {
      const fd = new FormData(); fd.append("gemeente", gemeente);
      const res = await apiFetch(`/api/users/${userId}/gemeente`, { method: "PATCH", body: fd });
      if (res && res.ok) {
        const data = await res.json();
        localStorage.setItem("token", data.token);
        localStorage.setItem("gemeente", data.gemeente);
      }
      const upMil = document.getElementById("up-milieustraat");
      if (upMil) _vulMilieustraatSelect(upMil, gemeente, "");
    }
    if (milieustraat) localStorage.setItem("milieustraat", milieustraat);
    _zetAccWaardes(localStorage.getItem("organisatie") || _username);
    _zetHeaderAccount();
    (window.uxToast || (() => {}))("Locatie opgeslagen", "success");
  } catch (e) {
    (window.uxToast || (() => {}))("Opslaan is niet gelukt — probeer opnieuw", "error");
  }
}
window.slaLocatieOp = slaLocatieOp;

// Meldingen-rij: alleen actie als ze nog niet aanstaan
function meldingRijKlik() {
  const chip = document.getElementById("push-chip");
  if (chip && chip.classList.contains("aan")) return;
  meldingInschakelen();
}
window.meldingRijKlik = meldingRijKlik;

function _zetPushChip(staat) {
  const digestRij = document.getElementById("digest-rij");
  if (digestRij) digestRij.style.display = staat === "aan" ? "" : "none";
  const chip = document.getElementById("push-chip");
  if (!chip) return;
  chip.classList.remove("aan", "uit", "blok");
  if (staat === "aan")      { chip.textContent = "Aan";         chip.classList.add("aan"); }
  else if (staat === "blok"){ chip.textContent = "Geblokkeerd"; chip.classList.add("blok"); }
  else                      { chip.textContent = "Zet aan";     chip.classList.add("uit"); }
}

function _vulAccountKop(naam, rol) {
  const n = (naam || "Mijn account").trim();
  document.getElementById("up-naam").textContent = n;
  const av = document.getElementById("up-avatar");
  if (av) {
    if (_isWaardlanden()) {
      av.classList.add("hdr-avatar-logo");
      av.innerHTML = '<img src="/static/waardlanden-globe.png" alt="Waardlanden">';
    } else {
      av.classList.remove("hdr-avatar-logo");
      av.textContent = n.charAt(0).toUpperCase();
    }
  }
  const rolEl = document.getElementById("up-rol-label");
  if (rolEl) rolEl.textContent = rol || "";
  // Gemeente-pill + versienummer in de voettekst
  const gemPill = document.getElementById("up-gem-pill");
  const gem = localStorage.getItem("gemeente") || "";
  if (gemPill) {
    gemPill.textContent = gem || "";
    gemPill.style.display = gem ? "" : "none";
  }
  const versieEl = document.getElementById("up-versie");
  if (versieEl && window._APP_VERSION) versieEl.textContent = String(window._APP_VERSION).slice(0, 7);
}

// (Volgorde-bedrijven-sectie en de 'Automatisch doorsturen'-toggle zijn
//  vervallen: aanbieden gaat via multi-select, niet meer sequentieel.)

function closeUserPanel() {
  document.getElementById("user-panel").classList.add("hidden");
}

function toggleWachtwoord() { accToggle("pwd"); }
window.toggleWachtwoord = toggleWachtwoord;

async function slaWachtwoordOp() {
  const pwd  = document.getElementById("up-pwd").value;
  const pwd2 = document.getElementById("up-pwd2").value;
  const st   = document.getElementById("pwd-status");
  st.style.color = "var(--danger)";
  if (pwd.length < 6)   { st.textContent = "Minimaal 6 tekens."; return; }
  if (pwd !== pwd2)     { st.textContent = "De twee wachtwoorden zijn niet gelijk."; return; }
  const btn = document.querySelector("#pwd-uitklap .btn");
  const userId = JSON.parse(atob(token.split(".")[1])).sub;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Opslaan…'; }
  try {
    const fd = new FormData(); fd.append("password", pwd);
    const res = await apiFetch(`/api/users/${userId}/password`, { method: "PATCH", body: fd });
    if (!res || !res.ok) throw new Error();
    (window.uxToast || (() => {}))("Wachtwoord gewijzigd", "success");
    accToggle("pwd", true);
    document.getElementById("up-pwd").value = "";
    document.getElementById("up-pwd2").value = "";
  } catch (e) {
    st.textContent = "Wijzigen is niet gelukt — probeer het opnieuw.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Wachtwoord opslaan"; }
  }
}
window.slaWachtwoordOp = slaWachtwoordOp;

function _installPlatform() {
  // Native schil (App Store/Play Store-app): installeren is per definitie niet aan de orde
  if (_isNativeSchil()) return "installed";
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
  // app-install-field = sectielabel, app-install-kaart = de kaart eronder — beide weg
  ["install-fab", "app-install-field", "app-install-kaart", "install-pop"].forEach(id => {
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

_laadItemsUitCache();                        // toon direct de laatst bekende lijst (splitsecond)
syncAll();                                    // items verversen — wacht op níéts anders
setTimeout(_zorgGemeentenGeladen, 2500);      // paneel-data rustig ná de start-drukte
_ensurePushRegistered();
// Gebruikskanaal melden (update-adoptie zichtbaar voor beheer) — stil, na de start-drukte
setTimeout(() => {
  let kanaal = "browser";
  if (_isNativeSchil()) {
    const p = window.Capacitor?.getPlatform?.();
    kanaal = p === "ios" ? "native-ios" : "native-android";
  } else if ((window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true) {
    kanaal = "pwa";
  }
  const fd = new FormData(); fd.append("kanaal", kanaal);
  apiFetch("/api/gebruik", { method: "POST", body: fd, _stil: true })
    .then(r => r && r.ok ? r.json() : null)
    .then(d => { if (d && d.vernieuwd_token) localStorage.setItem("token", d.vernieuwd_token); })
    .catch(() => {});
}, 4000);
// Poll: 12s zolang de app zichtbaar is (fingerprint voorkomt onnodig hertekenen;
// warme servercache maakt de call ~200ms). Push + focus-sync dekken de rest.
setInterval(() => { if (!document.hidden) syncItems(); }, 12000);
// Pushmelding binnen terwijl de app open staat → direct verversen (niet op de poll wachten)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", e => {
    if (e.data && e.data.type === "push") { _lastItemsJson = ""; syncItems(); }
  });
}
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


// ── Over CIRQO ─────────────────────────────────────────────────────────────────
const _OVER_ICOON = {
  info:    '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  deel:    '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>',
  vraag:   '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  tel:     '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.5 2.8.7a2 2 0 0 1 1.7 2z"/>',
  gebouw:  '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-4h6v4"/>',
  schild:  '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  lijst:   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h6"/>',
};
function _overRij(icoon, titel, actie) {
  return `<button type="button" class="acc-actie-rij" onclick="${actie}">
    <span class="acc-rij-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${_OVER_ICOON[icoon]}</svg></span>
    <div class="acc-rij-tekst"><span class="acc-rij-titel">${titel}</span></div>
    <span class="acc-chevron">›</span></button>`;
}
function openOverCirqo() {
  const menu = document.getElementById("over-menu");
  menu.innerHTML = [
    _overRij("info",   "Wat doet CIRQO",             "overSub('wat')"),
    _overRij("deel",   "Anderen uitnodigen",         "overDelen()"),
    _overRij("vraag",  "Veelgestelde vragen",        "overSub('faq')"),
    _overRij("tel",    "Contact met CIRQO",          "overSub('contact')"),
    _overRij("gebouw", "Deelnemende organisaties",   "overSub('organisaties')"),
    _overRij("schild", "Privacy- en cookieverklaring", "overPagina('/privacy', 'Privacy- en cookieverklaring')"),
    _overRij("lijst",  "Algemene voorwaarden",       "overPagina('/voorwaarden', 'Algemene voorwaarden')"),
  ].join("");
  document.getElementById("over-panel").classList.remove("hidden");
}
window.openOverCirqo = openOverCirqo;

const _OVER_INHOUD = {
  wat: ["Wat doet CIRQO", `
    <p><b>CIRQO geeft spullen een tweede leven.</b></p>
    <p style="margin-top:10px;">Milieustraatmedewerkers scannen binnengebrachte materialen met één foto.
    Slimme herkenning maakt er direct een aanbieding van, en lokale afnemers — kringloopwinkels,
    scholen, sociale werkplaatsen — krijgen meteen een melding.</p>
    <p style="margin-top:10px;">Reageren kost één tik, de ophaling stem je af via de chat, en het
    dashboard laat zien hoeveel kilo's en CO₂ er samen bespaard zijn.</p>
    <p style="margin-top:10px;">Zo blijft bruikbaar materiaal in de regio, in plaats van in de container.</p>`],
  faq: ["Veelgestelde vragen", `
    <p><b>Hoe bied ik iets aan?</b><br>Tik op Scannen, maak een foto en kies aan wie je het aanbiedt.
    CIRQO herkent het item en vult omschrijving en gewicht automatisch in.</p>
    <p style="margin-top:12px;"><b>Wie ziet mijn aanbod?</b><br>Alleen de afnemers die jij selecteert
    binnen jouw regio.</p>
    <p style="margin-top:12px;"><b>Hoe snel krijg ik reactie?</b><br>Afnemers krijgen direct een
    melding. Reageren ze, dan zie jij dat meteen in de app — met een melding als je die aan hebt staan.</p>
    <p style="margin-top:12px;"><b>Hoe regel ik de ophaling?</b><br>Via het chatgesprek bij de
    aanbieding. Moment en plek stem je onderling af.</p>
    <p style="margin-top:12px;"><b>Krijg ik geen meldingen?</b><br>Zet ze aan via Mijn account →
    Meldingen. Staan ze geblokkeerd, sta ze dan toe via de instellingen van je toestel.</p>
    <p style="margin-top:12px;"><b>Ik wil een extra account voor een collega.</b><br>Vraag het aan
    via je eigen organisatie of mail naar info@cirqo.nl.</p>`],
  contact: ["Contact met CIRQO", `
    <p>Vragen, ideeën of hulp nodig? We horen het graag.</p>
    <p style="margin-top:12px;"><b>E-mail</b><br><a href="mailto:info@cirqo.nl" style="color:#2c6e3f;">info@cirqo.nl</a></p>
    <p style="margin-top:12px;"><b>Website</b><br><a href="https://www.cirqo.nl" target="_blank" rel="noopener" style="color:#2c6e3f;">www.cirqo.nl</a></p>
    <p style="margin-top:12px;">We reageren doorgaans binnen één werkdag.</p>`],
  organisaties: ["Deelnemende organisaties", `
    <p>CIRQO wordt gebruikt door milieustraten en lokale afnemers die samen materialen in de
    regio houden.</p>
    <p style="margin-top:10px;"><b>Milieustraten</b><br>De milieustraten van afvalbeheerder
    Waardlanden — actief voor de gemeenten Gorinchem, Hardinxveld-Giessendam, Molenlanden en
    Vijfheerenlanden.</p>
    <p style="margin-top:10px;"><b>Afnemers</b><br>Lokale kringloopwinkels, scholen,
    sociale werkplaatsen en maatschappelijke organisaties uit de regio.</p>
    <p style="margin-top:10px;">Ook meedoen met jouw organisatie? Mail naar
    <a href="mailto:info@cirqo.nl" style="color:#2c6e3f;">info@cirqo.nl</a>.</p>`],
};
function overSub(key) {
  const [titel, inhoud] = _OVER_INHOUD[key];
  document.getElementById("over-sub-titel").textContent = titel;
  document.getElementById("over-sub-inhoud").innerHTML = inhoud;
  document.getElementById("over-sub").classList.remove("hidden");
}
window.overSub = overSub;

// Privacy/voorwaarden: pagina-inhoud in de sheet laden (geen navigatie weg uit de app)
async function overPagina(pad, titel) {
  document.getElementById("over-sub-titel").textContent = titel;
  const doel = document.getElementById("over-sub-inhoud");
  doel.innerHTML = "Laden…";
  document.getElementById("over-sub").classList.remove("hidden");
  try {
    const res = await fetch(pad);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const kaart = doc.querySelector(".kaart");
    doel.innerHTML = kaart ? kaart.innerHTML.replace(/<h1[^>]*>.*?<\/h1>/s, "").replace(/<p class="datum".*?<\/p>/s, "") : "Kon de pagina niet laden.";
  } catch (e) {
    doel.innerHTML = "Kon de pagina niet laden — controleer je verbinding.";
  }
}
window.overPagina = overPagina;

// Uitnodigen: native deelvenster met terugval naar kopiëren
async function overDelen() {
  const tekst = "Bekijk CIRQO — samen geven we spullen een tweede leven: https://app.cirqo.nl/installeren";
  if (navigator.share) {
    try { await navigator.share({ title: "CIRQO", text: tekst }); } catch (e) {}
  } else {
    try {
      await navigator.clipboard.writeText(tekst);
      (window.uxToast || (() => {}))("Uitnodigingslink gekopieerd", "success");
    } catch (e) {}
  }
}
window.overDelen = overDelen;

// ═══ Sprint 2 UX: pull-to-refresh + terugknop-gedrag ═══════════════════════
// ux.js laadt ná dit script; daarom koppelen we pas bij DOMContentLoaded.
document.addEventListener("DOMContentLoaded", () => {

  // ── Pull-to-refresh: aanbodlijst en chatscherm (dashboard regelt het
  //    binnen zijn eigen frame — touches bereiken dit document daar niet)
  if (window.uxPullRefresh) {
    uxPullRefresh(document.getElementById("tab-list"), async () => {
      _lastItemsJson = "";               // forceer herrender, ook zonder wijzigingen
      await syncItems();
      renderItems();
    });
    uxPullRefresh(document.getElementById("chat-berichten"), async () => {
      if (window._chatAanbiedingId) await laadBerichten(window._chatAanbiedingId, true);
    });
  }

  // ── Terugknop sluit overlays (Android-terugknop, iOS-swipe-back, browser-terug).
  // Elk open paneel krijgt een history-entry; terug = bovenste overlay dicht in
  // plaats van de app verlaten. Sluiten via de eigen X consumeert de entry weer.
  const _terugStack = [];
  let _terugEigen = 0;
  function _terugOpen(naam, sluiter) {
    if (_terugStack.some(o => o.naam === naam)) return;
    _terugStack.push({ naam, sluiter });
    try { history.pushState({ cirqo_overlay: naam }, ""); } catch (e) {}
  }
  function _terugKlaar(naam) {
    const i = _terugStack.map(o => o.naam).lastIndexOf(naam);
    if (i < 0) return;
    _terugStack.splice(i, 1);
    _terugEigen++;
    try { history.back(); } catch (e) { _terugEigen--; }
  }
  window.addEventListener("popstate", () => {
    if (_terugEigen > 0) { _terugEigen--; return; }
    const boven = _terugStack.pop();
    if (boven) boven.sluiter();
  });

  // Overlays via een observer volgen: elk open/dicht-pad (knop, code, timeout)
  // wordt zo gedekt zonder alle bestaande functies te hoeven verbouwen.
  const _OVERLAYS = [
    { id: "modal",          isOpen: el => !el.classList.contains("hidden"),
      sluit: el => { el.classList.add("hidden"); _stopChatPoll(); window._chatAanbiedingId = null; } },
    { id: "user-panel",     isOpen: el => !el.classList.contains("hidden"),
      sluit: el => el.classList.add("hidden") },
    { id: "over-panel",     isOpen: el => !el.classList.contains("hidden"),
      sluit: el => el.classList.add("hidden") },
    { id: "over-sub",       isOpen: el => !el.classList.contains("hidden"),
      sluit: el => el.classList.add("hidden") },
    { id: "chat-scherm",    isOpen: el => !el.classList.contains("hidden"),
      sluit: () => sluitChatScherm() },
    { id: "succes-overlay", isOpen: el => el.style.display !== "none",
      sluit: () => sluitSucces() },
    { id: "ob-sheet",       isOpen: el => el.classList.contains("ob-show"),
      sluit: el => { el.classList.remove("ob-show"); document.getElementById("ob-backdrop")?.classList.remove("ob-show"); } },
  ];
  _OVERLAYS.forEach(cfg => {
    const el = document.getElementById(cfg.id);
    if (!el) return;
    new MutationObserver(() => {
      const open = cfg.isOpen(el);
      const geregistreerd = _terugStack.some(o => o.naam === cfg.id);
      if (open && !geregistreerd) _terugOpen(cfg.id, () => cfg.sluit(el));
      else if (!open && geregistreerd) _terugKlaar(cfg.id);
    }).observe(el, { attributes: true, attributeFilter: ["class", "style"] });
  });
});

// ═══ Sprint 3: offline-scanwachtrij ═════════════════════════════════════════
// Scannen zonder verbinding (kelder, vliegtuigstand, storing): de gecomprimeerde
// foto's gaan in IndexedDB en worden automatisch verstuurd zodra het weer kan.
// De banner op de scan-tab toont hoeveel er wachten; tikken = direct proberen.
function _wachtrijDb() {
  return new Promise((ok, fout) => {
    const req = indexedDB.open("cirqo-offline", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("scans", { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => ok(req.result);
    req.onerror  = () => fout(req.error);
  });
}
function _wachtrijTx(schrijf, werk) {
  return _wachtrijDb().then(db => new Promise((ok, fout) => {
    const tx  = db.transaction("scans", schrijf ? "readwrite" : "readonly");
    const req = werk(tx.objectStore("scans"));
    req.onsuccess = () => ok(req.result);
    req.onerror   = () => fout(req.error);
    tx.oncomplete = () => db.close();
  }));
}
async function _wachtrijToon() {
  let n = 0;
  try { n = await _wachtrijTx(false, s => s.count()); } catch (e) {}
  const banner = document.getElementById("wachtrij-banner");
  if (banner) {
    banner.classList.toggle("hidden", n === 0);
    if (n > 0) document.getElementById("wachtrij-tekst").textContent =
      n === 1 ? "1 scan wacht op verbinding — tik om nu te versturen"
              : `${n} scans wachten op verbinding — tik om nu te versturen`;
  }
  return n;
}
let _wachtrijBezig = false;
async function _wachtrijVerwerk() {
  if (_wachtrijBezig) return;
  _wachtrijBezig = true;
  const banner = document.getElementById("wachtrij-banner");
  banner?.classList.add("bezig");
  let verwerkt = 0;
  try {
    const scans = await _wachtrijTx(false, s => s.getAll());
    for (const s of scans) {
      const fd = new FormData();
      (s.fotos || []).forEach((b, i) => fd.append("files", b, `scan-${i}.jpg`));
      if (s.gemeente) fd.append("gemeente_override", s.gemeente);
      const res = await apiFetch("/api/upload", { method: "POST", body: fd, _stil: true });
      if (!res || !res.ok) break;   // nog steeds geen verbinding → volgende poging later
      await _wachtrijTx(true, st => st.delete(s.id));
      verwerkt++;
    }
  } catch (e) {}
  banner?.classList.remove("bezig");
  _wachtrijBezig = false;
  await _wachtrijToon();
  if (verwerkt > 0) {
    (window.uxToast || (() => {}))(
      verwerkt === 1 ? "Bewaarde scan verstuurd en opgeslagen" : `${verwerkt} bewaarde scans verstuurd`, "success");
    (window.uxHaptic || (() => {}))("succes");
    syncItems();
  }
}
window._wachtrijVerwerk = _wachtrijVerwerk;
window.addEventListener("online", () => setTimeout(_wachtrijVerwerk, 1200));
setInterval(() => { _wachtrijToon().then(n => { if (n > 0) _wachtrijVerwerk(); }); }, 45000);
document.addEventListener("DOMContentLoaded", () => { _wachtrijToon().then(n => { if (n > 0) _wachtrijVerwerk(); }); });
