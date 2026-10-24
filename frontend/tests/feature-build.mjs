import {existsSync} from 'node:fs'
import { build as esbuild } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Optional feature UI shares the host's React installation.
export const build = options => esbuild({
  ...options,
  alias: {
    '#tavern': fileURLToPath(new URL('../src/optional/tavern',import.meta.url)),
    '#personal-profile': fileURLToPath(new URL('../src/optional/personal-profile',import.meta.url)),
    '#personal-database': fileURLToPath(new URL('../src/optional/personal-database',import.meta.url)),
    '#gemini-sync': fileURLToPath(new URL('../src/optional/gemini-sync',import.meta.url)),
    '#theme': fileURLToPath(new URL(existsSync(fileURLToPath(new URL('../../features/xiaotangren-theme/xiaotangren_theme/__init__.py', import.meta.url)))
      ? '../../features/xiaotangren-theme/frontend' : '../src/optional/theme', import.meta.url)),
    ...options.alias,
  },
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url)), ...(options.nodePaths || [])],
})
