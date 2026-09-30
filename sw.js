// Service Worker لمنصة غيابك
// - الصفحات والملفات: من النت الأول (عشان التحديثات توصل)، ولو مفيش نت من النسخة المحفوظة
// - طلبات Supabase: من النت دايمًا ومش بتتحفظ
const CACHE = "ghiyabak-v5";
const SHELL = [
  "./index.html", "./teacher.html", "./style.css", "./config.js", "./app.js", "./teacher.js", "./pwa.js",
  "./manifest.webmanifest", "./manifest-teacher.webmanifest",
  "./icons/logo-240.jpg", "./icons/icon-96.png", "./icons/icon-128.png", "./icons/icon-192.png", "./icons/favicon-32.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;

  const cacheable = url.origin === location.origin ||
    ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname);
  if (!cacheable) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
