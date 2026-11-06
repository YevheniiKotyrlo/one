// Preloaded through NODE_OPTIONS into every Node process `one dev` starts, Metro's transform workers among them: logs
// each process as it starts, its first load of One's Metro transformer, and every load of babel-preset-expo.
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'

const record = (line) => appendFileSync(process.env.LOAD_TRACE_LOG, `pid=${process.pid} ${line}\n`)
record(`started ${process.argv[1] ?? ''}`)
let transformerLoaded = false
registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('babel-preset-expo')) record(`loaded ${url}`)
    if (!transformerLoaded && url.includes('vite-plugin-metro') && url.includes('metroNativeWorker')) {
      transformerLoaded = true
      record(`transformer ${url}`)
    }
    return nextLoad(url, context)
  },
})
