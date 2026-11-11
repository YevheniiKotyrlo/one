// On Android 11 and earlier, the alarm One sets for a `date` notification may fire hours after its date. repro/ is an app
// on this checkout's one (`workspace:*`) with `native.app.notifications`, whose app/index.tsx schedules a `date`
// notification 24 hours ahead when it loads and logs "repro-scheduled" with that date. The script builds the workspace,
// installs repro/ in a folder outside it from the workspace's packed packages (use-workspace-packages.mjs), prebuilds
// the app's android/, starts `one dev`, and builds and installs the app for the device's ABI with `one run:android`. It
// force-stops the app, which cancels its alarms, opens it, waits for its "repro-scheduled" line in logcat, and reads the
// alarm set for that date from `adb shell dumpsys alarm`. It uninstalls the app and removes the port forward it added
// before it prints the result.
// Needs an Android 11 or earlier device or emulator (API 30 or lower); ANDROID_SERIAL names it when more than one is
// attached, and RCT_METRO_PORT the dev server's port, 8081 otherwise. From the checkout: node repro/reproduce.mjs
// Exits 1 while the alarm may fire more than an hour after its date or does not fire while the device idles, 0 once it
// fires within an hour of its date, idle or not, and 2 when a step fails, the port is taken, the device runs Android 12
// or later, or the app schedules no alarm.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { release, tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'

const port = Number(process.env.RCT_METRO_PORT) || 8081
const scheduledLine = 'repro-scheduled'
const failedLine = 'repro-schedule-failed'
const alarmTag = 'tag=*walarm*:dev.onejs.onenative.NOTIFICATION_ALARM'
const hourMs = 60 * 60 * 1000
// AlarmManager's FLAG_WAKE_FROM_IDLE, FLAG_ALLOW_WHILE_IDLE and FLAG_ALLOW_WHILE_IDLE_UNRESTRICTED (hidden constants).
const firesWhileIdleFlags = 0x2 | 0x4 | 0x8
const lastApiWithLongWindows = 30
const checkout = resolve(import.meta.dirname, '..')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
const adb = sdk ? join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb'
const ansi = /\u001b\[[0-9;]*m/g
const isWindows = process.platform === 'win32'

class StepFailure extends Error {}

// A crash is never the verdict: anything thrown outside the steps below ends the run with 2.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.log(`a step threw: ${error?.stack ?? error}`)
    process.exit(2)
  })
}

