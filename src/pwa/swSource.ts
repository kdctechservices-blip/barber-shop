/**
 * Génération du service worker hors-ligne (P0-7).
 *
 * Le service worker est un fichier **statique** servi à la racine (`/sw.js`) :
 * il ne peut pas importer de module de l'application. Sa source est donc
 * produite ici, au moment du build, à partir de la liste réelle des fichiers
 * générés (`dist/`) et d'une version dérivée de leur contenu.
 *
 * Stratégies appliquées :
 *  - navigation : réseau d'abord, repli sur la coquille applicative en cache ;
 *  - ressources statiques : cache d'abord (noms hachés = immuables) ;
 *  - `/api/*`, requêtes non-GET et origines tierces : **jamais** interceptées
 *    ni mises en cache (les données métier vivent dans IndexedDB).
 */

export interface PrecacheEntry {
  url: string
  size: number
}

/** Fichiers jamais précachés : le SW lui-même, les sources maps, les médias lourds. */
export function selectPrecacheEntries(
  files: Array<{ path: string; size: number }>,
): PrecacheEntry[] {
  return files
    .filter((file) => {
      const path = file.path.startsWith('/') ? file.path : `/${file.path}`
      if (path === '/sw.js') return false
      if (path.endsWith('.map')) return false
      if (path.endsWith('.br') || path.endsWith('.gz')) return false
      return true
    })
    .map((file) => ({
      url: file.path.startsWith('/') ? file.path : `/${file.path}`,
      size: file.size,
    }))
    .sort((a, b) => a.url.localeCompare(b.url))
}

/** Empreinte stable (FNV-1a 32 bits) : sert de nom de cache. */
export function computeCacheVersion(entries: PrecacheEntry[]): string {
  let hash = 0x811c9dc5
  const input = entries
    .map((entry) => `${entry.url}:${entry.size}`)
    .join('|')
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `salon-pro-${hash.toString(36)}`
}

const SHELL_URL = '/index.html'
const API_PREFIX = '/api/'

/**
 * Construit la source JavaScript du service worker.
 * Le code est volontairement autonome, sans dépendance ni transpilation.
 */
export function buildServiceWorkerSource(entries: PrecacheEntry[]): string {
  const version = computeCacheVersion(entries)
  const precache = JSON.stringify(entries.map((entry) => entry.url), null, 0)

  return `/* SALON PRO — service worker hors-ligne (généré automatiquement) */
/* Ne pas éditer : voir src/pwa/swSource.ts */
'use strict'

const CACHE_NAME = ${JSON.stringify(version)}
const PRECACHE_URLS = ${precache}
const SHELL_URL = ${JSON.stringify(SHELL_URL)}
const API_PREFIX = ${JSON.stringify(API_PREFIX)}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // Précache tolérant : un fichier manquant ne bloque pas l'installation.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const request = new Request(url, { cache: 'reload' })
            const response = await fetch(request)
            if (response && response.ok) {
              await cache.put(url, response)
            }
          } catch {
            /* ignoré : l'application fonctionnera en mode dégradé */
          }
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

function isBypassed(request, url) {
  if (request.method !== 'GET') return true
  if (url.origin !== self.location.origin) return true
  if (url.pathname.startsWith(API_PREFIX)) return true
  return false
}

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      await cache.put(SHELL_URL, response.clone())
    }
    return response
  } catch {
    const cached = await cache.match(SHELL_URL)
    return cached || Response.error()
  }
}

async function handleStatic(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    return Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (isBypassed(request, url)) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }
  event.respondWith(handleStatic(request))
})
`
}
