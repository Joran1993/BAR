// Nieuwe service worker direct activeren (zodat de pushsubscriptionchange-handler snel live is)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// Fetch-handler: nodig zodat Chrome de site als installeerbare PWA ziet, én
// cache-first voor foto's (Firebase/Supabase Storage) — herhaald laden is dan instant.
const FOTO_CACHE = "cirqo-fotos-v1";
const FOTO_MAX = 600;   // maximaal aantal gecachete foto's (oudste eruit)

self.addEventListener("fetch", event => {
  const url = event.request.url;
  const isFoto = event.request.method === "GET" &&
    (url.startsWith("https://firebasestorage.googleapis.com/") ||
     (url.includes(".supabase.co/storage/") ));
  if (!isFoto) return;   // al het andere: gewoon netwerk
  event.respondWith((async () => {
    const cache = await caches.open(FOTO_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res.ok || res.type === "opaque") {
      cache.put(event.request, res.clone());
      // Cache begrensd houden (best-effort, niet blokkerend)
      cache.keys().then(keys => {
        if (keys.length > FOTO_MAX) keys.slice(0, keys.length - FOTO_MAX).forEach(k => cache.delete(k));
      });
    }
    return res;
  })());
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data.json(); } catch {}
  const title = data.title || "CIRQO";
  const body  = data.body  || "Nieuw aanbod ontvangen.";
  const url   = data.url   || "/";
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body,
      icon: "/static/icon-cirqo-192.png",
      badge: "/static/icon-cirqo-192.png",
      data: { url },
    });
    // Open app-vensters direct laten verversen (anders wacht de lijst op de poll)
    const vensters = await clients.matchAll({ type: "window", includeUncontrolled: true });
    vensters.forEach(v => v.postMessage({ type: "push" }));
    // Badge op het app-icoon ophogen (beginscherm-bolletje). De app zet hem
    // bij openen weer op het werkelijke aantal (kv 'badge' in IndexedDB).
    try {
      const huidig = (await _idbGet("badge")) || 0;
      const nieuw = Number(huidig) + 1;
      await _idbPut("badge", nieuw);
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(nieuw);
    } catch (e) { /* best-effort */ }
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const vensters = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (vensters.length) {
      vensters[0].focus();
      vensters[0].postMessage({ type: "push" });
      return;
    }
    await clients.openWindow(url);
  })());
});

// ── Automatische vernieuwing van de push-subscription ──────────────────────────
// De browser/het pushplatform kan een subscription vervangen (rotatie/verloop).
// Dan vuurt dit event op de achtergrond — ook als de app dicht is. We melden de
// nieuwe subscription opnieuw aan op de server, met het bewaarde account-token.
function _idbGet(key) {
  return new Promise(res => {
    try {
      const o = indexedDB.open("cirqo-push", 1);
      o.onupgradeneeded = () => o.result.createObjectStore("kv");
      o.onsuccess = () => {
        const tx = o.result.transaction("kv", "readonly");
        const r = tx.objectStore("kv").get(key);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      };
      o.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}

function _idbPut(key, val) {
  return new Promise(res => {
    try {
      const o = indexedDB.open("cirqo-push", 1);
      o.onupgradeneeded = () => o.result.createObjectStore("kv");
      o.onsuccess = () => {
        const tx = o.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      };
      o.onerror = () => res();
    } catch (e) { res(); }
  });
}

function _urlB64ToUint8(base64) {
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    try {
      const token = await _idbGet("token");
      if (!token) return;
      const keyData = await (await fetch("/api/push/vapid-key")).json();
      if (!keyData || !keyData.public_key) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlB64ToUint8(keyData.public_key),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (e) { /* best-effort — hier is geen toegang tot de UI/login */ }
  })());
});
