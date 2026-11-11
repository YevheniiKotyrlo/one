// After the app is force-stopped, a notification One scheduled on Android never posts, while getAllScheduled still lists
// it. repro/ is an app on this checkout's one (`workspace:*`) with `native.app.notifications`; as it loads, its
// app/index.tsx logs "repro-listed" with the date when getAllScheduled lists its notification, and otherwise schedules a
// `date` notification a minute ahead and logs "repro-scheduled" with that date.
// The script builds the workspace, installs repro/ outside it from the workspace's packed packages
// (use-workspace-packages.mjs), prebuilds android/, starts `one dev`, and builds and installs the app for the device's
// ABI with `one run:android`. It force-stops the app, clears its data and opens it, and the notification has to post by
// a minute past its alarm's latest delivery. It force-stops the app and opens it, so it schedules the notification anew,
// force-stops it again, opens it, and reads `adb shell dumpsys notification` a minute past that alarm's latest delivery.
// It uninstalls the app and removes the port forward it added before it prints the result.
// Needs an Android device or emulator; ANDROID_SERIAL names it when more than one is attached, and RCT_METRO_PORT the
// dev server's port, 8081 otherwise. From the checkout: node repro/reproduce.mjs
// Exits 1 while the notification getAllScheduled lists does not post after the force stop, 0 once it posts or
// getAllScheduled stops listing it, and 2 when a step fails, the port is taken, the notification does not post without a
// force stop, or a force stop leaves the app's alarm or notification in place.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { release, tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

const port = Number(process.env.RCT_METRO_PORT) || 8081
const identifier = 'repro-force-stop'
const scheduledLine = 'repro-scheduled'
const listedLine = 'repro-listed'
const failedLine = 'repro-failed'
const alarmTag = 'tag=*walarm*:dev.onejs.onenative.NOTIFICATION_ALARM'
const firstApiWithNotificationPermission = 33
const postingGraceMs = 60_000
const pollMs = 5_000
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

// Durations as dumpsys prints them (TimeUtils.formatDuration): "0", "+45s0ms", "+1d17h56m0s83ms".
const durationMs = (text) => {
  if (text === '0') return 0
  const match = /^([+-])(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(text)
  if (!match || match[0].length === 1) return undefined
  const [, sign, days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0] = match
  const total =
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(milliseconds)
  return sign === '-' ? -total : total
}

// Each alarm `dumpsys alarm` lists for the package, `Alarm{… when <ms> <package>}` through Android 11 and
// `Alarm{… origWhen <ms> whenElapsed <ms> <package>}` from Android 12, with the lines indented below it.
const alarmsOf = (dump, packageName) => {
  const lines = dump.split(/\r?\n/)
  const indentOf = (line) => /^\s*/.exec(line)[0].length
  const alarms = []
  for (let index = 0; index < lines.length; index++) {
    const header = /^\s*\S+ #\d+: Alarm\{\S+ type \d+ (?:when|origWhen) (-?\d+)(?: whenElapsed -?\d+)? (\S+)\}$/.exec(
      lines[index]
    )
    if (!header || header[2] !== packageName) continue
    const block = [lines[index]]
    while (index + 1 < lines.length && lines[index + 1].trim() && indentOf(lines[index + 1]) > indentOf(block[0])) {
      block.push(lines[++index])
    }
    alarms.push({ when: Number(header[1]), lines: block })
  }
  return alarms
}

// Each notification `dumpsys notification` holds for the package, as its `NotificationRecord(…)` line.
const notificationsOf = (dump, packageName) =>
  dump
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^NotificationRecord\(0x[0-9a-f]+: pkg=(\S+) /.exec(line)?.[1] === packageName)

