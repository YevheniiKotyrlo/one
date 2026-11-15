// An iOS Release build of an app that uses neither the pedometer, the barometer nor the protected store still compiles
// One's HybridOnePedometer.swift (CMPedometer), HybridOneBarometer.swift (CMAltimeter) and
// HybridOneProtectedStore.swift (LAContext): no feature group of ios-link-set.json holds them, so the link set
// `one prebuild` writes cannot leave them out.
// repro/ is an app on this checkout's one (`workspace:*`) with a `native.app` name and ids, nothing else. The script
// builds the workspace, installs repro/ outside it from the workspace's packed packages (use-workspace-packages.mjs),
// runs `one prebuild --platform ios`, prints the ios/one-link-set.json it wrote, builds the app's Release
// configuration for iOS devices without signing, and prints the Core Motion and LocalAuthentication classes One's
// Release object files reference (`nm -um`), and, once the app links, those its binary references and the purpose
// strings of its Info.plist. xcodebuild keeps compiling after an error, so One's object files are read even when
// another of One's files fails to compile with this Xcode. It removes the app's folder before it prints the result.
// Needs macOS and Xcode. From the checkout: node repro/reproduce-ios.mjs
// Exits 1 while One's Release objects, or the app binary, reference CMPedometer, CMAltimeter or LAContext with a link
// set that names no group, 0 once the app builds and its binary references none, and 2 when a step fails, prebuild
// writes no link set, or the build fails without One's objects referencing them.
import { spawn } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const checkout = resolve(import.meta.dirname, '..')
export const protectedClasses = ['CMPedometer', 'CMAltimeter', 'LAContext']
const protectedSymbol = new RegExp(`_OBJC_CLASS_\\$_(${protectedClasses.join('|')})\\b`)

class StepFailure extends Error {}

// The verdict on a finished build: xcodebuild's exit status, the link set prebuild wrote (undefined when it wrote
// none), the `nm -um` lines of the app's Mach-O files that name a protected class (none when the app did not link),
// and the protected classes each of One's Release object files references.
export const judge = ({ status, linkSet, binaryReferences, objectReferences = {} }) => {
  if (linkSet === undefined) {
    return { exitCode: 2, verdict: 'one prebuild wrote no ios/one-link-set.json, so the Release build links every group' }
  }
  const groups = linkSet.groups?.length ? linkSet.groups.join(', ') : 'none'
  const inObjects = protectedClasses.filter((name) => Object.values(objectReferences).some((list) => list.includes(name)))
  if (status !== 0) {
    if (!inObjects.length) return { exitCode: 2, verdict: `xcodebuild exited ${status}` }
    const files = Object.keys(objectReferences).filter((file) => objectReferences[file].length)
    return {
      exitCode: 1,
      verdict:
        `One's Release objects ${files.join(', ')} reference ${inObjects.join(', ')} though ios/one-link-set.json ` +
        `names groups: ${groups} (xcodebuild exited ${status}, so the app did not link)`,
    }
  }
  const referenced = protectedClasses.filter((name) =>
    binaryReferences.some((line) => new RegExp(`_OBJC_CLASS_\\$_${name}\\b`).test(line))
  )
  if (referenced.length) {
    return {
      exitCode: 1,
      verdict: `the Release binary references ${referenced.join(', ')} though ios/one-link-set.json names groups: ${groups}`,
    }
  }
  return { exitCode: 0, verdict: `the Release binary references none of ${protectedClasses.join(', ')} (groups: ${groups})` }
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
  return redacted.replaceAll(/\/Users\/[^/\s]+\//g, '~/')
}

// Runs a command to its end, printing each of its lines, or writing them to `logFile` instead when one is given, and
// resolves with its exit status; a command that does not start, or exits non-zero without `logFile`, fails the step.
const run = (command, args, { logFile, ...options } = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const log = logFile ? createWriteStream(logFile) : undefined
    for (const stream of [child.stdout, child.stderr]) {
      if (log) stream.pipe(log, { end: false })
      else createInterface({ input: stream }).on('line', (line) => console.log(redact(line)))
    }
    const described = redact([command, ...args].join(' '))
    child.on('error', (error) => rejectRun(new StepFailure(`${described} did not start: ${error.message}`)))
    child.on('close', (code, signal) => {
      const finish = () => {
        if (log || code === 0) resolveRun(code ?? signal)
        else rejectRun(new StepFailure(`${described} exited ${code ?? signal}`))
      }
      if (log) log.end(finish)
      else finish()
    })
  })

