const CACHE_NAME = "treino-app-v2";

// Arquivos principais: sempre busca a versão mais nova da rede primeiro (só
// cai pro cache se estiver offline). Assim, depois de publicar uma
// atualização, o app instalado no iPhone já pega a versão nova na primeira
// abertura, em vez de precisar abrir duas vezes.
const NETWORK_FIRST_FILES = ["/", "/index.html", "/app.js", "/foods.js", "/manifest.json"];

// Ícones não mudam entre atualizações, então continuam cache-primeiro
// (evita refazer o download deles toda vez que há internet).
const CACHE_FIRST_FILES = ["./icons/icon-192.png", "./icons/icon-512.png"];

const ASSETS = ["./", "./index.html", "./app.js", "./foods.js", "./manifest.json", ...CACHE_FIRST_FILES];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isNetworkFirst(request) {
  const path = new URL(request.url).pathname;
  return NETWORK_FIRST_FILES.some((f) => path === f || path.endsWith(f));
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (isNetworkFirst(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      });
    })
  );
});