let env = process.env
let server
let logcat
let applicationId
let installed = false
let forwarded = false
let failure
let result
const appLines = []
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
  const shell = (...args) => read(adb, ['shell', ...args], { env })
  const abi = await shell('getprop', 'ro.product.cpu.abi')
  const apiLevel = Number(await shell('getprop', 'ro.build.version.sdk'))
  const device = `${await shell('getprop', 'ro.product.manufacturer')} ${await shell('getprop', 'ro.product.model')}`
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  const android = `Android ${await shell('getprop', 'ro.build.version.release')} (API ${apiLevel})`
  console.log(
    `${process.platform} ${process.arch} ${release()}, node ${process.versions.node}, bun ${bunVersion}, ` +
      `one checkout at ${revision}; ${device}, ${android}, ${abi}`
  )
  if (!(await portIsFree())) {
    throw new StepFailure(`port ${port}, which the app's debug build loads from, is in use; RCT_METRO_PORT names another`)
  }

  await run('bun', ['install'], { cwd: checkout })
  await run('bun', ['run', 'build'], { cwd: checkout })
  workspace = mkdtempSync(join(tmpdir(), 'ofs-'))
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

  const forceStop = () => run(adb, ['shell', 'am', 'force-stop', applicationId], { env })
  const notificationAlarms = (dump) =>
    alarmsOf(dump, applicationId).filter((alarm) => alarm.lines.some((line) => line.trim() === alarmTag))
  const readAlarms = async () => {
    const dump = await shell('dumpsys', 'alarm')
    return { dump, readAt: Date.now(), alarms: notificationAlarms(dump) }
  }
  const notifications = async () => notificationsOf(await shell('dumpsys', 'notification'), applicationId)
  // The alarm a read lists for a date, with the device's offset from UTC, how far the device's clock runs ahead of this
  // machine's, and the latest the system delivers it.
  const alarmAt = ({ dump, readAt, alarms }, date) => {
    const alarm = alarms.find((listed) => listed.when === date)
    if (!alarm) return undefined
    const text = alarm.lines.join('\n')
    const nowRtc = Number(/(?:^|\s)nowRTC=(\d+)=/.exec(dump)?.[1])
    const latestText = /(?:^|\s)maxWhenElapsed=(\S+)/.exec(text)?.[1]
    const latestInMs = latestText === undefined ? undefined : durationMs(latestText)
    const localDate = /(?:^|\s)(?:when|origWhen)=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})/.exec(text)?.[1]
    if (!nowRtc || latestInMs === undefined || !localDate) {
      for (const line of alarm.lines) console.log(redact(line))
      throw new StepFailure("the alarm's date or latest delivery did not read")
    }
    return {
      lines: alarm.lines,
      zoneOffsetMs: Date.parse(`${localDate.replace(' ', 'T')}Z`) - date,
      deviceAheadMs: nowRtc - readAt,
      latest: nowRtc + latestInMs,
    }
  }
  const requireAlarmAt = async (date) => {
    const alarm = alarmAt(await readAlarms(), date)
    if (!alarm) throw new StepFailure(`adb shell dumpsys alarm lists no alarm of ${applicationId} with ${alarmTag} at ${date}`)
    return alarm
  }
  // The app's notifications once one is posted, or once the device's clock passes the deadline.
  const postedBy = async (deadline, deviceAheadMs) => {
    for (;;) {
      const posted = await notifications()
      const at = Date.now() + deviceAheadMs
      if (posted.length > 0 || at >= deadline) return { posted, at }
      await sleep(Math.min(pollMs, deadline - at))
    }
  }

  // `one run:android` opened the app, which scheduled its notification, so the run starts from cleared data.
  await forceStop()
  const cleared = await shell('pm', 'clear', applicationId)
  if (!/^Success$/m.test(cleared)) throw new StepFailure(`adb shell pm clear ${applicationId} printed ${redact(cleared)}`)
  if (apiLevel >= firstApiWithNotificationPermission) {
    await read(adb, ['shell', 'pm', 'grant', applicationId, 'android.permission.POST_NOTIFICATIONS'], { env })
  }
  if ((await readAlarms()).alarms.length > 0) {
    throw new StepFailure(`after adb shell am force-stop and pm clear, adb shell dumpsys alarm lists an alarm of ${applicationId}`)
  }
  if ((await notifications()).length > 0) {
    throw new StepFailure(
      `after adb shell am force-stop and pm clear, adb shell dumpsys notification lists a notification of ${applicationId}`
    )
  }

  // logcat reads from this device time on, so lines written before it attaches are still read.
  const since = await shell('date', '+%s')
  if (!/^\d+$/.test(since)) throw new StepFailure(`adb shell date +%s printed ${redact(since)}, not a time`)
  logcat = watch('adb logcat', adb, ['logcat', '-T', `${since}.000`, '-v', 'brief', 'ReactNativeJS:V', '*:S'], { env })
  const open = async () => {
    const from = logcat.lines.length
    await run(adb, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { env })
    const launch = await read(adb, ['shell', 'am', 'start', '-W', '-n', `${applicationId}/.MainActivity`], { env })
    if (/^Error/m.test(launch)) throw new StepFailure(`adb shell am start -W did not launch the app:\n${redact(launch)}`)
    const pid = (await shell('pidof', applicationId)).split(/\s+/)[0]
    const answers = new RegExp(`^\\w/ReactNativeJS\\(\\s*${pid}\\): (?:${scheduledLine}|${listedLine}|${failedLine}) `)
    await logcat.waitFor(
      `"${scheduledLine}", "${listedLine}" or "${failedLine}" from the app (process ${pid}) in logcat`,
      (lines) => lines.slice(from).some((line) => answers.test(line)),
      300
    )
    const line = logcat.lines.slice(from).find((logged) => answers.test(logged))
    appLines.push(line)
    if (line.includes(`${failedLine} `)) {
      throw new StepFailure(`the app's One.Notifications call failed: ${redact(line.slice(line.indexOf(failedLine)))}`)
    }
    const answer = new RegExp(`(${scheduledLine}|${listedLine}) ${identifier} at (\\d+)$`).exec(line)
    if (!answer) throw new StepFailure(`the app's line names no date: ${redact(line)}`)
    return { listed: answer[1] === listedLine, date: Number(answer[2]) }
  }

  const first = await open()
  if (first.listed) throw new StepFailure(`after adb shell pm clear, getAllScheduled lists ${identifier}`)
  const firstAlarm = await requireAlarmAt(first.date)
  const firstPosted = await postedBy(firstAlarm.latest + postingGraceMs, firstAlarm.deviceAheadMs)
  const at = (ms) => new Date(ms + firstAlarm.zoneOffsetMs).toISOString().slice(11, 19)
  if (firstPosted.posted.length === 0) {
    throw new StepFailure(
      `without a force stop, the notification for ${at(first.date)} did not post by ${at(firstPosted.at)}, a minute ` +
        `past its alarm's latest delivery, so this device cannot show what a force stop changes`
    )
  }

  await forceStop()
  if ((await notifications()).length > 0) {
    throw new StepFailure(`adb shell am force-stop left the app's notification in place`)
  }
  const second = await open()
  if (second.listed) {
    throw new StepFailure(`getAllScheduled still lists ${identifier} for ${at(second.date)}, which posted at ${at(firstPosted.at)}`)
  }
  const secondAlarm = await requireAlarmAt(second.date)

  await forceStop()
  if ((await readAlarms()).alarms.length > 0) {
    throw new StepFailure(`adb shell am force-stop left the app's alarm in place, so this device cannot show the defect`)
  }

  const third = await open()
  const reopened = await readAlarms()
  const rearmed = third.listed ? alarmAt(reopened, third.date) : undefined
  const thirdPosted = third.listed
    ? await postedBy(Math.max(secondAlarm.latest, rearmed?.latest ?? 0) + postingGraceMs, secondAlarm.deviceAheadMs)
    : undefined
  result = { first, firstPosted, second, secondAlarm, third, reopened, thirdPosted, at }
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
  const { first, firstPosted, second, secondAlarm, third, reopened, thirdPosted, at } = result
  const noAlarm = `adb shell dumpsys alarm lists no alarm of ${applicationId}`
  console.log('')
  console.log("adb logcat ReactNativeJS:V, the app's lines:")
  for (const line of appLines) console.log(`  ${redact(line)}`)
  console.log(
    `1. opened: the app schedules its notification for ${at(first.date)}, and at ${at(firstPosted.at)} ` +
      'adb shell dumpsys notification lists it:'
  )
  for (const line of firstPosted.posted) console.log(`    ${redact(line)}`)
  console.log(
    `2. adb shell am force-stop ${applicationId}, then opened: the app schedules its notification for ` +
      `${at(second.date)}, and adb shell dumpsys alarm lists its alarm:`
  )
  for (const line of secondAlarm.lines) console.log(redact(line))
  console.log(`3. adb shell am force-stop ${applicationId}: ${noAlarm}`)
  if (!third.listed) {
    console.log(`4. opened: getAllScheduled lists no ${identifier}, so the app schedules it for ${at(third.date)}`)
    console.log('after a force stop, getAllScheduled stops listing the notification, and the app schedules it again')
    process.exit(0)
  }
  const alarmsNow =
    reopened.alarms.length === 0
      ? noAlarm
      : `adb shell dumpsys alarm lists its alarm for ${reopened.alarms.map((alarm) => at(alarm.when)).join(', ')}`
  console.log(`4. opened: getAllScheduled lists ${identifier} for ${at(third.date)}, so the app leaves it, and ${alarmsNow}`)
  const posted = thirdPosted.posted.length > 0
  if (posted) {
    console.log(`5. at ${at(thirdPosted.at)} adb shell dumpsys notification lists it:`)
    for (const line of thirdPosted.posted) console.log(`    ${redact(line)}`)
  } else {
    console.log(
      `5. at ${at(thirdPosted.at)}, a minute past ${at(secondAlarm.latest)}, the latest delivery of the alarm in 2, ` +
        `adb shell dumpsys notification lists no notification of ${applicationId}`
    )
  }
  console.log(
    posted
      ? 'after a force stop, the notification getAllScheduled lists posts at its date'
      : 'after a force stop, the notification getAllScheduled lists never posts'
  )
  process.exit(posted ? 0 : 1)
}
if (server) {
  console.log("one dev's last lines:")
  for (const line of server.lines.slice(-30)) console.log(`  ${redact(line)}`)
}
if (logcat) {
  console.log("adb logcat ReactNativeJS:V, the app's lines:")
  for (const line of appLines) console.log(`  ${redact(line)}`)
}
console.log(redact(failure))
process.exit(2)
