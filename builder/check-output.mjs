// The allowlist check on its own, for a site already built:
//
//   node builder/check-output.mjs <out dir>
//
// build-book.sh runs the same check at the end of every build. CI also runs it
// on a copy of book one's output with configure.mjs, LICENSE and admin/ added,
// to show that the check fails when they are there.
import { relative, sep } from "node:path"
import { outputAllowed, strayMessage, walkFiles } from "./lib.mjs"

const [outDir] = process.argv.slice(2)
if (!outDir) {
  console.error("usage: check-output.mjs <out dir>")
  process.exit(1)
}
const files = walkFiles(outDir).map((f) => relative(outDir, f).split(sep).join("/"))
const stray = files.filter((p) => !outputAllowed(p))
if (stray.length) {
  console.error(`check-output: ${strayMessage(stray)}`)
  process.exit(2)
}
console.log(`check-output: ${files.length} files, all allowlisted or generated`)
