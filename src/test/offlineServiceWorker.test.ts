import { describe, expect, it, vi } from 'vitest'
import {
  buildServiceWorkerSource,
  computeCacheVersion,
  selectPrecacheEntries,
  type PrecacheEntry,
} from '../pwa/swSource'
import { registerOfflineServiceWorker } from '../pwa/registerServiceWorker'

/**
 * Service worker hors-ligne (P0-7).
 *
 * Ces tests exécutent la **vraie** source générée dans un bac à sable minimal
 * (self, caches, fetch, Request, Response) : les stratégies de cache testées
 * sont exactement celles qui seront servies en production.
 */

const ORIGIN = 'https://salonpro.app'

interface Sandbox {
  listeners: Record<string, (event: unknown) => void>
  cache: Map<string, string>
  deletedCaches: string[]
  skipped: boolean
  claimed: boolean
  networkCalls: string[]
}

class FakeRequest {
  url: string
  method: string
  mode: string
  constructor(
    input: string,
    init?: { cache?: string; method?: string; mode?: string },
  ) {
    this.url = new URL(input, ORIGIN).toString()
    this.method = init?.method ?? 'GET'
    this.mode = init?.mode ?? 'no-cors'
  }
}

function createSandbox(options?: {
  offline?: boolean
  seed?: Record<string, string>
}): Sandbox & {
  run: () => void
  dispatch: (
    type: string,
    request?: { url: string; method?: string; mode?: string },
  ) => { responded?: Promise<Response>; waits: Promise<unknown>[] }
  stored: Map<string, string>
} {
  const sandbox: Sandbox = {
    listeners: {},
    cache: new Map(Object.entries(options?.seed ?? {})),
    deletedCaches: [],
    skipped: false,
    claimed: false,
    networkCalls: [],
  }

  const keyOf = (request: unknown): string =>
    typeof request === 'string' ? request : (request as { url: string }).url

  const cacheInstance = {
    put: async (request: unknown, response: Response) => {
      sandbox.cache.set(keyOf(request), await response.text())
    },
    match: async (request: unknown) => {
      const body = sandbox.cache.get(keyOf(request))
      return body === undefined ? undefined : new Response(body, { status: 200 })
    },
  }

  const cachesMock = {
    open: async () => cacheInstance,
    keys: async () => ['salon-pro-ancien', 'salon-pro-actuel'],
    delete: async (name: string) => {
      sandbox.deletedCaches.push(name)
      return true
    },
  }

  const fetchMock = async (input: unknown): Promise<Response> => {
    const url = keyOf(input)
    sandbox.networkCalls.push(url)
    if (options?.offline) throw new Error('offline')
    return new Response(`network:${url}`, { status: 200 })
  }

  const selfMock = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      sandbox.listeners[type] = handler
    },
    skipWaiting: async () => {
      sandbox.skipped = true
    },
    clients: {
      claim: async () => {
        sandbox.claimed = true
      },
    },
  }

  const run = (): void => {
    const source = buildServiceWorkerSource([
      { url: '/index.html', size: 1200 },
      { url: '/assets/app.js', size: 5000 },
      { url: '/manifest.webmanifest', size: 400 },
    ])
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', source)(
      selfMock,
      cachesMock,
      fetchMock,
      FakeRequest,
      Response,
      URL,
    )
  }

  const dispatch = (
    type: string,
    request?: { url: string; method?: string; mode?: string },
  ) => {
    let responded: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    sandbox.listeners[type]?.({
      request: request
        ? new FakeRequest(request.url, {
            method: request.method,
            mode: request.mode,
          })
        : undefined,
      data: { type: 'SKIP_WAITING' },
      respondWith: (promise: Promise<Response>) => {
        responded = promise
      },
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise)
      },
    })
    return { responded, waits }
  }

  return Object.assign(sandbox, { run, dispatch, stored: sandbox.cache })
}

