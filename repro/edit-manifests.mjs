// `workspace-root <root> <app>` makes <root> a Bun workspace of the app in <app>, moving the app's overrides, which point
// at its packed packages, to the root, where a workspace's overrides apply. `drop-dependencies <app> <name>...` removes
// the named dependencies from the app's package.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const readManifest = (folder) => JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
const writeManifest = (folder, manifest) =>
  writeFileSync(join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const [command, ...parameters] = process.argv.slice(2)
switch (command) {
  case 'workspace-root': {
    const [root, app] = parameters
    const manifest = readManifest(app)
    const overrides = Object.fromEntries(
      Object.entries(manifest.overrides).map(([name, path]) => [name, path.replace('file:./', 'file:./app/')])
    )
    delete manifest.overrides
    writeManifest(app, manifest)
    writeManifest(root, { name: 'workspace', private: true, workspaces: ['app'], overrides })
    break
  }
  case 'drop-dependencies': {
    const [app, ...names] = parameters
    const manifest = readManifest(app)
    for (const name of names) delete manifest.dependencies[name]
    writeManifest(app, manifest)
    break
  }
  default:
    throw new Error(`unknown command: ${command}`)
}
