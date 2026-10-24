// Generate build-only aliases for the selected plugin collection. Never rewrite
// the tracked tsconfig or require node_modules links inside plugin repositories.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'

const here = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const configured = process.env.SHIONARIUM_PLUGINS_DIR
if (configured && !path.isAbsolute(configured)) throw new Error('SHIONARIUM_PLUGINS_DIR must be an absolute directory')
const plugins = configured ? path.resolve(configured) : path.resolve(here, '../features')
let state = {}
try { state = JSON.parse(fs.readFileSync(path.resolve(here, '../backend/data/plugin-state.json'), 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
const enabled = id => state[id]?.disabled !== true
const panel = (folder, id, kind) => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(plugins, folder, 'plugin.json'), 'utf8'))
    return manifest.id === id && manifest.kind === kind && manifest.host_api === 1
  } catch { return false }
}
const choices = [
  ['theme', 'xiaotangren-theme', enabled('xiaotangren_theme') && fs.existsSync(path.join(plugins, 'xiaotangren-theme/xiaotangren_theme/__init__.py'))],
  ['tavern', 'tavern', enabled('tavern') && fs.existsSync(path.join(plugins, 'tavern/tavern_feature/__init__.py'))],
  ['personal-profile', 'personal-profile', panel('personal-profile', 'personal_profile', 'personal-space-panel')],
  ['personal-database', 'personal-database', panel('personal-database', 'personal_database', 'personal-space-panel')],
  ['gemini-sync', 'gemini-sync', panel('gemini-sync', 'gemini_sync', 'integration') && fs.existsSync(path.join(plugins, 'gemini-sync/gemini_sync_plugin/__init__.py'))],
]
const paths = {'#shionarium/*': [path.join(here, 'src/*')]}
for (const [alias, folder, installed] of choices) {
  paths[`#${alias}/*`] = [path.join(installed ? path.join(plugins, folder, 'frontend') : path.join(here, 'src/optional', alias), '*')]
}
for (const dependency of ['react', 'react-dom']) {
  paths[dependency] = [path.join(here, 'node_modules/@types', dependency, 'index.d.ts')]
  paths[`${dependency}/*`] = [path.join(here, 'node_modules/@types', dependency, '*')]
}
const target = path.join(here, '.vite/tsconfig.plugins.json')
fs.mkdirSync(path.dirname(target), {recursive: true})
fs.writeFileSync(target, JSON.stringify({extends: '../tsconfig.json', compilerOptions: {paths}, include: [path.join(here, 'src')]}, null, 2))
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', target], {cwd: here, stdio: 'inherit', windowsHide: true})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