describe('Service worker hors-ligne — précache', () => {
  it('sélectionne les fichiers précachables et exclut le SW et les maps', () => {
    const entries = selectPrecacheEntries([
      { path: 'index.html', size: 10 },
      { path: '/assets/app.js', size: 20 },
      { path: 'sw.js', size: 30 },
      { path: '/assets/app.js.map', size: 40 },
      { path: '/assets/app.js.gz', size: 50 },
    ])
    expect(entries.map((e) => e.url)).toEqual([
      '/assets/app.js',
      '/index.html',
    ])
  })

  it('dérive une version stable et sensible au contenu', () => {
    const base: PrecacheEntry[] = [
      { url: '/index.html', size: 100 },
      { url: '/assets/app.js', size: 200 },
    ]
    expect(computeCacheVersion(base)).toBe(computeCacheVersion([...base]))
    expect(
      computeCacheVersion([{ url: '/index.html', size: 101 }, base[1]]),
    ).not.toBe(computeCacheVersion(base))
  })

  it('installe tous les fichiers et nettoie les anciens caches', async () => {
    const sandbox = createSandbox()
    sandbox.run()

    const { waits } = sandbox.dispatch('install')
    await Promise.all(waits)
    expect([...sandbox.stored.keys()].sort()).toEqual([
      '/assets/app.js',
      '/index.html',
      '/manifest.webmanifest',
    ])
    expect(sandbox.skipped).toBe(true)

    const activation = sandbox.dispatch('activate')
    await Promise.all(activation.waits)
    expect(sandbox.deletedCaches).toHaveLength(2)
    expect(sandbox.claimed).toBe(true)
  })
})

describe('Service worker hors-ligne — stratégies de récupération', () => {
  it('sert la coquille en cache quand la navigation échoue (hors-ligne)', async () => {
    const sandbox = createSandbox({
      offline: true,
      seed: { '/index.html': 'coquille-hors-ligne' },
    })
    sandbox.run()

    const { responded } = sandbox.dispatch('fetch', {
      url: `${ORIGIN}/dashboard`,
      mode: 'navigate',
    })
    const response = await responded
    expect(await response?.text()).toBe('coquille-hors-ligne')
  })

  it('met à jour la coquille après une navigation réussie', async () => {
    const sandbox = createSandbox({ seed: { '/index.html': 'ancienne' } })
    sandbox.run()

    const { responded } = sandbox.dispatch('fetch', {
      url: `${ORIGIN}/dashboard`,
      mode: 'navigate',
    })
    const response = await responded
    expect(await response?.text()).toContain('network:')
    expect(sandbox.stored.get('/index.html')).toContain('network:')
  })

  it("sert les ressources statiques depuis le cache sans réseau", async () => {
    const sandbox = createSandbox({ seed: { [`${ORIGIN}/assets/app.js`]: 'cached' } })
    sandbox.run()

    const { responded } = sandbox.dispatch('fetch', {
      url: `${ORIGIN}/assets/app.js`,
    })
    const response = await responded
    expect(await response?.text()).toBe('cached')
    expect(sandbox.networkCalls).toHaveLength(0)
  })

  it('met en cache une ressource statique récupérée pour la première fois', async () => {
    const sandbox = createSandbox()
    sandbox.run()

    const { responded } = sandbox.dispatch('fetch', {
      url: `${ORIGIN}/assets/new.js`,
    })
    await responded
    expect(sandbox.stored.get(`${ORIGIN}/assets/new.js`)).toContain('network:')
  })

  it("n'intercepte jamais l'API ni les requêtes non-GET (données métier hors cache)", async () => {
    const sandbox = createSandbox()
    sandbox.run()

    const apiCall = sandbox.dispatch('fetch', { url: `${ORIGIN}/api/sync` })
    expect(apiCall.responded).toBeUndefined()

    const post = sandbox.dispatch('fetch', {
      url: `${ORIGIN}/api/auth/logout`,
      method: 'POST',
    })
    expect(post.responded).toBeUndefined()

    const thirdParty = sandbox.dispatch('fetch', {
      url: 'https://exemple.tiers/script.js',
    })
    expect(thirdParty.responded).toBeUndefined()
    expect(sandbox.stored.size).toBe(0)
  })

  it('active la nouvelle version sur demande (SKIP_WAITING)', () => {
    const sandbox = createSandbox()
    sandbox.run()
    sandbox.dispatch('message')
    expect(sandbox.skipped).toBe(true)
  })
})

describe('Enregistrement du service worker', () => {
  it("ne s'enregistre pas en développement (aucune interférence avec le HMR)", () => {
    expect(registerOfflineServiceWorker()).toBe(false)
  })

  it('ne casse pas les environnements sans serviceWorker', () => {
    const original = navigator.serviceWorker
    // jsdom n'implémente pas les service workers : l'appel doit être un no-op.
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(registerOfflineServiceWorker()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    Object.defineProperty(navigator, 'serviceWorker', {
      value: original,
      configurable: true,
    })
  })
})
