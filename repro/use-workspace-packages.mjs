// Points the app in the folder the first argument names at this checkout's own packages: packs each package its
// package.json asks for as `workspace:*`, and every package of packages/ those depend on, with `bun pm pack` into the
// app's workspace-packages/, and rewrites the app's package.json to install them from there, as
// packages/one/src/native/packedClosure.test.ts installs its app.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const app = resolve(process.argv[2])
const packagesFolder = resolve(import.meta.dirname, '../packages')
const readManifest = (folder) => JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))

const workspaceFolders = new Map(
  readdirSync(packagesFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesFolder, entry.name, 'package.json')))
    .map((entry) => [readManifest(join(packagesFolder, entry.name)).name, join(packagesFolder, entry.name)])
)
const appManifest = readManifest(app)
const askedFor = Object.entries({ ...appManifest.dependencies, ...appManifest.devDependencies })
  .filter(([, version]) => version === 'workspace:*')
  .map(([name]) => name)
const packed = join(app, 'workspace-packages')
mkdirSync(packed, { recursive: true })

const tarballs = {}
const pending = askedFor.map((name) => {
  const folder = workspaceFolders.get(name)
  if (!folder) throw new Error(`${name} is not a package of packages/`)
  return folder
})
for (const folder of pending) {
  const manifest = readManifest(folder)
  if (tarballs[manifest.name]) continue
  execFileSync('bun', ['pm', 'pack', '--destination', packed], { cwd: folder, stdio: ['ignore', 'ignore', 'inherit'] })
  const tarball = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  if (!existsSync(join(packed, tarball))) throw new Error(`bun pm pack wrote no ${tarball} for ${manifest.name}`)
  tarballs[manifest.name] = `file:./workspace-packages/${tarball}`
  for (const dependency of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })) {
    const dependencyFolder = workspaceFolders.get(dependency)
    if (dependencyFolder) pending.push(dependencyFolder)
  }
}

for (const field of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(appManifest[field] ?? {})) {
    if (appManifest[field][name] === 'workspace:*') appManifest[field][name] = tarballs[name]
  }
}
appManifest.overrides = { ...appManifest.overrides, ...tarballs }
writeFileSync(join(app, 'package.json'), `${JSON.stringify(appManifest, null, 2)}\n`)
console.log(`packed from the checkout: ${Object.keys(tarballs).sort().join(', ')}`)
