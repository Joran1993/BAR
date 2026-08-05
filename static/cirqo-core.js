/* CIRQO gedeelde kern — één bron voor apiFetch, escaping en uitloggen.
   Laadt als eerste op elke pagina (vóór scan.js/app.js/beheer.js/…), zodat er
   geen vier uiteenlopende kopieën meer bestaan. Alles hangt aan window. */
(function () {
  "use strict";

  // Basispad (subpad-installaties): leidt /login correct af
  const _BP = (location.pathname.match(/^(\/[^/]+)?\/(app|index)/) || [""])[1] || "";
  window._BP = window._BP || _BP;

  // Standaard-afhandeling bij een verlopen/ongeldige sessie. Pagina's met een
  // eigen uitlog-routine (bv. bedrijf.html) kunnen window.onAuthFail overschrijven.
  function _defaultLogout() {
    // Bewuste/definitieve uitlog: ook de herstel-cookie serverzijde vernietigen
    try { fetch((window._BP || "") + "/api/auth/logout", { method: "POST", credentials: "include", keepalive: true }); } catch (e) {}
    localStorage.clear();
    location.href = (window._BP || "") + "/login";
  }
  window.logout = window.logout || _defaultLogout;

  // Stil sessieherstel: haal met de httpOnly herstel-cookie een verse sessie
  // op. Gebruikt bij een 401 én bij opstarten zonder token — zo hoeft niemand
  // opnieuw in te loggen als de lokale opslag ooit gewist raakt.
  window.sessieHerstel = async function () {
    try {
      const r = await fetch((window._BP || "") + "/api/auth/herstel",
                            { method: "POST", credentials: "include", cache: "no-store" });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.token) return false;
      localStorage.setItem("token", d.token);
      localStorage.setItem("user_id", d.user_id || "");
      localStorage.setItem("username", d.username || "");
      localStorage.setItem("role", d.role || "user");
      localStorage.setItem("gemeente", d.gemeente || "");
      localStorage.setItem("organisatie", d.organisatie || "");
      localStorage.setItem("auth_type", d.auth_type || "local");
      if (d.bedrijf_id) localStorage.setItem("bedrijf_id", d.bedrijf_id);
      return true;
    } catch (e) { return false; }
  };

  // Eén robuuste apiFetch: stuurt de Bearer-token mee, vangt netwerkfouten
  // (geeft dan null i.p.v. te gooien → knoppen blijven nooit hangen). Bij een
  // 401 eerst stil sessieherstel proberen; pas als dat niet lukt uitloggen.
  window.apiFetch = async function (url, opts = {}) {
    const token = localStorage.getItem("token") || "";
    let res;
    try {
      res = await fetch(url, {
        cache: "no-store",
        ...opts,
        headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      });
    } catch (e) {
      if (!opts._stil) (window.uxToast || (() => {}))("Geen verbinding — probeer het zo opnieuw", "error");
      return null;
    }
    if (res.status === 401) {
      if (!opts._herstelPoging && await window.sessieHerstel()) {
        return window.apiFetch(url, { ...opts, _herstelPoging: true });
      }
      (window.onAuthFail || window.logout || _defaultLogout)();
      return null;
    }
    return res;
  };

  // ── Logo's van netwerkpartijen ────────────────────────────────────────────
  // Eén bron voor zowel de aanbiedlijst (scan) als de netwerkvisualisatie
  // (dashboard). Volgorde: eigen bestand op domein → eigen bestand op naam →
  // favicon via het e-maildomein → niets (aanroeper toont dan initialen).
  window.CIRQO_LOGO_DOMEIN = {
    'kringloopgorinchem.nl': '/static/logos/kringloopgorinchem.png',
    'degezel.nl':            '/static/logos/degezel.png',
    'behoudenvaart.net':     '/static/logos/behoudenvaart.jpg',
    'opnieuwenco.nl':        '/static/logos/opnieuwenco.png',
    'aafje.nl':              '/static/logos/aafje.png',
    'buva.nl':               '/static/logos/buva.png',
    'den-otter.nl':          '/static/logos/denotter.png',
    'gkbgroep.nl':           '/static/logos/gkbgroep.png',
    'humanitas-dmh.nl':      '/static/logos/humanitasdmh.png',
    'ingka.ikea.com':        '/static/logos/ikea.png',
    'makro.nl':              '/static/logos/makro.png',
    'opwaarts.nu':           '/static/logos/opwaarts.jpg',
    'oxin-growers.nl':       '/static/logos/oxingrowers.png'
  };
  // Op naam (kleine letters). Nodig voor partijen zonder e-mailadres, én overal
  // waar we alleen de naam kennen — zoals de avatar van het eigen account, die
  // het e-maildomein niet bij de hand heeft.
  window.CIRQO_LOGO_NAAM = {
    'kringloop gorinchem':             '/static/logos/kringloopgorinchem.png',
    'de gezel':                        '/static/logos/degezel.png',
    'opnieuw & co':                    '/static/logos/opnieuwenco.png',
    'aafje':                           '/static/logos/aafje.png',
    'buva':                            '/static/logos/buva.png',
    'den otter':                       '/static/logos/denotter.png',
    'gkb groep':                       '/static/logos/gkbgroep.png',
    'humanitas dmh':                   '/static/logos/humanitasdmh.png',
    'ikea':                            '/static/logos/ikea.png',
    'makro':                           '/static/logos/makro.png',
    'opwaarts':                        '/static/logos/opwaarts.jpg',
    'oxin growers':                    '/static/logos/oxingrowers.png',
    'behouden vaart':                  '/static/logos/behoudenvaart.jpg',
    '2ekans bouwmaterialen':           '/static/logos/2ekans.png',
    'bouw mensen (vakschool)':         '/static/logos/bouwmensen.png',
    'calvijn middelbare school':       '/static/logos/calvijn.png',
    'de driemaster':                   '/static/logos/driemaster.png',
    'dorcas':                          '/static/logos/dorcas.png',
    'kringloop giessenlanden arkel':   '/static/logos/kringloopgiessenlanden.png',
    'kringloop graafstroom goudriaan': '/static/logos/kringloopgoudriaan.png',
    'stichting vluchtelingenwerk':     '/static/logos/vluchtelingenwerk.png'
  };
  window.cirqoLogo = function (b) {
    if (!b) return "";
    var naam = String(b.naam || "").toLowerCase().trim();
    var email = String(b.email || "").trim().toLowerCase();
    var domein = String(b.domain || (email.indexOf("@") >= 0 ? email.split("@").pop() : "")).toLowerCase();
    return window.CIRQO_LOGO_DOMEIN[domein] || window.CIRQO_LOGO_NAAM[naam] ||
      (domein ? "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(domein) + "&sz=64" : "");
  };
  // Initialen als er geen logo is — zo oogt een lijst nooit half gevuld
  window.cirqoInitialen = function (naam) {
    return (String(naam || "").split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w[0]; }).join("").toUpperCase()) || "?";
  };

  // HTML-escape voor tekst die via innerHTML in de DOM komt (chat, itemnamen…)
  window._esc = window._esc || function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  // Escape voor waarden die binnen een onclick="..."-attribuut belanden:
  // eerst JS-string-veilig, dan HTML-attribuut-veilig.
  window.escJs = window.escJs || function (s) {
    return window._esc(String(s == null ? "" : s)
      .replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]/g, " "));
  };

  // Eén plek om de eigen user-id uit de token te halen (met try/catch —
  // een corrupte token mag nooit een pagina laten crashen).
  window.currentUserId = function () {
    try {
      const t = localStorage.getItem("token");
      return t ? JSON.parse(atob(t.split(".")[1])).sub : null;
    } catch (e) { return null; }
  };
})();
