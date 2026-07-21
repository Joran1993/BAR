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
