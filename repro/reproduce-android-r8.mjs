// One's Android library declares androidx.work:work-runtime-ktx:2.9.0, which brings androidx.room:room-runtime:2.5.0.
// That Room's consumer rule keeps `class * extends androidx.room.RoomDatabase` with no members, so R8's full mode
// (Android Gradle Plugin's default) removes WorkDatabase_Impl's no-argument constructor, which Room calls by
// reflection, and an app built with `native.app.android.minify` crashes at launch in WorkManagerInitializer.
// repro/ is an app on this checkout's one (`workspace:*`) whose vite.config.ts sets `android.minify: true` and nothing
// else native. The script builds the workspace, installs repro/ outside it from the workspace's packed packages
// (use-workspace-packages.mjs), runs `one prebuild --platform android`, prints the Room that Gradle resolves for the
// release build, builds `assembleRelease` for the device's ABI, installs the APK on the one device adb sees (or the
// one ANDROID_SERIAL names), launches it and reads the device's crash log. It removes the app's folder and uninstalls
// the app before it prints the result.
// Needs a JDK, the Android SDK (ANDROID_HOME) and a connected device or emulator. From the checkout:
// node repro/reproduce-android-r8.mjs
// Exits 1 while the app crashes at launch failing to create WorkDatabase, 0 once it launches and stays up, and 2 when
// a step fails or it crashes another way.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const checkout = resolve(import.meta.dirname, '..')
const applicationId = 'dev.onestack.repro'
const isWindows = process.platform === 'win32'
const WORK_DATABASE_FAILURE = 'Failed to create an instance of class androidx.work.impl.WorkDatabase'

class StepFailure extends Error {}

// The verdict on what the device showed after the launch: the crash buffer's text and whether the app's process
// was still running a few seconds later.
export const judge = ({ crashLog, running }) => {
  const fatal = crashLog
    .split('\n')
    .filter((line) => line.includes(`Process: ${applicationId}`) || line.includes('FATAL EXCEPTION'))
  if (crashLog.includes(WORK_DATABASE_FAILURE)) {
    return {
      exitCode: 1,
      verdict: `the minified release build crashes at launch: "${WORK_DATABASE_FAILURE}.canonicalName" in WorkManagerInitializer`,
    }
  }
  if (fatal.length > 0) {
    return { exitCode: 2, verdict: `the app crashed at launch another way: ${fatal.join(' / ')}` }
  }
  if (!running) return { exitCode: 2, verdict: 'the app was not running after its launch, with no crash logged' }
  return { exitCode: 0, verdict: 'the minified release build launched and was still running 8 seconds later' }
}

let workspace
const redact = (text) => {
  let redacted = String(text).replaceAll(process.execPath, 'node')
  for (const [path, name] of [
    [workspace, '<workspace>'],
    [checkout, '<checkout>'],
  ]) {
    if (path) {
      redacted = redacted.replaceAll(path, name).replaceAll(path.replaceAll('\\', '/'), name)
    }
  }
  return redacted.replaceAll(/\/(home|Users)\/[^/\s]+\//g, '~/').replaceAll(/[A-Z]:\\Users\\[^\\\s]+\\/g, '~\\')
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

// Runs a command to its end and returns what it printed, failing the step when it exits non-zero.
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
      code === 0
        ? resolveRead(printed.replaceAll('\r\n', '\n').trim())
        : rejectRead(new StepFailure(`${redact([command, ...args].join(' '))} exited ${code}: ${redact(printed.slice(-2000))}`))
    )
  })

// Each adb call ends within five minutes, so a call the device never answers fails the step.
const adb = (...args) => read('adb', args, { timeout: 300_000 })

const gradle = (android, args, environment) =>
  isWindows
    ? ['cmd.exe', ['/d', '/s', '/c', `.\\gradlew.bat ${args.join(' ')}`], { cwd: android, env: environment }]
    : ['sh', ['./gradlew', ...args], { cwd: android, env: environment }]

