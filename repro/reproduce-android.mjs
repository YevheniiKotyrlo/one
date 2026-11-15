// One's Android library manifest declares FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION and the location-type
// foreground service dev.onejs.onenative.OneLocationService, and the manifest merger carries all three into every app,
// one that never uses location included.
// repro/ is an app on this checkout's one (`workspace:*`) with a `native.app` name and ids, nothing else: no location
// config. The script builds the workspace, installs repro/ outside it from the workspace's packed packages
// (use-workspace-packages.mjs), runs `one prebuild --platform android`, merges the app's release manifest with Gradle
// (`:app:processReleaseMainManifest`), and prints the merged manifest's foreground-service permissions and services with
// the merger's record of where each came from. It removes the app's folder before it prints the result.
// Needs a JDK and the Android SDK (ANDROID_HOME). From the checkout: node repro/reproduce-android.mjs
// Exits 1 while the merged release manifest declares FOREGROUND_SERVICE_LOCATION or a location-type foreground service,
// 0 once it declares neither, and 2 when a step fails.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const checkout = resolve(import.meta.dirname, '..')

class StepFailure extends Error {}

// The merged manifest's foreground-service permissions, and its services with their foregroundServiceType.
export const foregroundServiceDeclarations = (manifest) => {
  const permissions = [...manifest.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((name) => name.startsWith('android.permission.FOREGROUND_SERVICE'))
  const services = [...manifest.matchAll(/<service\b[^>]*>/g)].map((match) => ({
    name: /android:name="([^"]+)"/.exec(match[0])?.[1],
    type: /android:foregroundServiceType="([^"]+)"/.exec(match[0])?.[1],
  }))
  return { permissions, services }
}

// The verdict on the merged release manifest's text, or undefined when Gradle wrote none.
export const judge = (manifest) => {
  if (manifest === undefined) return { exitCode: 2, verdict: 'Gradle wrote no merged release manifest' }
  const { permissions, services } = foregroundServiceDeclarations(manifest)
  const found = [
    ...permissions.filter((name) => name === 'android.permission.FOREGROUND_SERVICE_LOCATION'),
    ...services
      .filter((service) => service.type?.split('|').includes('location'))
      .map((service) => `${service.name} (foregroundServiceType="${service.type}")`),
  ]
  if (found.length) {
    return {
      exitCode: 1,
      verdict: `the release manifest of an app with no location config declares ${found.join(' and ')}`,
    }
  }
  return { exitCode: 0, verdict: 'the release manifest declares no location foreground service' }
}

let workspace
const redact = (text) => {
  let redacted = String(text).replaceAll(process.execPath, 'node')
  for (const [path, name] of [
    [workspace, '<workspace>'],
    [checkout, '<checkout>'],
  ]) {
    if (path) redacted = redacted.replaceAll(path, name)
  }
  return redacted.replaceAll(/\/(home|Users)\/[^/\s]+\//g, '~/')
}

// Runs a command to its end, printing each of its lines, and fails the step when it does not start or exits non-zero.
const run = (command, args, options = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => console.log(redact(line)))
    }
    const described = redact([command, ...args].join(' '))
    child.on('error', (error) => rejectRun(new StepFailure(`${described} did not start: ${error.message}`)))
    child.on('close', (code, signal) =>
      code === 0 ? resolveRun(0) : rejectRun(new StepFailure(`${described} exited ${code ?? signal}`))
    )
  })

