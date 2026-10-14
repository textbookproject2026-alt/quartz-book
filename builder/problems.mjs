// A book's problems: a part of its build that failed but isn't needed to serve
// the text (a download, the page histories, the credits, the pages' preview
// images). The site still builds and deploys without that part; each problem is
// a GitHub warning and a line in the marker's `problems`, which builder-alive (in
// textbook-registry) reads from every book, so a failing part is reported
// without holding up anything.
//
//   node builder/problems.mjs <work dir> <out dir>   (build-book.sh, last step)
//   node builder/problems.mjs --note <work dir> <step> <message>
//
// The first adds the problems noted in <work dir>/problems.json to the marker;
// the second notes one, for build-book.sh's own steps.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MARKER_PATH } from "./lib.mjs"

const fileOf = (workDir) => join(workDir, "problems.json")
const read = (workDir) =>
  existsSync(fileOf(workDir)) ? JSON.parse(readFileSync(fileOf(workDir), "utf8")) : []

/** Notes a problem: `step` (export, history, credits, og-image) and what failed, in plain words. */
export function noteProblem(workDir, step, message) {
  console.log(`::warning title=${step}::${message}`)
  writeFileSync(fileOf(workDir), JSON.stringify([...read(workDir), { step, message }]) + "\n")
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "--note") {
  const [workDir, step, message] = process.argv.slice(3)
  noteProblem(workDir, step, message)
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const [workDir, outDir] = process.argv.slice(2)
  const file = join(outDir, MARKER_PATH)
  const marker = JSON.parse(readFileSync(file, "utf8"))
  marker.problems = read(workDir)
  writeFileSync(file, JSON.stringify(marker, null, 2) + "\n")
  console.log(`problems: ${marker.problems.length || "none"}`)
}
