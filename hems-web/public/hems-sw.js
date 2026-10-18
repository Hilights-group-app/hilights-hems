/* Cache the public fallback plus the normal HEMS shell for routes opened online. */
const VERSION = 'v5';
const SHELL = `hems-offline-shell-${VERSION}`;
const ROUTES = `hems-app-routes-${VERSION}`;
const STATIC = `hems-app-static-${VERSION}`;
const IMAGES = `hems-app-images-${VERSION}`;
const FLIGHT = `hems-app-flight-${VERSION}`;
const LAST_ROUTE = '/__hems_last_saved_route__';
const ASSETS = ['/offline.html', '/offline-store.js', '/offline-app.js', '/offline.css', '/logo-icon.png'];
let offlineHint = false;

function routeKey(value) {
  const url = new URL(value, self.location.origin);
  url.hash = '';
  url.searchParams.delete('offlineSync');
  return new Request(url.href, { method: 'GET' });
}

function isAppRoute(url) {
  return url.origin === self.location.origin &&
    !url.pathname.startsWith('/api/') &&
    !url.pathname.startsWith('/_next/') &&
    !url.pathname.startsWith('/offline') &&
    !url.pathname.includes('.') &&
    url.pathname !== '/login';
}

function isFlightRequest(request, url) {
  return url.origin === self.location.origin &&
    (url.searchParams.has('_rsc') || request.headers?.get('rsc') === '1');
}

function flightSignature(value) {
  const url = new URL(value, self.location.origin);
  url.searchParams.delete('_rsc');
  return `${url.pathname}${url.search}`;
}

async function savedFlight(cache, request, url) {
  const exact = await cache.match(request);
  if (exact) return exact;
  const signature = flightSignature(url);
  const keys = await cache.keys();
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    if (flightSignature(keys[index].url) === signature) {
      const saved = await cache.match(keys[index]);
      if (saved) return saved;
    }
  }
  return new Response('', { status: 503, headers: { 'Content-Type': 'text/x-component' } });
}

async function rememberRoute(value, suppliedResponse) {
  const url = new URL(value, self.location.origin);
  if (!isAppRoute(url)) return false;
  try {
    const response = suppliedResponse || await fetch(new Request(url.href, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'text/html', 'x-hems-offline-route': '1' },
    }));
    const finalUrl = new URL(response.url || url.href, self.location.origin);
    const html = response.headers.get('content-type')?.includes('text/html');
    if (!response.ok || response.redirected || !html || finalUrl.pathname === '/login') return false;
    const cache = await caches.open(ROUTES);
    await cache.put(routeKey(url), response.clone());
    await cache.put(LAST_ROUTE, new Response(`${url.pathname}${url.search}`, {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    }));
    await rememberStaticAssets(response.clone());
    return true;
  } catch {
    return false;
  }
}

async function rememberStaticAssets(response) {
  try {
    const html = await response.text();
    const urls = new Set();
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const asset = new URL(match[1], self.location.origin);
      if (asset.origin === self.location.origin && asset.pathname.startsWith('/_next/static/')) urls.add(asset.href);
    }
    const cache = await caches.open(STATIC);
    await Promise.all([...urls].map(async href => {
      if (await cache.match(href)) return;
      const asset = await fetch(href);
      if (asset.ok) await cache.put(href, asset);
    }));
  } catch {
    // Route caching still succeeds if a lazy bundle cannot be prepared yet.
  }
}

async function trim(cacheName, maximum) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - maximum)).map(key => cache.delete(key)));
}

async function savedNavigation(url) {
  const cache = await caches.open(ROUTES);
  const exact = await cache.match(routeKey(url));
  if (exact) return exact;
  const marker = await cache.match(LAST_ROUTE);
  const lastPath = marker ? await marker.text() : '';
  if (lastPath) {
    const last = await cache.match(routeKey(lastPath));
    if (last) return Response.redirect(new URL(lastPath, self.location.origin).href, 302);
  }
  const fallback = await caches.match('/offline.html');
  return fallback || new Response('Open HEMS online once to prepare offline access.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

self.addEventListener('install', event => {
  event.waitUntil(Promise.all([
    caches.open(SHELL).then(cache => cache.addAll(ASSETS)),
    self.skipWaiting(),
  ]));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key =>
      (key.startsWith('hems-offline-shell-') && key !== SHELL) ||
      (key.startsWith('hems-app-routes-') && key !== ROUTES) ||
      (key.startsWith('hems-app-static-') && key !== STATIC) ||
      (key.startsWith('hems-app-images-') && key !== IMAGES) ||
      (key.startsWith('hems-app-flight-') && key !== FLIGHT)
    ).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'hems:connection-state') {
    offlineHint = event.data.offline === true;
  }
  if (event.data?.type === 'hems:cache-route' && typeof event.data.url === 'string') {
    event.waitUntil(rememberRoute(event.data.url));
  }
  if (event.data?.type === 'hems:clear-app-cache') {
    event.waitUntil(Promise.all([caches.delete(ROUTES), caches.delete(IMAGES), caches.delete(FLIGHT)]));
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;

  if (url.origin === self.location.origin && ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(SHELL).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.open(STATIC).then(async cache => {
      const saved = await cache.match(request);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }));
    return;
  }

  if (isFlightRequest(request, url)) {
    event.respondWith(caches.open(FLIGHT).then(async cache => {
      if (self.navigator?.onLine === false) return savedFlight(cache, request, url);
      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
          await trim(FLIGHT, 100);
        }
        return response;
      } catch {
        return savedFlight(cache, request, url);
      }
    }));
    return;
  }

  const publicSupabaseImage = url.hostname.endsWith('.supabase.co') && url.pathname.includes('/storage/v1/object/public/');
  if (request.destination === 'image' && (url.origin === self.location.origin || publicSupabaseImage)) {
    event.respondWith(caches.open(IMAGES).then(async cache => {
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          await cache.put(request, response.clone());
          await trim(IMAGES, 100);
        }
        return response;
      } catch {
        return (await cache.match(request)) || new Response('', { status: 504 });
      }
    }));
    return;
  }

  if (request.mode === 'navigate' && isAppRoute(url)) {
    event.respondWith((async () => {
      // localhost remains reachable with Wi-Fi off. Avoid asking its middleware,
      // which cannot verify Supabase auth while the database is unreachable.
      if (self.navigator?.onLine === false) return savedNavigation(url);
      try {
        const response = await fetch(request);
        const finalUrl = new URL(response.url || url.href, self.location.origin);
        if (response.redirected && finalUrl.pathname === '/login' && self.navigator?.onLine === false) {
          return savedNavigation(url);
        }
        if (response.ok) await rememberRoute(url, response.clone());
        return response;
      } catch {
        return savedNavigation(url);
      }
    })());
  }
});
