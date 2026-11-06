// In Vite mode, an Android app's console output reaches neither logcat nor the `one dev` terminal. repro/ is an app on
// this checkout's one (`workspace:*`) whose app/index.tsx calls console.log('repro-console-line') and then writes
// 'repro-hook-line' to logcat itself through the host's nativeLoggingHook. The script builds the workspace, installs
// repro/ in a folder outside it from the workspace's packed packages (use-workspace-packages.mjs), and builds and
// installs the app with `one run:android` against a first `one dev`. It then stops that server and the app, starts a
// second `one dev`, clears logcat and launches the app: once the hook line is in logcat and the app's HMR client has
// connected, it stops the app, and once the server reports that client gone, it reads what reached each place.
// Needs an Android device or emulator; ANDROID_SERIAL names it when more than one is attached. From the checkout:
// node repro/reproduce.mjs
// Exits 1 while 'repro-console-line' is missing from logcat before the hook line or from the second server's output,
// 0 once it reaches both, and 2 when a step fails, port 8081 is taken, the app logs no hook line, or the server never
// reports the app's HMR client connecting or leaving.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'

const port = 8081
const consoleLine = 'repro-console-line'
const hookLine = 'repro-hook-line'
const checkout = resolve(import.meta.dirname, '..')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
const adb = sdk ? join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb'
const ansi = /\u001b\[[0-9;]*m/g

class StepFailure extends Error {}

// A crash is never the verdict: anything thrown outside the steps below ends the run with 2.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.log(`a step threw: ${error?.stack ?? error}`)
    process.exit(2)
  })
}

// Runs a command to its end without blocking the event loop, so the servers' and logcat's output keeps being read,
// and resolves with what it printed when `capture` is set, or lets it print otherwise.
const run = (command, args, { capture = false, ...options } = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'], ...options })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += chunk
    })
    child.stderr?.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => rejectRun(new StepFailure(`${[command, ...args].join(' ')} did not start: ${error.message}`)))
    child.on('close', (code, signal) => {
      if (code === 0) resolveRun(output.trim())
      else rejectRun(new StepFailure(`${[command, ...args].join(' ')} exited ${code ?? signal}${capture ? `: ${output.trim()}` : ''}`))
    })
  })
const read = (command, args, options = {}) => run(command, args, { ...options, capture: true })

// A child whose output lines are kept, and whose waits settle on the line that satisfies them or fail when the child
// exits or the deadline passes.
const watch = (name, command, args, options) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  const lines = []
  const waits = new Set()
  let exit
  const settle = () => {
    for (const wait of waits) {
      if (wait.isSatisfied(lines)) {
        waits.delete(wait)
        clearTimeout(wait.timer)
        wait.resolve()
      } else if (exit !== undefined) {
        waits.delete(wait)
        clearTimeout(wait.timer)
        wait.reject(new StepFailure(`${name} exited (${exit}) before ${wait.description}`))
      }
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line.replace(ansi, ''))
      settle()
    })
  }
  const exited = new Promise((resolveExit) => {
    child.on('error', (error) => {
      exit = error.message
      settle()
      resolveExit()
    })
    child.on('close', (code, signal) => {
      exit = code ?? signal
      settle()
      resolveExit()
    })
  })
  const waitFor = (description, isSatisfied, seconds) =>
    new Promise((resolveWait, rejectWait) => {
      const wait = { description, isSatisfied, resolve: resolveWait, reject: rejectWait }
      wait.timer = setTimeout(() => {
        waits.delete(wait)
        rejectWait(new StepFailure(`no ${description} within ${seconds} s`))
      }, seconds * 1000)
      waits.add(wait)
      settle()
    })
  const stop = async () => {
    if (exit !== undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    const killTimer = setTimeout(() => {
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
      } catch {}
    }, 30_000)
    await exited
    clearTimeout(killTimer)
  }
  return { lines, waitFor, stop }
}

const startServer = async (app, env) => {
  const server = watch('one dev', process.execPath, [join(app, 'node_modules', 'one', 'run.mjs'), 'dev', '--port', String(port)], {
    cwd: app,
    env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    detached: process.platform !== 'win32',
  })
  await server.waitFor('"Server running on" from one dev', (lines) => lines.some((line) => line.includes('Server running on')), 300)
  return server
}

const portIsFree = () =>
  new Promise((resolvePort) => {
    const probe = createServer()
    probe.once('error', () => resolvePort(false))
    probe.listen(port, () => probe.close(() => resolvePort(true)))
  })

