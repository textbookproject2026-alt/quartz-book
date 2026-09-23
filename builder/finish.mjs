// Step 3 of build-book.sh: what the builder adds to Quartz's output, then the
// check that the output holds nothing it shouldn't.
//
//   node builder/finish.mjs <work dir> <out dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import {
  HOW_TO_COMMENT,
  MARKER_PATH,
  NOINDEX_HEADERS,
  addCanonical,
  htmlUrl,
  marker,
  outputAllowed,
  redirectsFile,
  strayMessage,
  stripControls,
  walkFiles,
} from "./lib.mjs"

const [workDir, outDir] = process.argv.slice(2)
const facts = JSON.parse(readFileSync(join(workDir, "facts.json"), "utf8"))

const rel = (file) => relative(outDir, file).split(sep).join("/")
const write = (path, text) => {
  mkdirSync(dirname(join(outDir, path)), { recursive: true })
  writeFileSync(join(outDir, path), text)
}

// Every page's source and slug, from Quartz's own content index, so the
// redirects use Quartz's slugs rather than a copy of its slug rules.
const index = JSON.parse(readFileSync(join(outDir, "static/contentIndex.json"), "utf8"))
// Folder and tag listings have a filePath too, but no file: Publish never had them.
const pages = Object.entries(index)
  .filter(([, v]) => v.filePath && v.filePath !== `${HOW_TO_COMMENT}.md`)
  .filter(([, v]) => existsSync(join(workDir, "content", v.filePath)))
  .map(([slug, v]) => ({ relPath: v.filePath, slug }))
if (pages.length === 0) throw new Error("Quartz's content index lists no pages.")

for (const file of walkFiles(outDir)) {
  const path = rel(file)
  const url = htmlUrl(path)
  if (!url) continue
  let html = readFileSync(file, "utf8")
  html = addCanonical(html, facts.domain, url)
  if (path === `${HOW_TO_COMMENT}.html`) html = stripControls(html)
  writeFileSync(file, html)
}

write("_redirects", redirectsFile(pages, facts))
if (facts.noindex) write("_headers", NOINDEX_HEADERS)
write(MARKER_PATH, JSON.stringify(marker(facts), null, 2) + "\n")

// The allowlist, checked on what was actually produced (§8 step 8): a file from
// outside it fails the build rather than going live.
const files = walkFiles(outDir).map(rel)
const stray = files.filter((p) => !outputAllowed(p))
if (stray.length) {
  console.error(`build-book: refused: ${strayMessage(stray)}`)
  process.exit(2)
}
console.log(`finish: ${files.length} files, ${pages.length} pages; marker at /${MARKER_PATH}`)
