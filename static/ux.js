/* ── UX micro-interactions ───────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── Toast ──────────────────────────────────────────────────────────────── */
  window.uxToast = function (msg, type, duration) {
    type = type || 'default';
    duration = duration || 3000;
    // Remove existing toasts
    document.querySelectorAll('.ux-toast').forEach(function (t) { t.remove(); });
    var el = document.createElement('div');
    el.className = 'ux-toast ' + type;
    if (type === 'success') el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    if (type === 'error')   el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    if (type === 'info')    el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    el.appendChild(document.createTextNode(msg));
    document.body.appendChild(el);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 250);
    }, duration);
  };

  /* ── Bevestigingskaart in appstijl (vervangt het systeem-confirm) ───────── */
  window.uxBevestig = function (titel, tekst, bevestigLabel) {
    return new Promise(function (res) {
      var wrap = document.createElement('div');
      wrap.className = 'ux-bevestig';
      wrap.innerHTML =
        '<div class="ux-bevestig-kaart" role="dialog" aria-modal="true">' +
          '<div class="ux-bevestig-titel"></div>' +
          '<p class="ux-bevestig-tekst"></p>' +
          '<div class="ux-bevestig-knoppen">' +
            '<button type="button" class="ux-b-annuleer">Annuleren</button>' +
            '<button type="button" class="ux-b-bevestig"></button>' +
          '</div>' +
        '</div>';
      wrap.querySelector('.ux-bevestig-titel').textContent = titel || 'Weet je het zeker?';
      var t = wrap.querySelector('.ux-bevestig-tekst');
      if (tekst) t.textContent = tekst; else t.remove();
      wrap.querySelector('.ux-b-bevestig').textContent = bevestigLabel || 'Verwijderen';
      document.body.appendChild(wrap);
      function klaar(v) {
        wrap.classList.add('weg');
        setTimeout(function () { wrap.remove(); }, 200);
        res(v);
      }
      wrap.querySelector('.ux-b-annuleer').onclick = function () { klaar(false); };
      wrap.querySelector('.ux-b-bevestig').onclick = function () { klaar(true); };
      wrap.addEventListener('click', function (e) { if (e.target === wrap) klaar(false); });
    });
  };

  /* ── Button spinner helper ───────────────────────────────────────────────── */
  window.uxBtnLoading = function (btn, loading) {
    if (loading) {
      btn._origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + (btn.dataset.loadingText || 'Bezig…');
    } else {
      btn.disabled = false;
      btn.innerHTML = btn._origText || btn.innerHTML;
    }
  };

  /* ── Haptiek ─────────────────────────────────────────────────────────────── */
  // Capacitor Haptics als de schil die meelevert (volgende store-build); tot die
  // tijd navigator.vibrate (Android). Op iOS-web bestaat geen trilling-API — stil.
  window.uxHaptic = function (soort) {
    try {
      var H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (H) {
        if (soort === 'succes') H.notification({ type: 'SUCCESS' });
        else H.impact({ style: soort === 'stevig' ? 'MEDIUM' : 'LIGHT' });
        return;
      }
      if (navigator.vibrate) navigator.vibrate(soort === 'succes' ? [12, 40, 12] : 8);
    } catch (e) {}
  };

  /* ── Pull-to-refresh ─────────────────────────────────────────────────────── */
  // Web-implementatie (geen plugin nodig): trek de lijst >90px omlaag vanaf de
  // bovenkant en laat los. Eén gedeelde indicator; werkt per scroll-container.
  var _ptrInd = null;
  function _ptrIndicator() {
    if (_ptrInd) return _ptrInd;
    _ptrInd = document.createElement('div');
    _ptrInd.className = 'ptr-indicator';
    _ptrInd.innerHTML = '<span class="ptr-spinner"></span>';
    document.body.appendChild(_ptrInd);
    return _ptrInd;
  }
  window.uxPullRefresh = function (el, onRefresh) {
    if (!el) return;
    var startY = null, over = false, bezig = false;
    function scrollBoven() {
      var top = (el === document.body || el === document.documentElement)
        ? (document.scrollingElement || document.documentElement).scrollTop
        : el.scrollTop;
      return top <= 0;
    }
    el.addEventListener('touchstart', function (e) {
      startY = (!bezig && scrollBoven()) ? e.touches[0].clientY : null;
      over = false;
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      if (startY === null || bezig) return;
      if (!scrollBoven()) { startY = null; _ptrIndicator().classList.remove('zichtbaar'); return; }
      var d = e.touches[0].clientY - startY;
      var ind = _ptrIndicator();
      if (d > 28) {
        var wasOver = over;
        over = d > 90;
        ind.classList.add('zichtbaar');
        ind.classList.toggle('klaar', over);
        ind.querySelector('.ptr-spinner').style.transform = 'rotate(' + Math.min(d * 2, 360) + 'deg)';
        if (over && !wasOver) window.uxHaptic('licht');
      } else {
        over = false;
        ind.classList.remove('zichtbaar', 'klaar');
      }
    }, { passive: true });
    el.addEventListener('touchend', function () {
      if (startY === null || bezig) { startY = null; return; }
      startY = null;
      var ind = _ptrIndicator();
      if (!over) { ind.classList.remove('zichtbaar', 'klaar'); return; }
      over = false;
      bezig = true;
      ind.classList.add('draait');
      Promise.resolve().then(onRefresh).catch(function () {}).then(function () {
        setTimeout(function () {
          ind.classList.remove('zichtbaar', 'klaar', 'draait');
          bezig = false;
        }, 350);
      });
    });
  };

  document.addEventListener('DOMContentLoaded', function () {

    /* ── Header scroll shadow ──────────────────────────────────────────────── */
    var hdr = document.querySelector('.hdr');
    if (hdr) {
      function checkScroll() {
        var scrolled = false;
        document.querySelectorAll('.tab.active').forEach(function (t) {
          if (t.scrollTop > 2) scrolled = true;
        });
        if (window.scrollY > 2) scrolled = true;
        hdr.classList.toggle('scrolled', scrolled);
      }
      window.addEventListener('scroll', checkScroll, { passive: true });
      document.querySelectorAll('.tab').forEach(function (t) {
        t.addEventListener('scroll', checkScroll, { passive: true });
      });
    }

    /* ── Tabbar icon bounce ──────────────────────────────────────────────── */
    document.querySelectorAll('.tabbar-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.classList.remove('tapped');
        void btn.offsetWidth; // force reflow
        btn.classList.add('tapped');
        setTimeout(function () { btn.classList.remove('tapped'); }, 300);
      });
    });

    /* ── Liquid glass pil onder de actieve tab ───────────────────────────── */
    (function () {
      var bar = document.querySelector('.tabbar');
      if (!bar || bar.querySelector('.tabbar-pil')) return;
      var pil = document.createElement('div');
      pil.className = 'tabbar-pil';
      bar.prepend(pil);
      var huidigX = null;
      var rustig = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Waar staat de pil NU echt? Bij een onderbroken beweging is dat niet het
      // vorige doel; uitlezen voorkomt een sprong (die als 'dubbel' oogt).
      function echteX(terugval) {
        try {
          var t = getComputedStyle(pil).transform;
          if (t && t !== 'none' && window.DOMMatrixReadOnly) {
            return new DOMMatrixReadOnly(t).m41;
          }
        } catch (e) {}
        return terugval;
      }
      function stopLopende() {
        try {
          (pil.getAnimations ? pil.getAnimations() : []).forEach(function (a) { a.cancel(); });
        } catch (e) {}
      }

      function zet(animeer) {
        var act = bar.querySelector('.tabbar-btn.active');
        if (!act) { pil.style.opacity = '0'; return; }
        pil.style.opacity = '1';
        // Breedte/hoogte via layout (verandert alleen bij resize); beweging via transform
        pil.style.width = (act.offsetWidth - 14) + 'px';
        var doel = act.offsetLeft + 7;

        // Liquid glass: het glas rekt uit in de looprichting en 'zet zich' bij
        // aankomst met een korte samendrukking. Alleen transform → volledig op
        // de GPU, dus geen invloed op de laadsnelheid van de tabs zelf.
        var kanVloeien = animeer && !rustig && huidigX !== null && huidigX !== doel
                         && typeof pil.animate === 'function';
        if (kanVloeien) {
          var vanaf = echteX(huidigX);        // vloeiend verder vanaf de echte positie
          stopLopende();                      // nooit twee bewegingen tegelijk
          pil.classList.remove('reist');
          var afstand = Math.abs(doel - vanaf);
          var rek = Math.min(1 + afstand / 900, 1.16);   // subtiel: nooit over de buurtab heen
          var midden = vanaf + (doel - vanaf) * 0.5;
          pil.style.transition = 'none';
          void pil.offsetWidth;               // glans-animatie opnieuw laten starten
          pil.classList.add('reist');
          var beweging = pil.animate([
            { transform: 'translateX(' + vanaf + 'px) scaleX(1)' },
            { transform: 'translateX(' + midden + 'px) scaleX(' + rek + ')', offset: 0.45 },
            { transform: 'translateX(' + doel + 'px) scaleX(0.97)', offset: 0.8 },
            { transform: 'translateX(' + doel + 'px) scaleX(1)' }
          ], { duration: 460, easing: 'cubic-bezier(.33,.9,.28,1)', fill: 'forwards' });
          beweging.onfinish = function () {
            pil.style.transform = 'translateX(' + doel + 'px)';   // eindstand vastleggen
            stopLopende();
            pil.style.transition = '';
            pil.classList.remove('reist');
          };
        } else {
          stopLopende();
          if (!animeer) pil.style.transition = 'none';
          pil.style.transform = 'translateX(' + doel + 'px)';
          if (!animeer) requestAnimationFrame(function () { pil.style.transition = ''; });
        }
        huidigX = doel;
      }
      zet(false);                                            // startpositie zonder animatie
      bar.addEventListener('click', function () {            // ná de tab-handlers (bubbling)
        requestAnimationFrame(function () { zet(true); });
      });
      window.addEventListener('resize', function () { zet(false); });
    })();

    /* ── List item stagger ───────────────────────────────────────────────── */
    function staggerItems(root) {
      var rows = root.querySelectorAll('.item-row:not([data-staggered])');
      rows.forEach(function (row, i) {
        row.setAttribute('data-staggered', '1');
        row.style.setProperty('--stagger', Math.min(i * 38, 220) + 'ms');
      });
    }
    // Initial stagger
    document.querySelectorAll('.tab').forEach(staggerItems);
    // Stagger newly added items
    var obs = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.addedNodes.length) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              if (n.classList && n.classList.contains('item-row')) {
                var idx = n.parentElement
                  ? Array.from(n.parentElement.querySelectorAll('.item-row')).indexOf(n)
                  : 0;
                n.setAttribute('data-staggered', '1');
                n.style.setProperty('--stagger', Math.min(idx * 38, 220) + 'ms');
              }
              staggerItems(n);
            }
          });
        }
      });
    });
    document.querySelectorAll('.tab, #items-list, #reacties-list').forEach(function (t) {
      obs.observe(t, { childList: true, subtree: true });
    });

    /* ── Intercept error-bar om toasts te tonen ──────────────────────────── */
    var errBars = document.querySelectorAll('.error-bar');
    errBars.forEach(function (bar) {
      var origDisplay = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'display');
      var observer = new MutationObserver(function () {
        if (bar.style.display === 'block' && bar.textContent.trim()) {
          uxToast(bar.textContent.trim(), 'error', 4000);
        }
      });
      observer.observe(bar, { attributes: true, attributeFilter: ['style'], childList: true });
    });

    /* ── Analyse-knop — spinner tijdens laden ────────────────────────────── */
    var analyseBtn = document.getElementById('analyse-btn');
    if (analyseBtn) {
      var origAnalyseClick = analyseBtn.onclick;
      analyseBtn.addEventListener('click', function () {
        if (!analyseBtn.disabled) {
          setTimeout(function () {
            if (analyseBtn.disabled) {
              var txt = document.getElementById('analyse-txt');
              if (txt) txt.innerHTML = '<span class="spinner"></span> Analyseren…';
            }
          }, 50);
        }
      }, true);
    }

    /* ── Login form — spinner op submit ─────────────────────────────────── */
    var loginForm = document.getElementById('form');
    if (loginForm) {
      loginForm.addEventListener('submit', function () {
        var btn = loginForm.querySelector('button[type=submit]');
        if (btn && !btn.disabled) {
          setTimeout(function () {
            if (btn.disabled) btn.innerHTML = '<span class="spinner"></span> Inloggen…';
          }, 30);
        }
      });
    }

  });
})();

// ── Account-sync ──────────────────────────────────────────────────────────────
// Wijzigt beheer iemands rol of gemeente-scope, dan werkt de app zichzelf bij
// zonder dat opnieuw inloggen nodig is (de database is de bron van waarheid).
(function () {
  const token = localStorage.getItem("token");
  if (!token) return;
  fetch("/api/auth/me", { headers: { "Authorization": "Bearer " + token } })
    .then(r => (r.ok ? r.json() : null))
    .then(me => {
      if (!me) return;
      const anders = (me.gemeente || "") !== (localStorage.getItem("gemeente") || "") ||
                     (me.role || "") !== (localStorage.getItem("role") || "");
      if (!anders) { sessionStorage.removeItem("accSync"); return; }
      if (sessionStorage.getItem("accSync")) return;   // bescherming tegen reload-lus
      sessionStorage.setItem("accSync", "1");
      localStorage.setItem("gemeente", me.gemeente || "");
      localStorage.setItem("role", me.role || "");
      if (me.organisatie) localStorage.setItem("organisatie", me.organisatie);
      location.reload();
    })
    .catch(() => {});
})();