let workspace
const servers = []
let logcat
let env = process.env
let reversed = false
let exitCode = 2
try {
  const attached = (await read(adb, ['devices']))
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial)
  const serial = process.env.ANDROID_SERIAL || (attached.length === 1 ? attached[0] : undefined)
  if (!serial || !attached.includes(serial)) {
    throw new StepFailure(
      `needs one attached Android device, or ANDROID_SERIAL naming one of: ${attached.join(', ') || 'none attached'}`
    )
  }
  env = { ...process.env, ANDROID_SERIAL: serial }
  const property = (name) => read(adb, ['shell', 'getprop', name], { env })
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  const android = `Android ${await property('ro.build.version.release')} (API ${await property('ro.build.version.sdk')})`
  console.log(
    `${process.platform} ${process.arch}, node ${process.versions.node}, bun ${bunVersion}, one checkout at ${revision}; ` +
      `${android}, ${await property('ro.product.cpu.abi')}`
  )
  if (!(await portIsFree())) throw new StepFailure(`port ${port}, which the app's debug build loads from, is in use`)

  await run('bun', ['install'], { cwd: checkout })
  await run('bun', ['run', 'build'], { cwd: checkout })
  workspace = mkdtempSync(join(tmpdir(), 'one-console-repro-'))
  const app = join(workspace, 'app')
  const source = join(checkout, 'repro')
  const generated = new Set(['node_modules', 'tmp', 'android', 'ios', 'dist', '.yarn', 'yarn.lock'])
  cpSync(source, app, {
    recursive: true,
    filter: (path) => !generated.has(relative(source, path).split(sep)[0]),
  })
  await run(process.execPath, [join(checkout, 'repro', 'use-workspace-packages.mjs'), app], { cwd: checkout })
  await run('bun', ['install'], { cwd: app })
  const applicationId = JSON.parse(readFileSync(join(app, 'app.json'), 'utf8')).expo.android.package

  await run(adb, ['reverse', `tcp:${port}`, `tcp:${port}`], { env })
  reversed = true
  servers.push(await startServer(app, env))
  await run(process.execPath, [join(app, 'node_modules', 'one', 'run.mjs'), 'run:android'], { cwd: app, env })
  await run(adb, ['shell', 'am', 'force-stop', applicationId], { env })
  await servers.pop().stop()

  await run(adb, ['logcat', '-c'], { env })
  logcat = watch('adb logcat', adb, ['logcat', '-v', 'brief', 'ReactNativeJS:V', '*:S'], { env })
  const server = await startServer(app, env)
  servers.push(server)
  await run(adb, ['shell', 'am', 'start', '-W', '-n', `${applicationId}/.MainActivity`], { env, capture: true })
  const pid = await read(adb, ['shell', 'pidof', applicationId], { env })
  const isAppLine = (line) => new RegExp(`^\\w/ReactNativeJS\\(\\s*${pid}\\):`).test(line)
  const connectedClient = () =>
    server.lines.map((line) => /\[hmr\] native client connected platform=android client=(\S+)/.exec(line)?.[1]).find(Boolean)
  await Promise.all([
    logcat.waitFor(`"${hookLine}" from the app in logcat`, (lines) => lines.some((line) => isAppLine(line) && line.includes(hookLine)), 300),
    server.waitFor("the app's HMR client connecting to one dev", () => connectedClient() !== undefined, 300),
  ])
  const client = connectedClient()
  await run(adb, ['shell', 'am', 'force-stop', applicationId], { env })
  await server.waitFor(
    `one dev reporting the app's HMR client (${client}) gone`,
    (lines) => lines.some((line) => line.includes(`native client disconnected platform=android client=${client}`)),
    60
  )
  await server.stop()
  await logcat.stop()

  const appLines = logcat.lines.filter(isAppLine)
  const hookIndex = appLines.findIndex((line) => line.includes(hookLine))
  const consoleIndex = appLines.findIndex((line) => line.includes(consoleLine))
  const inLogcat = consoleIndex !== -1 && consoleIndex < hookIndex
  const inTerminal = server.lines.some((line) => line.includes(consoleLine))
  const serverLines = server.lines.filter((line) => line.includes('[hmr]') || line.includes('repro-'))
  console.log('')
  console.log(`adb logcat ReactNativeJS:V, the app's lines (process ${pid}) from its launch until it was stopped:`)
  for (const line of appLines) console.log(`  ${line}`)
  console.log(`one dev, its lines naming [hmr] or repro- from its start until it reported the app's HMR client gone:`)
  for (const line of serverLines) console.log(`  ${line}`)
  console.log(`${consoleLine} in logcat before ${hookLine}: ${inLogcat ? 'yes' : 'no'}`)
  console.log(`${consoleLine} in one dev's output: ${inTerminal ? 'yes' : 'no'}`)
  const reached = [inLogcat && 'logcat', inTerminal && 'the one dev terminal'].filter(Boolean)
  const missed = [!inLogcat && 'logcat', !inTerminal && 'the one dev terminal'].filter(Boolean)
  console.log(
    reached.length === 0
      ? `console.log('${consoleLine}') reached neither logcat nor the one dev terminal`
      : missed.length === 0
        ? `console.log('${consoleLine}') reached logcat and the one dev terminal`
        : `console.log('${consoleLine}') reached ${reached[0]} but not ${missed[0]}`
  )
  exitCode = missed.length === 0 ? 0 : 1
} catch (error) {
  console.log(error instanceof StepFailure ? error.message : `a step threw: ${error?.stack ?? error}`)
  exitCode = 2
} finally {
  // Cleanup reports what it could not undo and never changes the verdict.
  try {
    for (const server of servers) await server.stop()
    await logcat?.stop()
    if (reversed) spawnSync(adb, ['reverse', '--remove', `tcp:${port}`], { stdio: 'ignore', env })
    if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  } catch (error) {
    console.log(`cleanup: ${error?.message ?? error}`)
  }
}
process.exit(exitCode)
