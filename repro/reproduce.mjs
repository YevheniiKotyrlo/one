// After a native HMR update fails on an import of a module that does not exist yet, `one dev` keeps serving the bundle
// it built before that update once the module exists. repro/ is an app on this checkout's one (`workspace:*`) whose
// app/index.tsx renders src/first.ts and src/second.ts. The script builds the workspace, installs repro/ in a folder
// outside it from the workspace's packed packages (use-workspace-packages.mjs) and starts `one dev`. It then does what
// an Android app does, with no device: it fetches /index.bundle?platform=android, as a launch does, and listens on the
// /hot socket while it edits the app's files. From the checkout: node repro/reproduce.mjs
// Exits 1 while a bundle fetched after src/created.ts exists is the one from before the failed update, or an update
// importing src/created.ts fails to resolve it; 0 once both bundles and the update hold src/created.ts; 2 when a step
// fails or ends another way.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { release, tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'

const checkout = join(import.meta.dirname, '..')
const ansi = /\u001b\[[0-9;]*m/g
const isWindows = process.platform === 'win32'
const updateSeconds = 60
const quietSeconds = 10
const bundleSeconds = 300
const markers = ['repro-first-v1', 'repro-first-v2', 'repro-second-v1', 'repro-second-v2', 'repro-created-v1']
const files = {
  first: "import { created } from './created'\n\nexport const first = `repro-first-v2 ${created}`\n",
  created: "export const created = 'repro-created-v1'\n",
  second: "import { created } from './created'\n\nexport const second = `repro-second-v2 ${created}`\n",
}

class StepFailure extends Error {}

// A crash is never the verdict: anything thrown outside the steps below ends the run with 2.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.log(`a step threw: ${error?.stack ?? error}`)
    process.exit(2)
  })
}

let workspace
// Output names the workspace, the checkout and this node by those words, never by their values on this machine, and
// shows no IPv4 address, such as the LAN address `one dev` prints.
const redact = (text) => {
  let redacted = String(text).replaceAll(process.execPath, 'node')
  redacted = redacted.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<address>')
  for (const [path, name] of [
    [workspace, '<workspace>'],
    [checkout, '<checkout>'],
  ]) {
    if (!path) continue
    redacted = redacted.replaceAll(path, name).replaceAll(path.replaceAll('\\', '/'), name)
  }
  return redacted
}
const describe = (command, args) =>
  redact([command === process.execPath ? 'node' : basename(command), ...args].join(' '))

// Runs a command to its end, and resolves with what it printed when `capture` is set, or prints each of its lines
// through redact() otherwise.
const run = (command, args, { capture = false, ...options } = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options })
    let printed = ''
    for (const stream of [child.stdout, child.stderr]) {
      if (capture) {
        stream.on('data', (chunk) => {
          printed += chunk
        })
      } else {
        createInterface({ input: stream }).on('line', (line) => console.log(redact(line)))
      }
    }
    child.on('error', (error) => rejectRun(new StepFailure(`${describe(command, args)} did not start: ${error.message}`)))
    child.on('close', (code, signal) => {
      if (code === 0) resolveRun(printed.trim())
      else {
        rejectRun(
          new StepFailure(
            `${describe(command, args)} exited ${code ?? signal}${capture && printed.trim() ? `: ${redact(printed.trim())}` : ''}`
          )
        )
      }
    })
  })
const read = (command, args, options = {}) => run(command, args, { ...options, capture: true })

// A child whose output lines are kept, and whose waits settle on the line that satisfies them or fail when its
// output ends or the deadline passes. Stopping it stops its descendants with it.
const watch = (name, command, args, options) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWindows,
    ...options,
  })
  const lines = []
  const waits = new Set()
  let ended
  const settle = () => {
    for (const wait of waits) {
      if (wait.isSatisfied(lines)) {
        waits.delete(wait)
        clearTimeout(wait.timer)
        wait.resolve()
      } else if (ended !== undefined) {
        waits.delete(wait)
        clearTimeout(wait.timer)
        wait.reject(new StepFailure(`${name} exited (${ended}) before ${wait.description}`))
      }
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line.replace(ansi, ''))
      settle()
    })
  }
  let exitCode
  const exited = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      exitCode = code ?? signal
      resolveExit()
    })
  })
  child.on('error', (error) => {
    ended = error.message
    settle()
  })
  child.on('close', () => {
    ended = exitCode
    settle()
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
  const kill = (signal) => {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  const stop = async () => {
    if (exitCode === undefined && child.pid !== undefined) {
      kill('SIGTERM')
      const fallback = setTimeout(() => kill('SIGKILL'), 30_000)
      await exited
      clearTimeout(fallback)
    }
    child.stdout.destroy()
    child.stderr.destroy()
  }
  return { lines, waitFor, stop }
}

const freePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })

