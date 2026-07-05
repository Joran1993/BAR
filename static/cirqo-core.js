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
    localStorage.clear();
    location.href = (window._BP || "") + "/login";
  }
  window.logout = window.logout || _defaultLogout;

  // Eén robuuste apiFetch: stuurt de Bearer-token mee, vangt netwerkfouten
  // (geeft dan null i.p.v. te gooien → knoppen blijven nooit hangen), en logt
  // uit bij 401. Aanroepers checken `if (!res || !res.ok)`.
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
})();
