// One's iOS pod names iOS 27 SDK types outside its `ONE_IOS_27_SDK` guard, so an app does not build with Xcode 26.
// repro/ is an app on this checkout's one (`workspace:*`). The script builds the workspace, installs repro/ outside it
// from the workspace's packed packages (use-workspace-packages.mjs), runs `one prebuild --platform ios`, and builds the
// app for the iOS simulator with the Xcode that DEVELOPER_DIR or xcode-select names, keeping xcodebuild's whole log at
// REPRO_LOG, or in the system's temporary folder. It removes the app's folder before it prints the result.
// Needs macOS and an Xcode whose iOS SDK is older than 27. From the checkout: node repro/reproduce-ios.mjs
// Exits 1 while One's Swift fails to compile against the SDK's missing iOS 27 types, 0 once the app builds, and 2 when
// a step fails, the Xcode's iOS SDK is 27 or newer, or the build fails another way.
import { spawn } from 'node:child_process'
import { cpSync, createWriteStream, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const checkout = resolve(import.meta.dirname, '..')
const iosTypesOutsideTheGuard = /OneNativeStyle\.swift:\d+:\d+: error: .*\b(ReorderDifference|AppEntityUIElementsContext|AppEntityUIElement)\b/

class StepFailure extends Error {}

// The verdict on a finished xcodebuild: its exit status and its whole log.
export const judge = (status, log) => {
  const lines = log.split('\n')
  const oneErrors = [...new Set(lines.filter((line) => /OneNativeStyle\.swift:\d+:\d+: error: /.test(line)))]
  if (status === 0 && lines.includes('** BUILD SUCCEEDED **')) {
    return { exitCode: 0, oneErrors, verdict: 'the app builds' }
  }
  if (oneErrors.some((line) => iosTypesOutsideTheGuard.test(line))) {
    return {
      exitCode: 1,
      oneErrors,
      verdict: "One's OneNativeStyle.swift names iOS 27 SDK types this SDK lacks, outside ONE_IOS_27_SDK",
    }
  }
  return { exitCode: 2, oneErrors, verdict: `xcodebuild exited ${status} without the iOS 27 type errors in One's Swift` }
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

const reproduce = async () => {
  if (process.platform !== 'darwin') throw new StepFailure(`needs macOS with Xcode; this is ${process.platform}`)
  const xcode = (await read('xcodebuild', ['-version'])).split('\n').join(' ')
  const sdkVersion = await read('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  console.log(
    `macOS ${await read('sw_vers', ['-productVersion'])} (${process.arch}, Darwin ${release()}), node ${process.versions.node}, ` +
      `bun ${bunVersion}, one checkout at ${revision}; ${xcode}, iphonesimulator SDK ${sdkVersion}`
  )
  if (Number(sdkVersion.split('.')[0]) >= 27) {
    throw new StepFailure(`needs an Xcode whose iOS SDK is older than 27; this one's is ${sdkVersion}`)
  }

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

  const xcworkspace = readdirSync(join(app, 'ios')).find((name) => name.endsWith('.xcworkspace'))
  if (!xcworkspace) throw new StepFailure('one prebuild wrote no ios/*.xcworkspace')
  const scheme = xcworkspace.slice(0, -'.xcworkspace'.length)
  const logFile = process.env.REPRO_LOG || join(tmpdir(), 'one-repro-xcodebuild.log')
  const buildArguments = [
    '-workspace', join('ios', xcworkspace), '-scheme', scheme, '-configuration', 'Debug', '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', join(workspace, 'build'),
    'CODE_SIGNING_ALLOWED=NO', 'build',
  ]
  console.log(`xcodebuild ${buildArguments.map(redact).join(' ')} > ${redact(logFile)}`)
  const status = await run('xcodebuild', buildArguments, { cwd: app, env: environment, logFile })
  const log = readFileSync(logFile, 'utf8')
  const result = judge(status, log)
  for (const line of result.oneErrors) console.log(redact(line.replace(/^.*\/node_modules\/one\//, 'node_modules/one/')))
  const failedCommands = log.split('\n').findIndex((line) => line === 'The following build commands failed:')
  for (const line of log.split('\n').filter((line) => /^\*\* BUILD (SUCCEEDED|FAILED) \*\*$/.test(line))) console.log(line)
  if (failedCommands !== -1) {
    for (const line of log.split('\n').slice(failedCommands, failedCommands + 4)) console.log(redact(line))
  }
  return result
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