let workspace
let serial
// Output names the workspace, the checkout, this node and the device's serial by those words, never by their values on
// this machine, and shows no IPv4 address, such as the LAN address `one dev` prints.
const redact = (text) => {
  let redacted = String(text).replaceAll(process.execPath, 'node')
  if (serial) redacted = redacted.replaceAll(serial, '<serial>')
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

// Runs a command to its end without blocking the event loop, so the server's and logcat's output keeps being read,
// and resolves with what it printed when `capture` is set, or prints each of its lines through redact() otherwise.
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
// output ends or the deadline passes. `tree` stops the child's descendants with it.
const watch = (name, command, args, { tree = false, ...options }) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: tree && !isWindows,
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
    if (tree && isWindows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    try {
      process.kill(tree ? -child.pid : child.pid, signal)
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

const portIsFree = () =>
  new Promise((resolvePort) => {
    const probe = createServer()
    probe.once('error', () => resolvePort(false))
    probe.listen(port, () => probe.close(() => resolvePort(true)))
  })

// Durations as dumpsys prints them (TimeUtils.formatDuration): "0", "+18h2m8s496ms", "+1d17h56m0s83ms".
const durationMs = (text) => {
  if (text === '0') return 0
  const match = /^([+-])(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(text)
  if (!match || match[0].length === 1) return undefined
  const [, sign, days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0] = match
  const total =
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(milliseconds)
  return sign === '-' ? -total : total
}
const hoursAndMinutes = (ms) => `${Math.floor(ms / hourMs)} h ${Math.floor((ms % hourMs) / 60_000)} min`

// Each alarm `dumpsys alarm` lists for the package: its `Alarm{… when <ms> <package>}` line and the lines indented
// below it.
const alarmsOf = (dump, packageName) => {
  const lines = dump.split(/\r?\n/)
  const indentOf = (line) => /^\s*/.exec(line)[0].length
  const alarms = []
  for (let index = 0; index < lines.length; index++) {
    const header = /^\s*\S+ #\d+: Alarm\{\S+ type \d+ when (-?\d+) (\S+)\}$/.exec(lines[index])
    if (!header || header[2] !== packageName) continue
    const block = [lines[index]]
    while (index + 1 < lines.length && lines[index + 1].trim() && indentOf(lines[index + 1]) > indentOf(block[0])) {
      block.push(lines[++index])
    }
    alarms.push({ when: Number(header[1]), lines: block })
  }
  return alarms
}

let env = process.env
let pid
const isAppLine = (line) => pid !== undefined && new RegExp(`^\\w/ReactNativeJS\\(\\s*${pid}\\):`).test(line)
let server
let logcat
let applicationId
let installed = false
let forwarded = false
let failure
let result
try {
  const attached = (await read(adb, ['devices']))
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial)
  serial = process.env.ANDROID_SERIAL || (attached.length === 1 ? attached[0] : undefined)
  if (!serial || !attached.includes(serial)) {
    throw new StepFailure(
      `needs one attached Android device, or ANDROID_SERIAL naming one of the ${attached.length} attached`
    )
  }
  env = { ...process.env, ANDROID_SERIAL: serial }
  const property = (name) => read(adb, ['shell', 'getprop', name], { env })
  const abi = await property('ro.product.cpu.abi')
  const apiLevel = await property('ro.build.version.sdk')
  const device = `${await property('ro.product.manufacturer')} ${await property('ro.product.model')}`
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  const android = `Android ${await property('ro.build.version.release')} (API ${apiLevel})`
  console.log(
    `${process.platform} ${process.arch} ${release()}, node ${process.versions.node}, bun ${bunVersion}, ` +
      `one checkout at ${revision}; ${device}, ${android}, ${abi}`
  )
  if (!(Number(apiLevel) <= lastApiWithLongWindows)) {
    throw new StepFailure(
      `needs Android 11 or earlier (API ${lastApiWithLongWindows} or lower), where an inexact alarm's window grows with ` +
        `the time until it; this device runs ${android}`
    )
  }
  if (!(await portIsFree())) {
    throw new StepFailure(`port ${port}, which the app's debug build loads from, is in use; RCT_METRO_PORT names another`)
  }

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
  applicationId = /applicationId: '([^']+)'/.exec(readFileSync(join(app, 'vite.config.ts'), 'utf8'))?.[1]
  if (!applicationId) throw new StepFailure('repro/vite.config.ts names no native.app.android.applicationId')
  const one = join(app, 'node_modules', 'one', 'run.mjs')
  // repro/vite.config.ts reads the dev server's port from RCT_METRO_PORT, and `one run:android` builds it into the app.
  const oneEnv = { ...env, RCT_METRO_PORT: String(port), NO_COLOR: '1', FORCE_COLOR: '0' }
  await run(process.execPath, [one, 'prebuild', '--platform', 'android'], { cwd: app, env: oneEnv })

  const forwards = await read(adb, ['reverse', '--list'], { env })
  const alreadyForwarded = forwards
    .split('\n')
    .some((line) => line.trim().split(/\s+/).slice(-2).join(' ') === `tcp:${port} tcp:${port}`)
  if (!alreadyForwarded) {
    await run(adb, ['reverse', `tcp:${port}`, `tcp:${port}`], { env })
    forwarded = true
  }
  server = watch('one dev', process.execPath, [one, 'dev', '--port', String(port)], {
    tree: true,
    cwd: app,
    env: oneEnv,
  })
  await server.waitFor(
    '"Server running on" from one dev',
    (lines) => lines.some((line) => line.includes('Server running on')),
    300
  )
  installed = true
  await run(process.execPath, [one, 'run:android'], {
    cwd: app,
    env: {
      ...oneEnv,
      ORG_GRADLE_PROJECT_reactNativeArchitectures: abi,
      // gradlew's /bin/sh can drop a variable whose name has dots, so the Kotlin setting rides in GRADLE_OPTS.
      // Kotlin compiles inside Gradle's JVM, so no Kotlin daemon outlives the run, and that JVM's metaspace is left
      // unbounded: the template's gradle.properties caps it at 512 MiB, which parallel Kotlin compilations run out of.
      GRADLE_OPTS: [
        env.GRADLE_OPTS,
        '-Dorg.gradle.daemon=false',
        '-Dorg.gradle.jvmargs=-Xmx6g',
        '-Dorg.gradle.project.kotlin.compiler.execution.strategy=in-process',
      ]
        .filter(Boolean)
        .join(' '),
    },
  })
  await run(adb, ['shell', 'am', 'force-stop', applicationId], { env })

  // logcat reads from this device time on, so lines written before it attaches are still read.
  const since = await read(adb, ['shell', 'date', '+%s'], { env })
  if (!/^\d+$/.test(since)) throw new StepFailure(`adb shell date +%s printed ${redact(since)}, not a time`)
  logcat = watch('adb logcat', adb, ['logcat', '-T', `${since}.000`, '-v', 'brief', 'ReactNativeJS:V', '*:S'], { env })
  await run(adb, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { env })
  const launch = await read(adb, ['shell', 'am', 'start', '-W', '-n', `${applicationId}/.MainActivity`], { env })
  if (/^Error/m.test(launch)) throw new StepFailure(`adb shell am start -W did not launch the app:\n${redact(launch)}`)
  pid = await read(adb, ['shell', 'pidof', applicationId], { env })
  await logcat.waitFor(
    `"${scheduledLine}" or "${failedLine}" from the app (process ${pid}) in logcat`,
    (lines) => lines.some((line) => isAppLine(line) && (line.includes(scheduledLine) || line.includes(failedLine))),
    300
  )
  const appLines = logcat.lines.filter(isAppLine)
  const failed = appLines.find((line) => line.includes(failedLine))
  if (failed) {
    throw new StepFailure(
      `the app's One.Notifications.schedule call failed: ${redact(failed.slice(failed.indexOf(failedLine)))}`
    )
  }
  const scheduled = appLines.find((line) => line.includes(scheduledLine))
  const date = Number(new RegExp(`${scheduledLine} \\S+ at (\\d+)$`).exec(scheduled)?.[1])
  if (!date) throw new StepFailure(`the app's line names no date: ${redact(scheduled)}`)
  const dump = await read(adb, ['shell', 'dumpsys', 'alarm'], { env })
  const alarm = alarmsOf(dump, applicationId).find(
    (listed) => listed.when === date && listed.lines.some((line) => line.trim() === alarmTag)
  )
  if (!alarm) {
    throw new StepFailure(`adb shell dumpsys alarm lists no alarm of ${applicationId} with ${alarmTag} at ${date}`)
  }
  const text = alarm.lines.join('\n')
  const windowText = /(?:^|\s)window=(\S+)/.exec(text)?.[1]
  const windowMs = windowText === undefined ? undefined : durationMs(windowText)
  const flags = Number.parseInt(/(?:^|\s)flags=0x([0-9a-f]+)/.exec(text)?.[1], 16)
  const localDate = /(?:^|\s)when=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d{3}/.exec(text)?.[1]
  if (windowMs === undefined || Number.isNaN(flags) || !localDate) {
    for (const line of alarm.lines) console.log(redact(line))
    throw new StepFailure("the alarm's window, flags or date did not read")
  }
  result = { appLines, alarm, windowText, windowMs, flags, localDate }
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
await undo('stopping adb logcat', () => logcat?.stop())
if (installed) {
  await undo(`uninstalling ${applicationId}`, async () => {
    const packages = await read(adb, ['shell', 'pm', 'list', 'packages', applicationId], { env })
    if (packages.split('\n').some((line) => line.trim() === `package:${applicationId}`)) {
      await run(adb, ['uninstall', applicationId], { env, capture: true })
    }
  })
}
if (forwarded) {
  await undo(`removing the tcp:${port} forward`, () =>
    run(adb, ['reverse', '--remove', `tcp:${port}`], { env, capture: true })
  )
}
if (workspace) {
  await undo('removing the workspace', () => rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }))
}
for (const note of cleanupNotes) console.log(note)

