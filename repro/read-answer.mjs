// Reads Metro's answer to the Android bundle request, from the file the first argument names with the HTTP status the
// second gives, and prints what it says about the error: its type, name, file, line and column, and its message's
// first line.
// Exits 1 while the answer to app/index.tsx's syntax error lacks the file, the line or the column, 0 once it names
// app/index.tsx, line 4 and a column, and 2 when the answer is not that syntax error.
import { readFileSync } from 'node:fs'

const [file, status] = process.argv.slice(2)
const text = readFileSync(file, 'utf8')
let body
try {
  body = JSON.parse(text)
} catch {
  console.log(`the answer (${status}) is not JSON: ${text.slice(0, 200)}`)
  process.exit(2)
}
const shown = (value) => (value === undefined ? 'none' : JSON.stringify(value))
console.log(
  `type ${body.type}, name ${body.name}, filename ${shown(body.filename)}, lineNumber ${shown(body.lineNumber)}, column ${shown(body.column)}`
)
console.log(`message: ${String(body.message).split('\n')[0]}`)
if (status !== '500' || body.type !== 'TransformError' || !/index\.tsx/.test(body.message ?? '')) {
  console.log("this is not Metro's answer to the syntax error in app/index.tsx")
  process.exit(2)
}
const placed =
  typeof body.filename === 'string' &&
  /(^|[\\/])app[\\/]index\.tsx$/.test(body.filename) &&
  body.lineNumber === 4 &&
  Number.isInteger(body.column)
process.exit(placed ? 0 : 1)
