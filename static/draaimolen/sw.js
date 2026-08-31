/* Draaimolen 26 — service worker: offline op het terrein (het bos heeft geen
   bereik) en de pushmeldingen voor je eigen sets. */

const CACHE = "draaimolen-26-v2";

const SCHIL = [
  "/draaimolen/",
  "/static/draaimolen/app.css?v=2",
  "/static/draaimolen/app.js?v=2",
  "/static/draaimolen/timetable.json",
  "/static/draaimolen/icon-192.png",
  "/static/draaimolen/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SCHIL.map((url) => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const namen = await caches.keys();
    await Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Timetable: liefst vers, anders de laatst bekende versie
  if (url.pathname === "/draaimolen/api/timetable") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/draaimolen/api/")) return;   // rest altijd live

  // Pagina zelf
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put("/draaimolen/", res.clone());
        return res;
      } catch {
        return (await caches.match("/draaimolen/")) || Response.error();
      }
    })());
    return;
  }

  const eigen = url.origin === self.location.origin;
  const lettertype = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!eigen && !lettertype) return;

  // Bestanden: uit de cache, en op de achtergrond verversen
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const vers = fetch(req).then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await vers) || Response.error();
  })());
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data.json(); } catch { /* leeg bericht */ }
  const titel = data.title || "Draaimolen";
  event.waitUntil(self.registration.showNotification(titel, {
    body: data.body || "Je set begint zo.",
    icon: "/static/draaimolen/icon-192.png",
    badge: "/static/draaimolen/icon-192.png",
    tag: data.tag || titel,
    vibrate: [80, 40, 80],
    data: { url: data.url || "/draaimolen/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const doel = (event.notification.data && event.notification.data.url) || "/draaimolen/";
  event.waitUntil((async () => {
    const vensters = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const v of vensters) {
      if (v.url.includes("/draaimolen")) return v.focus();
    }
    return clients.openWindow(doel);
  })());
});
