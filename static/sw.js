// Nieuwe service worker direct activeren (zodat de pushsubscriptionchange-handler snel live is)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data.json(); } catch {}
  const title = data.title || "CIRQO";
  const body  = data.body  || "Nieuw aanbod ontvangen.";
  const url   = data.url   || "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/static/icon-192.png",
      badge: "/static/icon-192.png",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
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
