// Preloaded with NODE_OPTIONS=--require: counts the fs.watch calls the process makes and prints the count as it exits.
const fs = require('node:fs')

const watch = fs.watch
let calls = 0
fs.watch = function countedWatch(...parameters) {
  calls += 1
  return watch.apply(this, parameters)
}
process.on('exit', () => {
  process.stderr.write(`fs.watch calls: ${calls}\n`)
})
