import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  buildServiceWorkerSource,
  selectPrecacheEntries,
} from '../src/pwa/swSource.ts'

/**
 * Génère `dist/sw.js` après le build : liste des fichiers réellement produits
 * + version dérivée de leurs tailles. Le service worker n'est **pas** généré en
 * développement (aucune interférence avec HMR).
 */
export function salonOfflinePlugin(): {
  name: string
  apply: 'build'
  configResolved: (config: { build: { outDir: string } }) => void
  closeBundle: () => Promise<void>
} {
  let outDir = 'dist'

  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(directory, entry.name)
        if (entry.isDirectory()) return walk(fullPath)
        return [fullPath]
      }),
    )
    return files.flat()
  }

  return {
    name: 'salon-offline-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    async closeBundle() {
      const outDirAbsolute = resolve(process.cwd(), outDir)
      const absoluteFiles = await walk(outDirAbsolute)
      const fileEntries = await Promise.all(
        absoluteFiles.map(async (absolutePath) => {
          const info = await stat(absolutePath)
          const path = `/${relative(outDirAbsolute, absolutePath).split(sep).join('/')}`
          return { path, size: info.size }
        }),
      )

      const precache = selectPrecacheEntries(fileEntries)
      const source = buildServiceWorkerSource(precache)
      await writeFile(join(outDirAbsolute, 'sw.js'), source, 'utf8')
      console.info(
        `[pwa] sw.js généré — ${precache.length} fichiers précachés, ` +
          `${Math.round(precache.reduce((total, entry) => total + entry.size, 0) / 1024)} Ko`,
      )
    },
  }
}
