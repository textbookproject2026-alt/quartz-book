// The reconcile workflow's decisions (BOOK-ONE-TO-QUARTZ §0a, §8 step 9). It
// never trusts what woke it: for each book and branch it compares the marker
// Pages serves with what a build would produce now, and builds only when they
// differ.
//
//   node builder/reconcile.mjs plan
//       Every book and branch on the builder (or one book, with SLUG). Writes
//       the ones that aren't current to $GITHUB_OUTPUT as `targets`, a JSON
//       list for the per-book matrix.
//
//   node builder/reconcile.mjs check <slug> <branch> <project> <live> <work dir>
//       The same comparison again for one book and branch, run inside that
//       pair's concurrency group: a run that waited may find the work done.
//       Writes `build` (true or false), `commit`, `repo`, `marker_url` and
//       `artifact` to $GITHUB_OUTPUT, and the
//       registry it read to <work dir>/registry.json, so the build uses the
//       registry the decision was made on.
//
// Environment: SLUG, UNRECORDED_BOOK (plan only), REGISTRY_FILE (a local
// registry.json instead of the registry's main, for testing).
//
// It needs no npm install and holds no secret: the book repos and the markers
// are public, and the builder commit is this checkout's HEAD.
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  REGISTRY_URL,
  bookOptions,
  branchAlias,
  findBook,
  markerCurrent,
  markerDifference,
  markerUrl,
  reconcileTargets,
  registryDigest,
} from "./lib.mjs"

const BUILDER = resolve(import.meta.dirname, "..")

const output = (name, value) => {
  const line = `${name}=${value}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
  else process.stdout.write(line)
}
const summary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
}

async function readRegistry() {
  if (process.env.REGISTRY_FILE) return JSON.parse(readFileSync(process.env.REGISTRY_FILE, "utf8"))
  const res = await fetch(REGISTRY_URL)
  if (!res.ok) throw new Error(`fetching the registry from ${REGISTRY_URL} answered ${res.status}.`)
  return res.json()
}

/** The branch head, read anonymously, as the build's checkout will read it (§0a). */
function branchHead(repo, branch) {
  const out = execFileSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "ls-remote",
      "--exit-code",
      `https://github.com/${repo}.git`,
      `refs/heads/${branch}`,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  )
  const sha = out.split(/\s/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no head for ${repo} ${branch}.`)
  return sha
}

/** The served marker, or null when there is none yet (no deployment, or not JSON). */
async function servedMarker(target) {
  try {
    const res = await fetch(`${markerUrl(target)}?reconcile=${Date.now()}`, {
      headers: { "cache-control": "no-cache" },
    })
    if (!res.ok) return null
    return JSON.parse(await res.text())
  } catch {
    return null
  }
}

const builderCommit = () =>
  execFileSync("git", ["-C", BUILDER, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()

/** What a build of this target would put in its marker now, and what is served. */
async function compare(registry, target, builder) {
  const entry = findBook(registry, target.slug)
  bookOptions(registry, entry, target.branch) // refuses now what the build would refuse
  const want = {
    slug: target.slug,
    branch: target.branch,
    bookCommit: branchHead(target.repo, target.branch),
    registryDigest: registryDigest(registry, entry),
    builderCommit: builder,
  }
  const served = await servedMarker(target)
  return { want, served, current: markerCurrent(served, want) }
}

async function plan() {
  const registry = await readRegistry()
  const builder = builderCommit()
  const targets = reconcileTargets(registry, { slug: process.env.SLUG ?? "" })

  const rows = []
  const stale = []
  for (const t of targets) {
    let note
    try {
      const { want, served, current } = await compare(registry, t, builder)
      note = current
        ? `current at ${want.bookCommit.slice(0, 7)}`
        : `${markerDifference(served, want)}: build ${want.bookCommit.slice(0, 7)}`
      if (!current) stale.push(t)
    } catch (err) {
      // Build it anyway, so the pair's own job goes red and says why.
      note = `**can't compare:** ${err.message.split("\n")[0]}`
      stale.push(t)
    }
    console.log(`${t.slug} ${t.branch}: ${note}`)
    rows.push(`| ${t.slug} | ${t.branch} | ${markerUrl(t)} | ${note} |`)
  }

  summary(
    [
      `### reconcile: ${stale.length} of ${targets.length} to build`,
      "",
      `Builder commit \`${builder.slice(0, 7)}\`.`,
      "",
      "| Book | Branch | Marker | |",
      "|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  )
  output("targets", JSON.stringify(stale))
}

async function check([slug, branch, project, live, workDir]) {
  if (!workDir)
    throw new Error("usage: reconcile.mjs check <slug> <branch> <project> <live> <work dir>")
  const registry = await readRegistry()
  const entry = findBook(registry, slug)
  const target = { slug, branch, project, live: live === "true", repo: entry.content.repo }
  const { want, served, current } = await compare(registry, target, builderCommit())
  writeFileSync(join(workDir, "registry.json"), JSON.stringify(registry))
  console.log(
    `${slug} ${branch}: ${current ? "current, nothing to do" : `${markerDifference(served, want)}, building ${want.bookCommit}`}`,
  )
  output("build", String(!current))
  output("commit", want.bookCommit)
  output("repo", target.repo)
  // Where the deploy job checks the result, and a name for the artifact that is
  // safe for any branch name.
  output("marker_url", markerUrl(target))
  output("artifact", `site-${slug}-${branchAlias(branch)}`)
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === "plan") await plan()
  else if (command === "check") await check(args)
  else
    throw new Error("usage: reconcile.mjs plan | check <slug> <branch> <project> <live> <work dir>")
} catch (err) {
  console.error(`reconcile: ${err.message}`)
  process.exit(1)
}