const read = (command, args, options = {}) =>
  new Promise((resolveRead, rejectRead) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let printed = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        printed += chunk
      })
    }
    child.on('error', (error) => rejectRead(new StepFailure(`${command} did not start: ${error.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolveRead(printed.trim()) : rejectRead(new StepFailure(`${command} ${args.join(' ')} exited ${code}`))
    )
  })

const filesBelow = (folder, test) => {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && test(entry.name, entry.parentPath))
    .map((entry) => join(entry.parentPath, entry.name))
}

const reproduce = async () => {
  if (!process.env.ANDROID_HOME) throw new StepFailure('needs the Android SDK named by ANDROID_HOME')
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  const java = (await read('java', ['-version'])).split('\n')[0]
  console.log(
    `${process.platform} ${release()} (${process.arch}), node ${process.versions.node}, bun ${bunVersion}, ` +
      `one checkout at ${revision}; ${java}`
  )

  await run('bun', ['install'], { cwd: checkout })
  await run('bun', ['run', 'build'], { cwd: checkout })
  workspace = mkdtempSync(join(tmpdir(), 'one-repro-'))
  const app = join(workspace, 'app')
  const source = join(checkout, 'repro')
  const generated = new Set(['node_modules', 'tmp', 'android', 'ios', 'dist', '.yarn', 'yarn.lock'])
  cpSync(source, app, { recursive: true, filter: (path) => !generated.has(relative(source, path).split(sep)[0]) })
  await run(process.execPath, [join(checkout, 'repro', 'use-workspace-packages.mjs'), app], { cwd: checkout })
  await run('bun', ['install'], { cwd: app })
  const environment = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  await run(process.execPath, [join(app, 'node_modules', 'one', 'run.mjs'), 'prebuild', '--platform', 'android'], {
    cwd: app,
    env: environment,
  })

  const config = readFileSync(join(app, 'vite.config.ts'), 'utf8')
  console.log(`repro/vite.config.ts native.app: ${/app: (\{[\s\S]*?\n {8}\})/.exec(config)?.[1].replace(/\s+/g, ' ')}`)
  const android = join(app, 'android')
  console.log('./gradlew :app:processReleaseMainManifest')
  await run('sh', ['./gradlew', ':app:processReleaseMainManifest', '--console=plain', '--quiet'], { cwd: android, env: environment })

  const intermediates = join(android, 'app', 'build', 'intermediates')
  const merged = filesBelow(join(intermediates, 'merged_manifest', 'release'), (name) => name === 'AndroidManifest.xml')[0]
  if (!merged) return judge(undefined)
  const manifest = readFileSync(merged, 'utf8')
  console.log(`merged manifest: ${redact(relative(android, merged))}`)
  const { permissions, services } = foregroundServiceDeclarations(manifest)
  for (const name of permissions) console.log(`  <uses-permission android:name="${name}" />`)
  for (const service of services) {
    console.log(`  <service android:name="${service.name}"${service.type ? ` android:foregroundServiceType="${service.type}"` : ''} />`)
  }

  // The merger's blame report names the manifest each element came from.
  const blame = filesBelow(join(android, 'app', 'build', 'outputs', 'logs'), (name) =>
    /^manifest-merger-.*release.*report\.txt$/.test(name)
  )[0]
  if (blame) {
    const lines = readFileSync(blame, 'utf8').split('\n')
    const wanted = [
      'uses-permission#android.permission.FOREGROUND_SERVICE',
      'uses-permission#android.permission.FOREGROUND_SERVICE_LOCATION',
      'service#dev.onejs.onenative.OneLocationService',
    ]
    console.log(`merger record (${redact(relative(android, blame))}):`)
    for (const key of wanted) {
      const at = lines.indexOf(key)
      if (at === -1) continue
      console.log(`  ${key}`)
      console.log(`  ${redact(lines[at + 1].trim().replace(/\S*\/node_modules\//, 'node_modules/'))}`)
    }
  }
  return judge(manifest)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
      console.log(`a step threw: ${redact(error?.stack ?? error)}`)
      process.exit(2)
    })
  }
  let outcome
  try {
    outcome = await reproduce()
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error
    outcome = { exitCode: 2, verdict: `a step failed: ${redact(error.message)}` }
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  }
  console.log(`verdict: ${outcome.verdict}`)
  process.exitCode = outcome.exitCode
}
