// `one dev` leaves React Native's Flow component specs ungenerated in the Android bundle when the app's root resolves
// an older hermes-parser than @vxrn/compiler's own, as eslint-plugin-react-hooks@7.1.1 (hermes-parser ^0.25.1) makes
// it, so React Native warns "Codegen didn't run for PullToRefreshView" at each launch of a debug build. repro/ is an
// app on this checkout's one (`workspace:*`) that renders a RefreshControl and installs eslint-plugin-react-hooks.
// The script builds the workspace, installs repro/ in a folder outside it from the workspace's packed packages
// (use-workspace-packages.mjs), starts `one dev` and fetches /index.bundle?platform=android, as a launch does, with no
// device. From the checkout: node repro/reproduce.mjs
// Exits 1 while a spec reaches the bundle calling codegenNativeComponent, 0 once both carry their generated view
// config, and 2 when a step fails or ends another way.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { release, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const checkout = join(import.meta.dirname, '..')
const ansi = /\u001b\[[0-9;]*m/g
const isWindows = process.platform === 'win32'
const bundleSeconds = 300
const specs = ['PullToRefreshView', 'DebuggingOverlay']

class StepFailure extends Error {}

// A spec's module once its view config is generated, and the call its source makes when it is not.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const generatedPattern = (name) => new RegExp(`uiViewClassName:\\s*["']${escape(name)}["']`)
const runtimeCallPattern = (name) =>
  new RegExp(`codegenNativeComponent[\\w$]*(?:\\.default)?\\)?\\s*\\(\\s*["']${escape(name)}["']`)

export const classifySpec = (bundle, name) => {
  const called = runtimeCallPattern(name).exec(bundle)
  if (called) {
    const lineStart = bundle.lastIndexOf('\n', called.index) + 1
    const lineEnd = bundle.indexOf('\n', called.index + called[0].length)
    const line = bundle.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
    return { verdict: 'called at runtime', evidence: line.length > 160 ? `${line.slice(0, 157)}...` : line }
  }
  const generated = generatedPattern(name).exec(bundle)
  if (generated) return { verdict: 'generated', evidence: generated[0] }
  return { verdict: 'not in the bundle', evidence: '' }
}

// 1 while a spec is called at runtime, 0 once every spec is generated, 2 when one is in neither form.
export const judgeSpecs = (classified) => {
  const verdicts = Object.values(classified).map(({ verdict }) => verdict)
  if (verdicts.includes('not in the bundle')) return 2
  return verdicts.includes('called at runtime') ? 1 : 0
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

const reproduce = async () => {
  let server
  let failure
  let classified
  try {
    const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
    const bunVersion = await read('bun', ['--version'])
    console.log(
      `${process.platform} ${process.arch} ${release()}, node ${process.versions.node}, bun ${bunVersion}, one checkout at ${revision}`
    )

    await run('bun', ['install'], { cwd: checkout })
    await run('bun', ['run', 'build'], { cwd: checkout })
    workspace = mkdtempSync(join(tmpdir(), 'ocg-'))
    const app = join(workspace, 'app')
    const source = join(checkout, 'repro')
    const generated = new Set(['node_modules', 'tmp', 'android', 'ios', 'dist', '.yarn', 'yarn.lock'])
    cpSync(source, app, {
      recursive: true,
      filter: (path) => !generated.has(relative(source, path).split(sep)[0]),
    })
    await run(process.execPath, [join(checkout, 'repro', 'use-workspace-packages.mjs'), app], { cwd: checkout })
    await run('bun', ['install'], { cwd: app })

    const manifestOf = (name, from) => createRequire(join(from, 'package.json')).resolve(`${name}/package.json`)
    const versionAt = (manifest) => JSON.parse(readFileSync(manifest, 'utf8')).version
    const compilerFolder = dirname(manifestOf('@vxrn/compiler', dirname(manifestOf('vxrn', app))))
    const rootParser = versionAt(manifestOf('hermes-parser', app))
    const compilerParser = versionAt(createRequire(join(compilerFolder, 'package.json')).resolve('hermes-parser/package.json'))
    console.log(
      `installed: one ${versionAt(manifestOf('one', app))}, @vxrn/compiler ${versionAt(join(compilerFolder, 'package.json'))}, react-native ${versionAt(manifestOf('react-native', app))}, eslint-plugin-react-hooks ${versionAt(manifestOf('eslint-plugin-react-hooks', app))}`
    )
    console.log(`hermes-parser the app's root resolves: ${rootParser}; the one @vxrn/compiler depends on: ${compilerParser}`)
    if (rootParser === compilerParser) {
      throw new StepFailure(`the app's root resolves @vxrn/compiler's own hermes-parser ${compilerParser}, not an older one`)
    }

    const port = await freePort()
    const origin = `http://localhost:${port}`
    server = watch('one dev', process.execPath, [join(app, 'node_modules', 'one', 'run.mjs'), 'dev', '--port', String(port)], {
      cwd: app,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    await server.waitFor('"Server running on" from one dev', (lines) => lines.some((line) => line.includes('Server running on')), 300)

    const response = await fetch(`${origin}/index.bundle?platform=android&dev=true&minify=false`, {
      signal: AbortSignal.timeout(bundleSeconds * 1000),
    }).catch((error) => {
      throw new StepFailure(`GET /index.bundle?platform=android failed: ${error.message}`)
    })
    const bundle = await response.text()
    console.log(`a launch: GET /index.bundle?platform=android: ${response.status}, ${Buffer.byteLength(bundle)} bytes`)
    if (response.status !== 200) throw new StepFailure(`the bundle answered ${response.status}`)
    classified = Object.fromEntries(specs.map((name) => [name, classifySpec(bundle, name)]))
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
  await undo('stopping one dev', () => server?.stop())
  if (workspace) {
    await undo('removing the workspace', () => rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }))
  }
  for (const note of cleanupNotes) console.log(note)

  if (classified) {
    console.log('')
    for (const [name, { verdict, evidence }] of Object.entries(classified)) {
      console.log(`the ${name} spec in the Android bundle: ${verdict}${evidence ? ` — ${redact(evidence)}` : ''}`)
    }
    const status = judgeSpecs(classified)
    if (status === 2) {
      console.log('a spec is in neither form: the bundle ended another way than the defect or its fix')
    } else {
      console.log(
        status === 1
          ? 'one dev serves a React Native spec that calls codegenNativeComponent at runtime'
          : "one dev serves React Native's specs with their generated view configs"
      )
    }
    return status
  }
  if (server) {
    console.log("one dev's last lines:")
    for (const line of server.lines.slice(-30)) console.log(`  ${redact(line)}`)
  }
  console.log(redact(failure))
  return 2
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A crash is never the verdict: anything thrown outside the steps ends the run with 2.
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (error) => {
      console.log(`a step threw: ${error?.stack ?? error}`)
      process.exit(2)
    })
  }
  process.exit(await reproduce())
}