const read = (command, args, options = {}) =>
  new Promise((resolveRead, rejectRead) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let printed = ''
    child.stdout.on('data', (chunk) => {
      printed += chunk
    })
    child.on('error', (error) => rejectRead(new StepFailure(`${command} did not start: ${error.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolveRead(printed.trim()) : rejectRead(new StepFailure(`${command} ${args.join(' ')} exited ${code}`))
    )
  })

// The Mach-O files of a built .app: its executable and each embedded framework's.
const machOFiles = (appBundle) => {
  const info = JSON.parse(readFileSync(join(appBundle, 'Info.json'), 'utf8'))
  const files = [join(appBundle, info.CFBundleExecutable)]
  const frameworks = join(appBundle, 'Frameworks')
  if (existsSync(frameworks)) {
    for (const name of readdirSync(frameworks).filter((entry) => entry.endsWith('.framework'))) {
      files.push(join(frameworks, name, name.slice(0, -'.framework'.length)))
    }
  }
  return { info, files: files.filter((file) => existsSync(file)) }
}

const filesBelow = (folder, test) => {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

const reproduce = async () => {
  if (process.platform !== 'darwin') throw new StepFailure(`needs macOS with Xcode; this is ${process.platform}`)
  const xcode = (await read('xcodebuild', ['-version'])).split('\n').join(' ')
  const sdkVersion = await read('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version'])
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  console.log(
    `macOS ${await read('sw_vers', ['-productVersion'])} (${process.arch}, Darwin ${release()}), node ${process.versions.node}, ` +
      `bun ${bunVersion}, one checkout at ${revision}; ${xcode}, iphoneos SDK ${sdkVersion}`
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
  await run(process.execPath, [join(app, 'node_modules', 'one', 'run.mjs'), 'prebuild', '--platform', 'ios'], {
    cwd: app,
    env: environment,
  })

  const linkSetFile = join(app, 'ios', 'one-link-set.json')
  const linkSet = existsSync(linkSetFile) ? JSON.parse(readFileSync(linkSetFile, 'utf8')) : undefined
  console.log(`ios/one-link-set.json: ${linkSet === undefined ? 'not written' : JSON.stringify(linkSet)}`)
  if (linkSet === undefined) return judge({ status: 0, linkSet, binaryReferences: [] })

  const xcworkspace = readdirSync(join(app, 'ios')).find((name) => name.endsWith('.xcworkspace'))
  if (!xcworkspace) throw new StepFailure('one prebuild wrote no ios/*.xcworkspace')
  const scheme = xcworkspace.slice(0, -'.xcworkspace'.length)
  const derivedData = join(workspace, 'build')
  const logFile = process.env.REPRO_LOG || join(tmpdir(), 'one-repro-xcodebuild.log')
  const buildArguments = [
    '-workspace', join('ios', xcworkspace), '-scheme', scheme, '-configuration', 'Release', '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS', '-derivedDataPath', derivedData, '-IDEBuildingContinueBuildingAfterErrors=YES',
    'CODE_SIGNING_ALLOWED=NO', 'build',
  ]
  console.log(`xcodebuild ${buildArguments.map(redact).join(' ')} > ${redact(logFile)}`)
  const status = await run('xcodebuild', buildArguments, { cwd: app, env: environment, logFile })
  const log = readFileSync(logFile, 'utf8').split('\n')
  for (const line of log.filter((text) => /^\*\* BUILD (SUCCEEDED|FAILED) \*\*$/.test(text))) console.log(line)
  if (status !== 0) {
    const errors = [...new Set(log.filter((text) => /\.(swift|mm?|cpp|h):\d+:\d+: error: /.test(text)))]
    for (const line of errors.slice(0, 10)) console.log(redact(line).replace(/^.*\/node_modules\/one\//, 'node_modules/one/'))
  }

  // One's own Release object files, and the protected classes each references.
  const oneObjects = filesBelow(
    join(derivedData, 'Build', 'Intermediates.noindex', 'Pods.build', 'Release-iphoneos', 'One.build'),
    (name) => name.endsWith('.o')
  ).sort()
  const objectReferences = {}
  for (const object of oneObjects) {
    const classes = [
      ...new Set(
        (await read('nm', ['-um', object]))
          .split('\n')
          .map((line) => protectedSymbol.exec(line)?.[1])
          .filter(Boolean)
      ),
    ]
    if (classes.length) objectReferences[object.split('/').at(-1)] = classes
  }
  console.log(`One's Release object files: ${oneObjects.length}; those that reference ${protectedClasses.join(', ')}:`)
  for (const [object, classes] of Object.entries(objectReferences)) console.log(`  ${object}: ${classes.join(', ')}`)
  if (status !== 0) return judge({ status, linkSet, binaryReferences: [], objectReferences })

  const products = join(derivedData, 'Build', 'Products', 'Release-iphoneos')
  const appName = readdirSync(products).find((name) => name.endsWith('.app'))
  if (!appName) throw new StepFailure(`the build left no .app in ${redact(products)}`)
  const appBundle = join(products, appName)
  await run('plutil', ['-convert', 'json', '-o', join(appBundle, 'Info.json'), join(appBundle, 'Info.plist')])
  const { info, files } = machOFiles(appBundle)
  const binaryReferences = []
  for (const file of files) {
    const name = relative(products, file)
    const lines = (await read('nm', ['-um', file])).split('\n').filter((line) => protectedSymbol.test(line))
    console.log(`nm -um ${name}: ${lines.length ? '' : 'no reference to ' + protectedClasses.join(', ')}`)
    for (const line of lines) console.log(`  ${line.trim()}`)
    binaryReferences.push(...lines)
  }
  const purposeStrings = Object.keys(info).filter((key) => /^NS\w+UsageDescription$/.test(key))
  console.log(`${appName}/Info.plist purpose strings: ${purposeStrings.join(', ') || 'none'}`)
  return judge({ status, linkSet, binaryReferences, objectReferences })
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
