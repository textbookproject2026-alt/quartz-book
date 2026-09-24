// The design preview (BOOK-ONE-TO-QUARTZ §4b, §8 step 11): every book on the
// builder, built from its live branch by a pull request's builder commit, on
// its Pages project's `design-<pr>` branch. Production is never touched.
//
//   node builder/preview.mjs plan <pr>
//       The books to preview. Writes `targets`, a JSON list for the per-book
//       matrix, to $GITHUB_OUTPUT.
//
//   node builder/preview.mjs comment <pr> <builder commit>
//       Reads the marker each preview serves, and writes the pull request's
//       comment to $RUNNER_TEMP/preview-comment.md (the system temp dir
//       outside Actions). Exits 1 when a preview doesn't serve this builder
//       commit, after writing the comment.
//
// Environment: REGISTRY_FILE, a local registry.json instead of the registry's
// main (tests); SERVED_FILE, a JSON list of markers instead of fetching them
// (tests).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MARKER_PATH, REGISTRY_URL, previewComment, previewTargets } from "./lib.mjs"

const output = (name, value) => {
  const line = `${name}=${value}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
  else process.stdout.write(line)
}

async function readRegistry() {
  if (process.env.REGISTRY_FILE) return JSON.parse(readFileSync(process.env.REGISTRY_FILE, "utf8"))
  const res = await fetch(REGISTRY_URL)
  if (!res.ok) throw new Error(`fetching the registry from ${REGISTRY_URL} answered ${res.status}.`)
  return res.json()
}

async function servedMarker(url) {
  try {
    const res = await fetch(`${url}${MARKER_PATH}?preview=${Date.now()}`, {
      headers: { "cache-control": "no-cache" },
    })
    return res.ok ? JSON.parse(await res.text()) : null
  } catch {
    return null
  }
}

async function plan([pr]) {
  const targets = previewTargets(await readRegistry(), pr)
  for (const t of targets) console.log(`${t.slug}: ${t.branch} → ${t.url}`)
  output("targets", JSON.stringify(targets))
}

async function comment([pr, head]) {
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) throw new Error(`"${head}" is not a builder commit.`)
  const targets = previewTargets(await readRegistry(), pr)
  const served = process.env.SERVED_FILE
    ? JSON.parse(readFileSync(process.env.SERVED_FILE, "utf8"))
    : await Promise.all(targets.map((t) => servedMarker(t.url)))
  const body = previewComment({ pr, head, targets, served })
  writeFileSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "preview-comment.md"), body)
  console.log(body)
  const missing = targets.filter(
    (t, i) => served[i]?.slug !== t.slug || served[i]?.builder_commit !== head,
  )
  if (missing.length) {
    console.error(`preview: no preview of ${missing.map((t) => t.slug).join(", ")} at this commit.`)
    process.exit(1)
  }
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === "plan") await plan(args)
  else if (command === "comment") await comment(args)
  else throw new Error("usage: preview.mjs plan <pr> | comment <pr> <builder commit>")
} catch (err) {
  console.error(`preview: ${err.message}`)
  process.exit(1)
}
