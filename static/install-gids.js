// CIRQO installatiegids — visueel stappenplan (PWA-installatie + meldingen aanzetten)
// Zelfstandig component: injecteert eigen CSS + DOM en vervangt de oude
// install-fab/-popup op pagina's waar die nog in de HTML staan.
(function () {
  'use strict';

  // Nooit in een iframe (bijv. dashboard als tabblad): de app eromheen regelt dit al
  if (window !== window.top) return;
  // Nooit in de eigen native schil (App/Play Store-app): daar ís het al een app —
  // elke installatie-uitleg is er irrelevant.
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;

  /* ── Native install-prompt opvangen (Android Chrome/Edge/Samsung) ───────── */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    var btn = document.getElementById('ig-direct');
    if (btn) btn.style.display = 'flex';
  });

  /* ── Platformdetectie ────────────────────────────────────────────────────── */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }
  function platform() {
    var ua = navigator.userAgent || '';
    if (isStandalone()) return 'installed';
    var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      if (/CriOS/i.test(ua))  return 'ios-chrome';
      if (/FxiOS/i.test(ua))  return 'ios-anders';
      if (/EdgiOS/i.test(ua)) return 'ios-anders';
      return 'ios-safari';
    }
    if (/android/i.test(ua)) {
      if (/SamsungBrowser/i.test(ua)) return 'android-samsung';
      if (/EdgA/i.test(ua))           return 'android-edge';
      if (/Firefox/i.test(ua))        return 'android-firefox';
      if (/Chrome/i.test(ua))         return 'android-chrome';
      return 'android-anders';
    }
    if (/Edg/i.test(ua))     return 'desktop-edge';
    if (/Firefox/i.test(ua)) return 'desktop-firefox';
    if (/Chrome/i.test(ua))  return 'desktop-chrome';
    return 'desktop-anders';
  }
  function isMobiel(p) { return p.indexOf('ios') === 0 || p.indexOf('android') === 0; }

  /* ── In-app-browserdetectie (WhatsApp/Outlook e.d.) ──────────────────────
     In zo'n ingebouwd browsertje kan een app NIET geïnstalleerd worden —
     zonder waarschuwing volgen mensen de stappen en gebeurt er niets. */
  function inAppBrowser() {
    // De eigen native schil (App/Play Store-app) is géén in-app-browser:
    // daar is installeren niet aan de orde en hoort geen enkele gids te tonen.
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return null;
    var ua = navigator.userAgent || '';
    if (/FBAN|FBAV|FB_IAB/i.test(ua))            return 'Facebook';
    if (/Instagram/i.test(ua))                    return 'Instagram';
    if (/WhatsApp/i.test(ua))                     return 'WhatsApp';
    if (/LinkedInApp/i.test(ua))                  return 'LinkedIn';
    if (/Outlook-(iOS|Android)|OutlookMobile/i.test(ua)) return 'Outlook';
    if (/TeamsMobile|Teams\//i.test(ua))          return 'Teams';
    if (/GSA\//i.test(ua))                        return 'de Google-app';
    if (/android/i.test(ua) && /; wv\)/.test(ua)) return 'een andere app';
    var isIOS = /iphone|ipad|ipod/i.test(ua);
    if (isIOS && !/Safari|CriOS|FxiOS|EdgiOS/i.test(ua)) return 'een andere app';
    return null;
  }

  /* ── Iconen (inline SVG, kleur via currentColor) ─────────────────────────── */
  function svg(inhoud, maat) {
    return "<svg width='" + (maat || 24) + "' height='" + (maat || 24) + "' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" + inhoud + "</svg>";
  }
  var IC = {
    deel:      svg("<path d='M12 3v12'/><path d='M8 7l4-4 4 4'/><path d='M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1'/>"),
    puntjesV:  svg("<circle cx='12' cy='5' r='1.6' fill='currentColor' stroke='none'/><circle cx='12' cy='12' r='1.6' fill='currentColor' stroke='none'/><circle cx='12' cy='19' r='1.6' fill='currentColor' stroke='none'/>"),
    puntjesH:  svg("<circle cx='5' cy='12' r='1.6' fill='currentColor' stroke='none'/><circle cx='12' cy='12' r='1.6' fill='currentColor' stroke='none'/><circle cx='19' cy='12' r='1.6' fill='currentColor' stroke='none'/>"),
    streepjes: svg("<line x1='4' y1='7' x2='20' y2='7'/><line x1='4' y1='12' x2='20' y2='12'/><line x1='4' y1='17' x2='20' y2='17'/>"),
    plusVak:   svg("<rect x='3' y='3' width='18' height='18' rx='4'/><line x1='12' y1='8' x2='12' y2='16'/><line x1='8' y1='12' x2='16' y2='12'/>"),
    telPlus:   svg("<rect x='6' y='2' width='12' height='20' rx='2.5'/><line x1='12' y1='9' x2='12' y2='15'/><line x1='9' y1='12' x2='15' y2='12'/>"),
    safari:    svg("<circle cx='12' cy='12' r='9'/><path d='M14.5 9.5l-1.8 4.2-4.2 1.8 1.8-4.2z'/>"),
    vink:      svg("<path d='M20 6L9 17l-5-5'/>"),
    bel:       svg("<path d='M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'/><path d='M13.7 21a2 2 0 0 1-3.4 0'/>"),
    download:  svg("<path d='M12 3v12'/><path d='M7 10l5 5 5-5'/><path d='M5 21h14'/>")
  };

  /* ── Stappen per platform ────────────────────────────────────────────────── */
  var GIDS = {
    'ios-safari': { titel: 'iPhone / iPad · Safari', stappen: [
      [IC.deel,     "Tik op het <b>deel-icoon</b> — het vierkantje met het pijltje omhoog, <b>onderaan in het midden</b> van je scherm (op iPad: rechtsboven)."],
      [IC.streepjes, "Er schuift een lijstje omhoog. <b>Scroll omlaag</b> in dat lijstje. Zie je onderaan <b>&lsquo;Toon meer&rsquo;</b> staan? Tik daar dan eerst op."],
      [IC.plusVak,  "Tik op <b>&lsquo;Zet op beginscherm&rsquo;</b> — het vakje met het plusje ernaast."],
      [IC.vink,     "Tik rechtsboven op <b>&lsquo;Voeg toe&rsquo;</b>. Klaar — het CIRQO-logo staat nu op je beginscherm!"]
    ]},
    'ios-chrome': { titel: 'iPhone / iPad · Chrome', stappen: [
      [IC.deel,     "Tik op het <b>deel-icoon</b> (vierkantje met pijltje omhoog), rechts naast de adresbalk."],
      [IC.streepjes, "Scroll omlaag in het lijstje dat verschijnt. Staat er <b>&lsquo;Toon meer&rsquo;</b>? Tik daar dan eerst op."],
      [IC.plusVak,  "Tik op <b>&lsquo;Zet op beginscherm&rsquo;</b>."],
      [IC.vink,     "Tik op <b>&lsquo;Voeg toe&rsquo;</b>. Klaar!"]
    ], tip: "Lukt het niet? Open <b>app.cirqo.nl</b> in <b>Safari</b> en volg de stappen daar." },
    'ios-anders': { titel: 'iPhone / iPad', intro: "In deze browser werkt installeren niet goed. Via <b>Safari</b> duurt het 30 seconden:", stappen: [
      [IC.safari,  "Open <b>Safari</b> en ga naar <b>app.cirqo.nl</b>."],
      [IC.deel,    "Tik op het <b>deel-icoon</b> (vierkantje met pijltje omhoog) onderaan het scherm."],
      [IC.plusVak, "Scroll omlaag (tik zo nodig eerst op <b>&lsquo;Toon meer&rsquo;</b>), kies <b>&lsquo;Zet op beginscherm&rsquo;</b> en tik op <b>&lsquo;Voeg toe&rsquo;</b>."]
    ]},
    'android-chrome': { titel: 'Android · Chrome', stappen: [
      [IC.puntjesV, "Tik <b>rechtsboven</b> op de drie puntjes <b>&#8942;</b>."],
      [IC.telPlus,  "Kies <b>&lsquo;App installeren&rsquo;</b> (of &lsquo;Toevoegen aan startscherm&rsquo;)."],
      [IC.vink,     "Tik op <b>&lsquo;Installeren&rsquo;</b>. Klaar — het CIRQO-logo staat op je startscherm!"]
    ]},
    'android-samsung': { titel: 'Android · Samsung Internet', stappen: [
      [IC.streepjes, "Tik <b>rechtsonder</b> op de drie streepjes <b>&#9776;</b> (menu)."],
      [IC.telPlus,   "Kies <b>&lsquo;Pagina toevoegen aan&rsquo;</b> en dan <b>&lsquo;Startscherm&rsquo;</b>."],
      [IC.vink,      "Bevestig met <b>&lsquo;Toevoegen&rsquo;</b>. Klaar!"]
    ], tip: "Zie je in de adresbalk een <b>download-icoon (&#8595;)</b>? Daarmee kan het ook in &eacute;&eacute;n tik." },
    'android-firefox': { titel: 'Android · Firefox', stappen: [
      [IC.puntjesV, "Tik <b>rechtsboven</b> op de drie puntjes <b>&#8942;</b>."],
      [IC.telPlus,  "Kies <b>&lsquo;Toevoegen aan startscherm&rsquo;</b>."],
      [IC.vink,     "Bevestig met <b>&lsquo;Toevoegen&rsquo;</b>. Klaar!"]
    ]},
    'android-edge': { titel: 'Android · Edge', stappen: [
      [IC.puntjesH, "Tik <b>onderaan in het midden</b> op de drie puntjes <b>&#8943;</b>."],
      [IC.telPlus,  "Kies <b>&lsquo;Toevoegen aan telefoon&rsquo;</b>."],
      [IC.vink,     "Bevestig. Klaar!"]
    ]},
    'android-anders': { titel: 'Android', stappen: [
      [IC.puntjesV, "Open het <b>menu</b> van je browser (meestal &#8942; of &#9776;)."],
      [IC.telPlus,  "Kies <b>&lsquo;App installeren&rsquo;</b> of <b>&lsquo;Toevoegen aan startscherm&rsquo;</b>."],
      [IC.vink,     "Bevestig. Klaar!"]
    ]},
    'desktop-chrome': { titel: 'Computer · Chrome', stappen: [
      [IC.download, "Klik rechts in de <b>adresbalk</b> op het <b>installatie-icoon</b> (schermpje met pijltje)."],
      [IC.vink,     "Klik op <b>&lsquo;Installeren&rsquo;</b>. Of via menu &#8942; &rarr; &lsquo;App installeren&rsquo;."]
    ]},
    'desktop-edge': { titel: 'Computer · Edge', stappen: [
      [IC.puntjesH, "Klik rechtsboven op <b>&#8943;</b> &rarr; <b>Apps</b>."],
      [IC.vink,     "Kies <b>&lsquo;Deze site als app installeren&rsquo;</b> en klik op <b>&lsquo;Installeren&rsquo;</b>."]
    ]},
    'desktop-firefox': { titel: 'Computer · Firefox', intro: "Firefox kan web-apps helaas niet installeren. Gebruik <b>Chrome</b> of <b>Edge</b>, of open CIRQO op je telefoon.", stappen: [] },
    'desktop-anders': { titel: 'App installeren', intro: "Open deze site in <b>Chrome</b> of <b>Edge</b> (computer/Android) of <b>Safari</b> (iPhone/iPad) en kies <b>&lsquo;App installeren&rsquo;</b> of <b>&lsquo;Zet op beginscherm&rsquo;</b>.", stappen: [] }
  };

  /* ── CSS ─────────────────────────────────────────────────────────────────── */
  var css = document.createElement('style');
  css.textContent =
    "#ig-fab{position:fixed;right:16px;bottom:16px;z-index:9990;width:58px;height:58px;border-radius:50%;border:none;cursor:pointer;" +
      "background:var(--orange,#e67026);color:#fff;display:none;align-items:center;justify-content:center;" +
      "box-shadow:0 6px 20px rgba(230,112,38,.45);transition:transform .15s;}" +
    "#ig-fab:active{transform:scale(.92);}" +
    "#ig-fab::after{content:'';position:absolute;inset:-5px;border-radius:50%;border:2px solid var(--orange,#e67026);opacity:0;animation:igPuls 2.6s ease-out infinite;}" +
    "@keyframes igPuls{0%{transform:scale(.9);opacity:.55}70%{transform:scale(1.25);opacity:0}100%{opacity:0}}" +
    "#ig-overlay{position:fixed;inset:0;z-index:9991;background:rgba(20,15,8,.55);display:none;align-items:flex-end;justify-content:center;" +
      "backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}" +
    "#ig-overlay.open{display:flex;}" +
    "@media(min-width:600px){#ig-overlay{align-items:center;}}" +
    "#ig-kaart{background:#fff;width:100%;max-width:430px;max-height:88vh;overflow-y:auto;border-radius:22px 22px 0 0;padding:22px 20px 26px;" +
      "position:relative;animation:igOp .3s ease;font-family:'Inter',system-ui,sans-serif;color:#1a1a1a;}" +
    "@media(min-width:600px){#ig-kaart{border-radius:22px;margin:16px;}}" +
    "@keyframes igOp{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}" +
    "#ig-sluit{position:absolute;top:12px;right:12px;width:34px;height:34px;border:none;border-radius:50%;background:#f4efe8;color:#8a8178;" +
      "font-size:1.05rem;line-height:1;cursor:pointer;}" +
    ".ig-kop{display:flex;align-items:center;gap:12px;margin-bottom:4px;}" +
    ".ig-kop img{width:44px;height:44px;border-radius:11px;}" +
    ".ig-kop h2{font-size:1.18rem;font-weight:800;margin:0;font-family:'Outfit','Inter',sans-serif;}" +
    ".ig-kop p{margin:2px 0 0;font-size:.78rem;color:#8a8178;}" +
    ".ig-browser{display:inline-block;margin:12px 0 2px;font-size:.72rem;font-weight:700;color:#b4531a;background:#fbe8da;padding:4px 12px;border-radius:100px;}" +
    ".ig-intro{font-size:.85rem;line-height:1.5;margin:10px 0 0;}" +
    ".ig-stap{display:flex;align-items:center;gap:13px;margin-top:13px;background:#faf6f0;border:1px solid #f0e8dd;border-radius:14px;padding:12px 13px;}" +
    ".ig-stap-nr{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--orange,#e67026);color:#fff;font-size:.82rem;font-weight:800;" +
      "display:flex;align-items:center;justify-content:center;}" +
    ".ig-stap-ic{flex-shrink:0;width:44px;height:44px;border-radius:11px;background:#fff;border:1px solid #eee3d5;color:var(--orange,#e67026);" +
      "display:flex;align-items:center;justify-content:center;}" +
    ".ig-stap-tekst{font-size:.84rem;line-height:1.45;}" +
    ".ig-tip{margin-top:12px;font-size:.76rem;color:#8a8178;line-height:1.45;background:#fdf9f3;border-radius:10px;padding:9px 12px;}" +
    ".ig-knop{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;margin-top:15px;padding:14px;border:none;border-radius:100px;" +
      "background:var(--orange,#e67026);color:#fff;font-size:.95rem;font-weight:800;cursor:pointer;font-family:inherit;}" +
    ".ig-knop:disabled{opacity:.6;}" +
    ".ig-later{display:block;width:100%;margin-top:8px;padding:10px;border:none;background:none;color:#b4aca2;font-size:.8rem;cursor:pointer;font-family:inherit;}" +
    ".ig-status{margin-top:10px;font-size:.8rem;text-align:center;color:#8a8178;min-height:1.2em;}" +
    ".ig-succes{display:flex;align-items:center;gap:12px;margin-top:14px;background:#e9f3ec;border:1px solid #cfe5d6;border-radius:14px;padding:13px 14px;" +
      "font-size:.86rem;line-height:1.45;color:#2c5e40;}";
  document.head.appendChild(css);

  /* ── DOM ─────────────────────────────────────────────────────────────────── */
  var overlay = document.createElement('div');
  overlay.id = 'ig-overlay';
  overlay.innerHTML = "<div id='ig-kaart'><button id='ig-sluit' aria-label='Sluiten'>&#10005;</button><div id='ig-inhoud'></div></div>";
  var fab = document.createElement('button');
  fab.id = 'ig-fab';
  fab.setAttribute('aria-label', 'App installeren');
  fab.innerHTML = IC.download;
  // Inline-modus (/installeren): gids permanent op de pagina, geen fab/overlay
  var inlineDoel = document.getElementById('ig-inline');
  function plaats() {
    // Inline-modus rendert pas in reedsGeinstalleerd() — dan zijn LOGO e.d. al
    // gedefinieerd (deze functie draait vóór de rest van het script)
    if (inlineDoel) return;
    document.body.appendChild(overlay);
    document.body.appendChild(fab);
    // Op pagina's met een onderbalk: bolletje erbóven hangen i.p.v. eroverheen
    if (document.querySelector('.tabbar')) fab.style.bottom = '86px';
  }
  if (document.body) plaats(); else document.addEventListener('DOMContentLoaded', plaats);

  overlay.addEventListener('click', function (e) { if (e.target === overlay) sluit(); });
  overlay.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'ig-sluit') sluit();
    if (e.target && e.target.classList && e.target.classList.contains('ig-later')) sluit();
  });
  fab.addEventListener('click', function () {
    if (fabModus === 'push') { open('push'); } else { open('install'); }
  });

  /* ── Weergave ────────────────────────────────────────────────────────────── */
  var fabModus = 'install';   // 'install' | 'push'
  var LOGO = "<img src='/static/icon-cirqo-192.png' alt=''>";

  function kop(titel, sub) {
    return "<div class='ig-kop'>" + LOGO + "<div><h2>" + titel + "</h2><p>" + sub + "</p></div></div>";
  }

  function bouwInstall() {
    var p = platform();
    // In een ingebouwd browsertje (WhatsApp/Outlook/…): eerst dáár uit — anders
    // volgen mensen de stappen en gebeurt er niets
    var inApp = inAppBrowser();
    if (inApp) {
      var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      var hi = kop('Bijna! E&eacute;n stap eerst', 'Je opent CIRQO nu binnen ' + inApp + '.');
      hi += "<div class='ig-intro' style='background:#fbe8da;border:1px solid #f2cfae;border-radius:12px;padding:11px 13px;'>" +
            "In het ingebouwde browsertje van <b>" + inApp + "</b> kan de app <b>niet ge&iuml;nstalleerd</b> worden. Open CIRQO eerst in je echte browser:</div>";
      if (ios) {
        hi += "<div class='ig-stap'><span class='ig-stap-nr'>1</span><span class='ig-stap-ic'>" + IC.deel + "</span><span class='ig-stap-tekst'>Tik op het <b>deel-icoon</b> of op <b>&#8943;</b> en kies <b>&lsquo;Open in Safari&rsquo;</b> (of &lsquo;Open in browser&rsquo;).</span></div>";
        hi += "<div class='ig-stap'><span class='ig-stap-nr'>2</span><span class='ig-stap-ic'>" + IC.telPlus + "</span><span class='ig-stap-tekst'>Volg daarna de installatiestappen die je daar vanzelf ziet.</span></div>";
      } else {
        hi += "<div class='ig-stap'><span class='ig-stap-nr'>1</span><span class='ig-stap-ic'>" + IC.puntjesV + "</span><span class='ig-stap-tekst'>Tik rechtsboven op <b>&#8942;</b> en kies <b>&lsquo;Openen in Chrome&rsquo;</b> (of &lsquo;Open in browser&rsquo;).</span></div>";
        hi += "<div class='ig-stap'><span class='ig-stap-nr'>2</span><span class='ig-stap-ic'>" + IC.telPlus + "</span><span class='ig-stap-tekst'>Volg daarna de installatiestappen die je daar vanzelf ziet.</span></div>";
      }
      hi += "<button class='ig-later'>Misschien later</button>";
      return hi;
    }
    var g = GIDS[p] || GIDS['desktop-anders'];
    var h = kop('Zet CIRQO op je telefoon', 'Opent als echte app — snel, groot icoon, met meldingen.');
    h += "<span class='ig-browser'>" + g.titel + "</span>";
    if (g.intro) h += "<p class='ig-intro'>" + g.intro + "</p>";
    g.stappen.forEach(function (s, i) {
      h += "<div class='ig-stap'><span class='ig-stap-nr'>" + (i + 1) + "</span>" +
           "<span class='ig-stap-ic'>" + s[0] + "</span><span class='ig-stap-tekst'>" + s[1] + "</span></div>";
    });
    if (g.tip) h += "<div class='ig-tip'>&#128161; " + g.tip + "</div>";
    // Direct installeren (als de browser het aanbiedt) — nog makkelijker dan de stappen
    h += "<button class='ig-knop' id='ig-direct' style='display:" + (deferred ? 'flex' : 'none') + "'>" + IC.download + " Installeer direct (1 tik)</button>";
    h += "<button class='ig-later'>Misschien later</button>";
    return h;
  }

  function bouwPush(naInstall) {
    var token = localStorage.getItem('token');
    var h = naInstall
      ? kop('Gelukt! &#127881;', 'CIRQO staat op je toestel.') +
        "<div class='ig-succes'>" + IC.vink + " De app is ge&iuml;nstalleerd. Open hem voortaan via het CIRQO-icoon op je beginscherm."
      : kop('Nog &eacute;&eacute;n ding&hellip;', 'Mis nooit een aanbieding of match.');
    if (naInstall) h += "</div>";
    h += "<div class='ig-stap'><span class='ig-stap-ic'>" + IC.bel + "</span><span class='ig-stap-tekst'>" +
         "<b>Zet meldingen aan</b> — dan hoor je het direct wanneer er iets voor je klaarstaat.</span></div>";
    if (token) {
      h += "<button class='ig-knop' id='ig-push-aan'>" + IC.bel + " Meldingen aanzetten</button><div class='ig-status' id='ig-push-status'></div>";
    } else {
      h += "<div class='ig-tip'>Log eerst in — daarna kun je meldingen aanzetten via het ronde knopje rechtsonder.</div>";
    }
    h += "<button class='ig-later'>Misschien later</button>";
    return h;
  }

  function open(modus, naInstall) {
    var inhoud = document.getElementById('ig-inhoud');
    if (!inhoud) return;
    inhoud.innerHTML = (modus === 'push') ? bouwPush(naInstall) : bouwInstall();
    overlay.classList.add('open');
    var direct = document.getElementById('ig-direct');
    if (direct) direct.addEventListener('click', installNu);
    var pushBtn = document.getElementById('ig-push-aan');
    if (pushBtn) pushBtn.addEventListener('click', zetPushAan);
  }
  function sluit() {
    overlay.classList.remove('open');
    try { localStorage.setItem('ig_snooze', String(Date.now())); } catch (e) {}
  }

  function installNu() {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; });
  }

  /* ── Meldingen aanzetten (zelfde flow als /check) ────────────────────────── */
  function b64NaarU8(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function zetPushAan() {
    var btn = document.getElementById('ig-push-aan');
    var st = document.getElementById('ig-push-status');
    var token = localStorage.getItem('token');
    if (!token) { if (st) st.textContent = 'Log eerst in.'; return; }
    if (btn) btn.disabled = true;
    if (st) st.textContent = 'Bezig…';
    (async function () {
      try {
        if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('Meldingen worden op dit toestel niet ondersteund.');
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('Geen toestemming — zet meldingen aan via de instellingen van je browser.');
        await navigator.serviceWorker.register('/sw.js').catch(function () {});
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (!sub) {
          var r = await fetch('/api/push/vapid-key');
          var pk = (await r.json()).public_key;
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64NaarU8(pk) });
        }
        var res = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ subscription: sub })
        });
        if (!res.ok) throw new Error('Opslaan mislukt (' + res.status + ') — probeer het later opnieuw.');
        if (st) { st.textContent = '✓ Meldingen staan aan!'; st.style.color = '#2c5e40'; }
        if (btn) btn.style.display = 'none';
        fab.style.display = 'none';
        try { localStorage.setItem('ig_push_ok', '1'); } catch (e) {}
      } catch (e) {
        if (st) st.textContent = e.message || 'Er ging iets mis.';
        if (btn) btn.disabled = false;
      }
    })();
  }

  /* ── Oude install-UI opruimen + oude functies laten doorverwijzen ────────── */
  ['install-fab', 'install-pop', 'install-panel'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
  window.toonInstallInstructie = function () { open('install'); };
  window.openInstallPopup = function () { open('install'); };
  window.closeInstallPopup = sluit;
  window.installNu = installNu;

  /* ── Geïnstalleerd? (ook als de site in de browser wordt bekeken) ────────── */
  function reedsGeinstalleerd(cb) {
    if (platform() === 'installed') { cb(true); return; }
    if (navigator.getInstalledRelatedApps) {
      navigator.getInstalledRelatedApps().then(function (apps) {
        cb(!!(apps && apps.some(function (a) { return a.platform === 'webapp'; })));
      }).catch(function () { cb(false); });
    } else { cb(false); }
  }

  /* ── Na installatie: succes + meldingen-suggestie ────────────────────────── */
  window.addEventListener('appinstalled', function () {
    if (inlineDoel) {
      inlineDoel.innerHTML = bouwPush(true);
      var pb = document.getElementById('ig-push-aan');
      if (pb) pb.addEventListener('click', zetPushAan);
      return;
    }
    fabModus = 'push';
    fab.innerHTML = IC.bel;
    open('push', true);
  });

  /* ── Startgedrag ─────────────────────────────────────────────────────────── */
  function snoozed() {
    try {
      var t = +(localStorage.getItem('ig_snooze') || 0);
      return t && (Date.now() - t) < 24 * 60 * 60 * 1000;   // 1× per 24 uur
    } catch (e) { return false; }
  }
  function pushNodig() {
    return ('Notification' in window) && Notification.permission === 'default' &&
           !!localStorage.getItem('token') && !localStorage.getItem('ig_push_ok');
  }

  reedsGeinstalleerd(function (installed) {
    if (inlineDoel) {
      // /installeren-pagina: de gids permanent op de pagina
      if (installed) {
        inlineDoel.innerHTML =
          kop('Al gelukt! &#127881;', 'CIRQO staat al op dit toestel.') +
          "<div class='ig-succes'>" + IC.vink + " Open de app via het CIRQO-icoon op je beginscherm.</div>";
      } else {
        inlineDoel.innerHTML = bouwInstall();
        var d = document.getElementById('ig-direct');
        if (d) d.addEventListener('click', installNu);
        var later = inlineDoel.querySelector('.ig-later');
        if (later) later.style.display = 'none';
      }
      return;
    }
    var p = platform();
    if (installed) {
      // App staat er al → alleen nog meldingen-suggestie (belletje) indien nodig
      if (pushNodig()) {
        fabModus = 'push';
        fab.innerHTML = IC.bel;
        fab.style.display = 'flex';
        if (isStandalone() && !snoozed()) open('push');
      }
      return;
    }
    // Nog niet geïnstalleerd → bolletje altijd tonen; popup vanzelf op mobiel
    fab.style.display = 'flex';
    if (isMobiel(p) && !snoozed()) open('install');
  });
})();
