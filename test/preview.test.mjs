// The design preview gate (BOOK-ONE-TO-QUARTZ §4b, §8 step 11): the extras pin
// bot's decisions and the preview's targets and comment. No Quartz, no network.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import {
  EXTRAS_REPO,
  PREVIEW_BRANCH,
  PREVIEW_COMMENT_TAG,
  bookOptions,
  bumpBranch,
  bumpExtras,
  extrasPins,
  previewBranch,
  previewComment,
  previewTargets,
} from "../builder/lib.mjs"

const ROOT = new URL("..", import.meta.url).pathname
const REGISTRY = join(ROOT, "fixtures/registry.json")
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"))
const lock = JSON.parse(readFileSync(join(ROOT, "quartz.lock.json"), "utf8"))
const scratch = mkdtempSync(join(tmpdir(), "quartz-book-preview-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const A = "a".repeat(40)
const B = "b".repeat(40)

test("the lock's extras plugins are the three from quartz-edition-extras", () => {
  assert.deepEqual(
    extrasPins(lock)
      .map((p) => p.name)
      .sort(),
    ["edit-on-github", "edition-integrations", "textbook-graph"],
  )
  assert.throws(() => extrasPins({ plugins: {} }), /pins nothing from/)
})

test("a bump moves every extras plugin to one commit and nothing else", () => {
  const { lock: bumped, changed } = bumpExtras(lock, A)
  assert.deepEqual(changed.map((c) => [c.name, c.to]).sort(), [
    ["edit-on-github", A],
    ["edition-integrations", A],
    ["textbook-graph", A],
  ])
  for (const [name, p] of Object.entries(bumped.plugins)) {
    if (p.resolved === EXTRAS_REPO) assert.deepEqual(p, { ...lock.plugins[name], commit: A })
    else assert.deepEqual(p, lock.plugins[name], name)
  }
  // The input is untouched, and a second bump to the same commit moves nothing.
  assert.notEqual(lock.plugins["edit-on-github"].commit, A)
  assert.deepEqual(bumpExtras(bumped, A).changed, [])
})

test("a bump needs a full commit hash", () => {
  for (const bad of ["", "edc96fc", "main", A.toUpperCase(), undefined])
    assert.throws(() => bumpExtras(lock, bad), /not a full commit hash/, String(bad))
})

test("one bot branch per extras commit", () => {
  assert.equal(bumpBranch("edc96fce02e7ad0330bda54b9bb2ec0a3dc17a6a"), "bot/extras-edc96fc")
})

test("preview branches are design-<number>, and never anything else", () => {
  assert.equal(previewBranch(12), "design-12")
  assert.equal(previewBranch("7"), "design-7")
  for (const bad of [0, -1, "01", "1.5", "main", "", "12 main", "drafts"])
    assert.throws(() => previewBranch(bad), /not a pull request number/, String(bad))
  assert.equal(PREVIEW_BRANCH.test("main"), false)
  assert.equal(PREVIEW_BRANCH.test("drafts"), false)
})

test("a design preview is noindex even though it builds the live branch", () => {
  const book = registry.books[0]
  assert.equal(bookOptions(registry, book, "main").noindex, false)
  assert.equal(bookOptions(registry, book, "main", { preview: true }).noindex, true)
  assert.equal(bookOptions(registry, book, "main", { preview: true }).branch, "main")
})

test("one preview per builder book: its live branch, on design-<pr> in its own project", () => {
  assert.deepEqual(previewTargets(registry, 5), [
    {
      slug: "design-fixture",
      repo: "textbookproject2026-alt/quartz-book",
      project: "design-fixture",
      branch: "main",
      preview: "design-5",
      url: "https://design-5.design-fixture.pages.dev/",
    },
    {
      slug: "no-suggest-fixture",
      repo: "textbookproject2026-alt/quartz-book",
      project: "no-suggest-fixture",
      branch: "main",
      preview: "design-5",
      url: "https://design-5.no-suggest-fixture.pages.dev/",
    },
  ])
})

test("a book whose own branch is named design-<pr> is refused, not overwritten", () => {
  const clash = structuredClone(registry)
  clash.books[0].content.drafts_branch = "design-5"
  assert.throws(() => previewTargets(clash, 5), /has a branch named design-5/)
  assert.equal(previewTargets(clash, 6).length, 2)
})

test("the comment links each preview that serves this builder, and names the ones that don't", () => {
  const targets = previewTargets(registry, 5)
  const body = previewComment({
    pr: 5,
    head: A,
    targets,
    served: [
      { slug: "design-fixture", branch: "main", book_commit: "1".repeat(40), builder_commit: A },
      {
        slug: "no-suggest-fixture",
        branch: "main",
        book_commit: "2".repeat(40),
        builder_commit: B,
      },
    ],
  })
  assert.ok(body.startsWith(PREVIEW_COMMENT_TAG + "\n"))
  assert.match(body, /Design preview: 1 of 2 books/)
  assert.match(
    body,
    /\| design-fixture \| \[design-5\.design-fixture\.pages\.dev\]\(https:\/\/design-5\.design-fixture\.pages\.dev\/\) \| main at `1111111` \| ✅ \|/,
  )
  assert.match(
    body,
    /\| no-suggest-fixture \| \*\*not ready\*\*: serves builder `bbbbbbb` .* ❌ \|/,
  )
  const none = previewComment({ pr: 5, head: A, targets, served: [null, null] })
  assert.match(none, /Design preview: 0 of 2 books/)
  assert.match(none, /serves no marker/)
})

// The scripts, as the workflows run them.

const outputs = (text) =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  )

function builderCopy() {
  const dir = mkdtempSync(join(scratch, "builder-"))
  cpSync(join(ROOT, "builder"), join(dir, "builder"), { recursive: true })
  cpSync(join(ROOT, "quartz.lock.json"), join(dir, "quartz.lock.json"))
  // lib.mjs imports nothing from node_modules, so the copy needs none.
  return dir
}

function run(dir, script, args, env = {}) {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`)
  writeFileSync(out, "")
  const r = spawnSync("node", [join(dir, "builder", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: out, RUNNER_TEMP: dir, ...env },
  })
  return { ...r, out: outputs(readFileSync(out, "utf8")) }
}

test("extras.mjs due: nothing to do at the pin, due when extras' main moved", () => {
  const dir = builderCopy()
  const pinned = lock.plugins["edition-integrations"].commit
  const aligned = bumpExtras(lock, pinned).lock
  writeFileSync(join(dir, "quartz.lock.json"), JSON.stringify(aligned, null, 2) + "\n")
  const quiet = run(dir, "extras.mjs", ["due"], { EXTRAS_HEAD: pinned })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.equal(quiet.out.due, "false")
  const due = run(dir, "extras.mjs", ["due"], { EXTRAS_HEAD: A })
  assert.equal(due.out.due, "true")
  assert.equal(due.out.commit, A)
  assert.equal(due.out.branch, "bot/extras-aaaaaaa")
})

test("extras.mjs bump: rewrites the lock's extras commits only, and writes the pull request", () => {
  const dir = builderCopy()
  cpSync(join(dir, "quartz.lock.json"), join(dir, "before.json"))
  const r = run(dir, "extras.mjs", ["bump", A])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.out.changed, "3")
  assert.equal(r.out.branch, "bot/extras-aaaaaaa")
  assert.match(r.out.title, /^Pin quartz-edition-extras aaaaaaa/)
  const after = readFileSync(join(dir, "quartz.lock.json"), "utf8")
  const diff = spawnSync("diff", [join(dir, "before.json"), join(dir, "quartz.lock.json")], {
    encoding: "utf8",
  }).stdout
  const changedLines = diff.split("\n").filter((l) => /^[<>]/.test(l))
  assert.equal(changedLines.length, 6, diff)
  assert.ok(
    changedLines.every((l) => /"commit": "[0-9a-f]{40}"/.test(l)),
    diff,
  )
  assert.deepEqual(
    extrasPins(JSON.parse(after)).map((p) => p.commit),
    [A, A, A],
  )
  const body = readFileSync(join(dir, "bump-body.md"), "utf8")
  assert.match(body, /compare\/[0-9a-f]{40}\.\.\.a{40}/)
  const again = run(dir, "extras.mjs", ["bump", A])
  assert.equal(again.out.changed, "0")
  assert.equal(readFileSync(join(dir, "quartz.lock.json"), "utf8"), after)
})

test("preview.mjs plan and comment, on the fixture registry", () => {
  const dir = builderCopy()
  const plan = run(dir, "preview.mjs", ["plan", "5"], { REGISTRY_FILE: REGISTRY })
  assert.equal(plan.status, 0, plan.stderr)
  assert.deepEqual(
    JSON.parse(plan.out.targets).map((t) => t.url),
    [
      "https://design-5.design-fixture.pages.dev/",
      "https://design-5.no-suggest-fixture.pages.dev/",
    ],
  )
  const served = join(dir, "served.json")
  const marker = (slug, builder) => ({
    slug,
    branch: "main",
    book_commit: B,
    builder_commit: builder,
  })
  writeFileSync(
    served,
    JSON.stringify([marker("design-fixture", A), marker("no-suggest-fixture", A)]),
  )
  const ok = run(dir, "preview.mjs", ["comment", "5", A], {
    REGISTRY_FILE: REGISTRY,
    SERVED_FILE: served,
  })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(readFileSync(join(dir, "preview-comment.md"), "utf8"), /2 of 2 books/)
  writeFileSync(served, JSON.stringify([marker("design-fixture", A), null]))
  const short = run(dir, "preview.mjs", ["comment", "5", A], {
    REGISTRY_FILE: REGISTRY,
    SERVED_FILE: served,
  })
  assert.equal(short.status, 1)
  assert.match(short.stderr, /no preview of no-suggest-fixture/)
  // The comment is still written, so the pull request says which one is missing.
  assert.match(readFileSync(join(dir, "preview-comment.md"), "utf8"), /1 of 2 books/)
  assert.equal(
    run(dir, "preview.mjs", ["comment", "5", "main"], { REGISTRY_FILE: REGISTRY }).status,
    1,
  )
})

test("the scripts run without the repo's node_modules", () => {
  // The workflows' plan, extras and comment jobs don't run npm ci.
  const dir = builderCopy()
  execFileSync("node", [join(dir, "builder/extras.mjs"), "due"], {
    env: { ...process.env, EXTRAS_HEAD: A, GITHUB_OUTPUT: join(dir, "o") },
  })
})