// A launch's bundle: its status, its size, and which of the app's markers it holds.
const fetchBundle = async (origin) => {
  const response = await fetch(`${origin}/index.bundle?platform=android&dev=true&minify=false`, {
    signal: AbortSignal.timeout(bundleSeconds * 1000),
  }).catch((error) => {
    throw new StepFailure(`GET /index.bundle?platform=android failed: ${error.message}`)
  })
  const code = await response.text()
  return { status: response.status, bytes: Buffer.byteLength(code), holds: markers.filter((marker) => code.includes(marker)) }
}
const describeBundle = ({ status, bytes, holds }) =>
  `${status}, ${bytes} bytes, holding ${holds.length > 0 ? holds.join(', ') : 'none of the markers'}`
// `current` names the markers of the source on disk when the bundle was fetched; the bundle from before step 2 holds
// the first and second modules' first versions and nothing of src/created.ts.
const judgeBundle = (bundle, current) => {
  const same = (expected) => bundle.holds.length === expected.length && expected.every((m) => bundle.holds.includes(m))
  if (bundle.status === 200 && same(current)) return 'current'
  if (bundle.status === 200 && same(['repro-first-v1', 'repro-second-v1'])) return 'from before step 2'
  return 'unexpected'
}

// The /hot socket an app's HMR runtime opens: every message it receives is kept, and a wait settles on the first one
// that arrives after it starts, or on none once its deadline passes.
const connectHmrClient = (origin, clientId) =>
  new Promise((resolveClient, rejectClient) => {
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/hot?platform=android&clientId=${clientId}`)
    const messages = []
    const listeners = new Set()
    socket.addEventListener('message', ({ data }) => {
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        message = { type: `a message that is not JSON: ${String(data).slice(0, 80)}` }
      }
      messages.push(message)
      for (const listener of listeners) listener()
    })
    socket.addEventListener('open', () => {
      const nextMessage = (seconds) =>
        new Promise((resolveMessage) => {
          const from = messages.length
          const listener = () => {
            listeners.delete(listener)
            clearTimeout(timer)
            resolveMessage(messages[from])
          }
          const timer = setTimeout(() => {
            listeners.delete(listener)
            resolveMessage(undefined)
          }, seconds * 1000)
          listeners.add(listener)
        })
      resolveClient({ nextMessage, close: () => socket.close() })
    })
    socket.addEventListener('error', () => rejectClient(new StepFailure('the /hot socket did not open')))
  })
const describeMessage = (message, seconds) =>
  message === undefined
    ? `no message within ${seconds} s`
    : message.type === 'hmr:update'
      ? `hmr:update (${message.code.length} characters${message.code.includes('repro-created-v1') ? ', holding repro-created-v1' : ''})`
      : message.type

const unresolvedCreated = (line) => line.includes('UNRESOLVED_IMPORT') && line.includes("'./created'")
const isErrorLine = (line) => line.includes('[vxrn] HMR error') || /^\[[A-Z_]+\] /.test(line)

let server
// one dev prints an HMR error before it sends hmr:error, but its output can reach this process after the message.
const errorLinesSince = async (from, message) => {
  if (message?.type === 'hmr:error') {
    await server
      .waitFor('UNRESOLVED_IMPORT from one dev', (lines) => lines.slice(from).some((line) => line.includes('UNRESOLVED_IMPORT')), 10)
      .catch(() => {})
  }
  return server.lines.slice(from).filter(isErrorLine)
}
let client
let failure
let result
try {
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  console.log(
    `${process.platform} ${process.arch} ${release()}, node ${process.versions.node}, bun ${bunVersion}, one checkout at ${revision}`
  )

  await run('bun', ['install'], { cwd: checkout })
  await run('bun', ['run', 'build'], { cwd: checkout })
  workspace = mkdtempSync(join(tmpdir(), 'ocr-'))
  const app = join(workspace, 'app')
  const source = join(checkout, 'repro')
  const generated = new Set(['node_modules', 'tmp', 'android', 'ios', 'dist', '.yarn', 'yarn.lock'])
  cpSync(source, app, {
    recursive: true,
    filter: (path) => !generated.has(relative(source, path).split(sep)[0]),
  })
  await run(process.execPath, [join(checkout, 'repro', 'use-workspace-packages.mjs'), app], { cwd: checkout })
  await run('bun', ['install'], { cwd: app })
  const versionOf = (name, from) =>
    JSON.parse(readFileSync(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`), 'utf8')).version
  const vxrnFolder = join(createRequire(join(app, 'package.json')).resolve('vxrn/package.json'), '..')
  console.log(
    `installed: one ${versionOf('one', app)}, vxrn ${versionOf('vxrn', app)}, rolldown ${versionOf('rolldown', vxrnFolder)} (as vxrn loads it)`
  )

  const port = await freePort()
  const origin = `http://localhost:${port}`
  server = watch('one dev', process.execPath, [join(app, 'node_modules', 'one', 'run.mjs'), 'dev', '--port', String(port)], {
    cwd: app,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  await server.waitFor('"Server running on" from one dev', (lines) => lines.some((line) => line.includes('Server running on')), 300)

  const initial = await fetchBundle(origin)
  console.log(`step 1, a launch: GET /index.bundle?platform=android: ${describeBundle(initial)}`)
  if (judgeBundle(initial, ['repro-first-v1', 'repro-second-v1']) !== 'current') {
    throw new StepFailure(`the first bundle is not the app's: ${describeBundle(initial)}`)
  }

  const clientId = `repro-${process.pid}`
  client = await connectHmrClient(origin, clientId)
  await server.waitFor(
    `"[hmr] native client connected" for ${clientId} from one dev`,
    (lines) => lines.some((line) => line.includes('[hmr] native client connected') && line.includes(clientId.slice(-6))),
    60
  )
  console.log(`step 1, the app's HMR client: /hot?platform=android&clientId=${clientId} connected, and one dev registered it`)

  let from = server.lines.length
  let message = client.nextMessage(updateSeconds)
  writeFileSync(join(app, 'src', 'first.ts'), files.first)
  const missingUpdate = await message
  const missingErrors = await errorLinesSince(from, missingUpdate)
  console.log(`step 2: src/first.ts imports ./created, which does not exist: ${describeMessage(missingUpdate, updateSeconds)}`)
  for (const line of missingErrors) console.log(`  one dev: ${redact(line)}`)
  if (missingUpdate?.type !== 'hmr:error' || !missingErrors.some(unresolvedCreated)) {
    throw new StepFailure("the update importing ./created before it exists did not fail on './created'")
  }

  from = server.lines.length
  message = client.nextMessage(quietSeconds)
  writeFileSync(join(app, 'src', 'created.ts'), files.created)
  const createdUpdate = await message
  console.log(`step 3: src/created.ts written: ${describeMessage(createdUpdate, quietSeconds)}`)
  for (const line of await errorLinesSince(from, createdUpdate)) console.log(`  one dev: ${redact(line)}`)

  const relaunch = await fetchBundle(origin)
  console.log(`step 4, a launch: GET /index.bundle?platform=android: ${describeBundle(relaunch)}`)

  from = server.lines.length
  message = client.nextMessage(updateSeconds)
  writeFileSync(join(app, 'src', 'second.ts'), files.second)
  const importerUpdate = await message
  const importerErrors = await errorLinesSince(from, importerUpdate)
  console.log(`step 5: src/second.ts imports ./created: ${describeMessage(importerUpdate, updateSeconds)}`)
  for (const line of importerErrors) console.log(`  one dev: ${redact(line)}`)

  const lastLaunch = await fetchBundle(origin)
  console.log(`step 6, a launch: GET /index.bundle?platform=android: ${describeBundle(lastLaunch)}`)

  const update =
    importerUpdate?.type === 'hmr:update' && importerUpdate.code.includes('repro-created-v1')
      ? 'holds src/created.ts'
      : importerUpdate?.type === 'hmr:error' && importerErrors.some(unresolvedCreated)
        ? "fails: Could not resolve './created'"
        : 'unexpected'
  result = {
    relaunch: judgeBundle(relaunch, ['repro-first-v2', 'repro-second-v1', 'repro-created-v1']),
    update,
    lastLaunch: judgeBundle(lastLaunch, ['repro-first-v2', 'repro-second-v2', 'repro-created-v1']),
  }
} catch (error) {
  failure = error instanceof StepFailure ? error.message : `a step threw: ${error?.stack ?? error}`
}

// Everything the run started or changed is undone before the result, so the result is the last thing printed.
const cleanupNotes = []
const undo = async (what, step) => {
  try {
    await step()
  } catch (error) {
    cleanupNotes.push(`cleanup: ${what}: ${redact(error?.message ?? error)}`)
  }
}
await undo('closing the /hot socket', () => client?.close())
await undo('stopping one dev', () => server?.stop())
if (workspace) {
  await undo('removing the workspace', () => rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }))
}
for (const note of cleanupNotes) console.log(note)

if (result) {
  const defect = result.relaunch === 'from before step 2' || result.update !== 'holds src/created.ts' || result.lastLaunch === 'from before step 2'
  const unexpected = [result.relaunch, result.update, result.lastLaunch].includes('unexpected')
  console.log('')
  console.log(`step 4, a launch once src/created.ts exists: the bundle is ${result.relaunch}`)
  console.log(`step 5, an update importing src/created.ts: ${result.update}`)
  console.log(`step 6, a launch after that update: the bundle is ${result.lastLaunch}`)
  if (unexpected) {
    console.log('a step ended another way than the defect or its fix')
    process.exit(2)
  }
  console.log(defect ? 'one dev served a bundle or an update without src/created.ts after it existed' : 'one dev served src/created.ts once it existed')
  process.exit(defect ? 1 : 0)
}
if (server) {
  console.log("one dev's last lines:")
  for (const line of server.lines.slice(-30)) console.log(`  ${redact(line)}`)
}
console.log(redact(failure))
process.exit(2)