if (result) {
  const { appLines, alarm, windowText, windowMs, flags, localDate } = result
  const latest = new Date(Date.parse(`${localDate.replace(' ', 'T')}Z`) + windowMs).toISOString().slice(0, 19)
  const late = windowMs > hourMs
  const firesWhileIdle = (flags & firesWhileIdleFlags) !== 0
  console.log('')
  console.log(`adb logcat ReactNativeJS:V, the app's lines (process ${pid}):`)
  for (const line of appLines) console.log(`  ${redact(line)}`)
  console.log('adb shell dumpsys alarm, the alarm set for that date:')
  for (const line of alarm.lines) console.log(redact(line))
  console.log(
    `window=${windowText}: the notification for ${localDate} may post until ${latest.replace('T', ' ')}, ` +
      `${hoursAndMinutes(windowMs)} after its date`
  )
  console.log(`flags=0x${flags.toString(16)}: the alarm ${firesWhileIdle ? 'fires' : 'does not fire'} while the device idles`)
  console.log(
    late
      ? 'the date notification may post more than an hour after its date'
      : firesWhileIdle
        ? 'the date notification posts within an hour of its date, idle or not'
        : 'the date notification waits for the device to leave idle'
  )
  process.exit(late || !firesWhileIdle ? 1 : 0)
}
if (server) {
  console.log("one dev's last lines:")
  for (const line of server.lines.slice(-30)) console.log(`  ${redact(line)}`)
}
if (logcat && pid !== undefined) {
  console.log(`adb logcat ReactNativeJS:V, the app's last lines (process ${pid}):`)
  for (const line of logcat.lines.filter(isAppLine).slice(-30)) console.log(`  ${redact(line)}`)
}
console.log(redact(failure))
process.exit(2)