const reproduce = async () => {
  if (!process.env.ANDROID_HOME) throw new StepFailure('needs the Android SDK named by ANDROID_HOME')
  const revision = await read('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: checkout })
  const bunVersion = await read('bun', ['--version'])
  const java = (await read('java', ['-version'])).split('\n')[0]
  const abi = await adb('shell', 'getprop', 'ro.product.cpu.abi')
  const device = `${await adb('shell', 'getprop', 'ro.product.model')}, Android ${await adb('shell', 'getprop', 'ro.build.version.release')}, ${abi}`
  console.log(
    `${process.platform} ${release()} (${process.arch}), node ${process.versions.node}, bun ${bunVersion}, ` +
      `one checkout at ${revision}; ${java}; device: ${device}`
  )
  const oneGradle = readFileSync(join(checkout, 'packages', 'one', 'android', 'build.gradle'), 'utf8')
  console.log(`packages/one/android/build.gradle: ${/^\s*(implementation\s+"androidx\.work:[^"]+")/m.exec(oneGradle)?.[1]}`)

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

  const android = join(app, 'android')
  const appGradle = readFileSync(join(android, 'app', 'build.gradle'), 'utf8')
  console.log(`repro/vite.config.ts native.app.android: ${/android: (\{[^}]*\})/.exec(readFileSync(join(app, 'vite.config.ts'), 'utf8'))?.[1]}`)
  console.log(`android/app/build.gradle: ${/^\s*(def enableProguardInReleaseBuilds = \w+)/m.exec(appGradle)?.[1]}`)

  const dependencies = await read(...gradle(android, [':app:dependencies', '--configuration', 'releaseRuntimeClasspath', '--console=plain', '--quiet'], environment))
  const chain = dependencies
    .split('\n')
    .filter((line) => /androidx\.work:work-runtime(-ktx)?:|androidx\.room:room-runtime(-android)?:/.test(line))
  console.log('./gradlew :app:dependencies --configuration releaseRuntimeClasspath (work-runtime and room-runtime):')
  for (const line of [...new Set(chain.map((line) => line.trim()))].slice(0, 6)) console.log(`  ${line}`)

  console.log(`./gradlew assembleRelease -PreactNativeArchitectures=${abi}`)
  await run(...gradle(android, ['assembleRelease', `-PreactNativeArchitectures=${abi}`, '--console=plain', '--quiet'], environment))
  const apk = join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  if (!existsSync(apk)) throw new StepFailure('Gradle wrote no app-release.apk')
  const mapping = join(android, 'app', 'build', 'outputs', 'mapping', 'release', 'mapping.txt')
  console.log(`R8 ran: ${existsSync(mapping) ? 'app/build/outputs/mapping/release/mapping.txt written' : 'no mapping.txt'}`)

  await adb('install', '-r', apk)
  console.log(`installed ${redact(relative(android, apk))}`)
  const activity = (await adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', applicationId)).split('\n').pop()
  await adb('logcat', '-b', 'crash', '-c')
  console.log(`adb shell am start -n ${activity}`)
  for (const line of (await adb('shell', 'am', 'start', '-n', activity)).split('\n')) console.log(`  ${line.trim()}`)
  await sleep(8000)
  const running = (await adb('shell', `pidof ${applicationId} || true`)).length > 0
  const crashLog = await adb('logcat', '-d', '-b', 'crash')
  console.log(`process running 8 seconds after the launch: ${running ? 'yes' : 'no'}`)
  const crashLines = crashLog.split('\n').filter((line) => / E AndroidRuntime: (FATAL|Process|java\.|Caused by|androidx)/.test(line))
  if (crashLines.length > 0) {
    console.log('adb logcat -d -b crash:')
    for (const line of crashLines.slice(0, 12)) console.log(`  ${line.replace(/^.* E AndroidRuntime: /, 'E AndroidRuntime: ')}`)
  }
  await adb('uninstall', applicationId).catch(() => {})
  return judge({ crashLog, running })
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
    if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
  console.log(`verdict: ${outcome.verdict}`)
  process.exitCode = outcome.exitCode
}
