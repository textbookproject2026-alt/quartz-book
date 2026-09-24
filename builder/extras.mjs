// The extras pin bot (BOOK-ONE-TO-QUARTZ §4b, §8 step 11). When
// quartz-edition-extras' main moves, a pull request moves the pin in
// quartz.lock.json; its design preview shows every book built with it.
//
//   node builder/extras.mjs due
//       Whether extras' main is ahead of the pin. Writes `due` (true or
//       false), `commit` and `branch` to $GITHUB_OUTPUT. reconcile.yml asks this
//       on each 15-minute tick, then dispatches bump-extras.yml unless a pull
//       request for that commit was ever opened.
//
//   node builder/extras.mjs bump [commit]
//       Pins every extras plugin at `commit` (default: extras' main) in
//       quartz.lock.json. Writes `changed` (how many plugins moved), `commit`,
//       `branch` and `title` to $GITHUB_OUTPUT, and the pull request's body to
//       $RUNNER_TEMP/bump-body.md (the system temp dir outside Actions).
//
// Environment: EXTRAS_HEAD, a commit to use as extras' main (tests only).
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EXTRAS_REPO, bumpBranch, bumpExtras, extrasPins } from "./lib.mjs"

const BUILDER = resolve(import.meta.dirname, "..")
const LOCK = join(BUILDER, "quartz.lock.json")
const EXTRAS_WEB = EXTRAS_REPO.replace(/\.git$/, "")

const output = (name, value) => {
  const line = `${name}=${value}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
  else process.stdout.write(line)
}

/** extras' main, read anonymously. */
function extrasHead() {
  if (process.env.EXTRAS_HEAD) return process.env.EXTRAS_HEAD
  const out = execFileSync(
    "git",
    ["-c", "credential.helper=", "ls-remote", "--exit-code", EXTRAS_REPO, "refs/heads/main"],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  )
  const sha = out.split(/\s/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no main in ${EXTRAS_REPO}.`)
  return sha
}

const readLock = () => JSON.parse(readFileSync(LOCK, "utf8"))

function due() {
  const head = extrasHead()
  const behind = extrasPins(readLock()).filter((p) => p.commit !== head)
  console.log(
    behind.length
      ? `extras main is ${head.slice(0, 7)}; ${behind.map((p) => `${p.name} is at ${p.commit.slice(0, 7)}`).join(", ")}.`
      : `every extras plugin is pinned at extras main, ${head.slice(0, 7)}.`,
  )
  output("due", String(behind.length > 0))
  output("commit", head)
  output("branch", bumpBranch(head))
}

function bump([commit]) {
  const to = commit || extrasHead()
  const { lock, changed } = bumpExtras(readLock(), to)
  output("changed", String(changed.length))
  output("commit", to)
  output("branch", bumpBranch(to))
  if (changed.length === 0) {
    console.log(`every extras plugin is already pinned at ${to.slice(0, 7)}.`)
    return
  }
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n")
  output("title", `Pin quartz-edition-extras ${to.slice(0, 7)} (design preview, §4b)`)
  const rows = changed.map(
    (c) =>
      `| \`${c.name}\` | \`${c.from.slice(0, 7)}\` | \`${c.to.slice(0, 7)}\` | [compare](${EXTRAS_WEB}/compare/${c.from}...${c.to}) |`,
  )
  const body = [
    `quartz-edition-extras' \`main\` is at [\`${to.slice(0, 7)}\`](${EXTRAS_WEB}/commit/${to}). This moves the builder's pin to it (BOOK-ONE-TO-QUARTZ §4b).`,
    "",
    "| Plugin | From | To | |",
    "|---|---|---|---|",
    ...rows,
    "",
    "**Before merging:** the design preview comments below with a link per book on the builder. Open each one.",
    "",
    "**Merging** moves `stable` once CI on `main` is green, and every book rebuilds with it in the next `reconcile`. **Closing** keeps the current pin; the bot won't reopen a pull request for this commit.",
    "",
    "Opened by `bump-extras.yml`.",
    "",
  ].join("\n")
  const bodyFile = join(process.env.RUNNER_TEMP ?? tmpdir(), "bump-body.md")
  writeFileSync(bodyFile, body)
  for (const c of changed) console.log(`${c.name}: ${c.from.slice(0, 7)} → ${c.to.slice(0, 7)}`)
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === "due") due()
  else if (command === "bump") bump(args)
  else throw new Error("usage: extras.mjs due | bump [commit]")
} catch (err) {
  console.error(`extras: ${err.message}`)
  process.exit(1)
}
