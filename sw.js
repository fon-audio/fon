/* ============================================================
   ФОН — сервис-воркер
   Кешируем ТОЛЬКО интерфейс: сам файл приложения, манифест, иконки.
   Музыку не кешируем и никогда не обещаем, что она работает офлайн:
   это чужие потоки, на них нужен интернет.
   ============================================================ */

const CACHE = 'fon-ui-v4';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .catch(() => { /* нет сети при установке — не страшно, поставимся позже */ })
  );
});

/* Новую версию ставим в строй только по нажатию человека:
   перезагрузка посреди рабочей сессии недопустима. */
self.addEventListener('message', function (event) {
  if (!event.data) return;
  if (event.data.type === 'skipWaiting') { self.skipWaiting(); return; }

  /* Страница спрашивает: изменился ли интерфейс с прошлого раза?
     Сравниваем кеш со свежей копией и отвечаем этой же вкладке. */
  if (event.data.type === 'check-update') {
    event.waitUntil(checkShellUpdate(event.source));
  }
});

function shellUrl() {
  return new URL('./index.html', self.location.href).href;
}

function checkShellUpdate(client) {
  const url = shellUrl();
  return caches.open(CACHE).then(function (cache) {
    return cache.match(url, { ignoreSearch: true }).then(function (cached) {
      if (!cached) return null;
      return fetch(url, { cache: 'reload' }).then(function (fresh) {
        if (!fresh || fresh.status !== 200) return null;
        const copy = fresh.clone();
        return Promise.all([cached.text(), fresh.text()]).then(function (pair) {
          if (pair[0] === pair[1]) return null;
          return cache.put(url, copy).then(function () {
            if (client && client.postMessage) client.postMessage({ type: 'update-available' });
          });
        });
      }).catch(function () { return null; });
    });
  });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/* Интерфейс — это index.html и корень. Иконки и манифест не считаем:
   их смена не требует перезагрузки. */
function isAppShell(url) {
  return url.pathname.endsWith('/index.html') || url.pathname.endsWith('/');
}

function compareAndNotify(cachedResponse, freshResponse) {
  Promise.all([cachedResponse.text(), freshResponse.text()]).then(function (pair) {
    if (pair[0] === pair[1]) return;
    self.clients.matchAll({ type: 'window' }).then(function (clients) {
      for (const client of clients) client.postMessage({ type: 'update-available' });
    });
  }).catch(function () { /* не смогли сравнить — молчим */ });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  /* Чужие домены — мимо кеша. Потоки радио тут не место. */
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    /* ignoreSearch: адрес с «?что-нибудь» — тот же интерфейс. */
    caches.match(request, { ignoreSearch: true }).then(function (cached) {
      const network = fetch(request).then(function (response) {
        /* Обновляем копию интерфейса, когда сеть есть. */
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          /* Оболочку всегда кладём под один адрес без «?что-нибудь»,
             иначе в кеше заводится по копии на каждый запрос. */
          const key = isAppShell(url) ? shellUrl() : request;
          caches.open(CACHE).then(cache => cache.put(key, copy));
          /* Сам файл приложения изменился — говорим об этом вкладкам.
             Решение перезагружаться принимает человек, не мы. */
          if (cached && isAppShell(url)) compareAndNotify(cached.clone(), response.clone());
        }
        return response;
      }).catch(function () {
        return cached || Response.error();
      });
      return cached || network;
    })
  );
});
