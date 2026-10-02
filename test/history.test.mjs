// Page history (builder/lib.mjs, "Page history"): each page's revisions from
// `git log --follow`, credited as the History panel shows them. Real git, no Quartz.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import {
  COMMIT_INFO_FORMAT,
  outputAllowed,
  parseCommitInfo,
  parseFollowLog,
  revisionAuthor,
  revisionsOf,
} from "../builder/lib.mjs"

const repo = mkdtempSync(join(tmpdir(), "history-"))
after(() => rmSync(repo, { recursive: true, force: true }))
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
const commit = (who, message, files, date) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    if (text === null) rmSync(join(repo, path))
    else writeFileSync(join(repo, path), text)
  }
  git("add", "-A")
  const [name, email] = who
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  })
}

const MAINTAINER = ["Ann Author", "ann@example.org"]
const SIGNED_IN = ["Jo Bloggs", "4242+jo-reads@users.noreply.github.com"]
const APP = [
  "textbook-suggest-edit[bot]",
  "329478423+textbook-suggest-edit[bot]@users.noreply.github.com",
]
const ACTIONS = ["github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com"]
const OLD_BOT = ["aldogobot", "aldogobot@example.org"]
const automation = new Set(["aldogobot"])

const body = "Line one of a chapter.\n".repeat(20)

test("each page's revisions: newest first, across a rename, credited as the panel shows them", () => {
  git("init", "-q", "-b", "main")
  commit(
    MAINTAINER,
    "First draft",
    { "chapters/one.md": `# One\n\n${body}`, "index.md": "# Home\n" },
    "2026-09-01T10:00:00Z",
  )
  commit(
    SIGNED_IN,
    "Fix a typo",
    { "chapters/one.md": `# One\n\n${body}Typo fixed.\n` },
    "2026-09-02T10:00:00Z",
  )
  commit(
    APP,
    "Clearer opening\n\nProposed by a reader with the in-site editor.",
    { "chapters/one.md": `# One!\n\n${body}Typo fixed.\n` },
    "2026-09-03T10:00:00Z",
  )
  commit(
    APP,
    "Better words (#12)\n\nProposed in #12.\n\nAccepted by @ann via the author site.\n\nCo-authored-by: Jo Bloggs <4242+jo-reads@users.noreply.github.com>",
    { "chapters/one.md": `# One!\n\n${body}Typo fixed. Better.\n` },
    "2026-09-04T10:00:00Z",
  )
  commit(
    MAINTAINER,
    "Rename the chapter",
    {
      "chapters/one.md": null,
      "chapters/chapter-one.md": `# One!\n\n${body}Typo fixed. Better.\n`,
    },
    "2026-09-05T10:00:00Z",
  )
  commit(
    ACTIONS,
    "Rebuild the stats",
    { "community/stats.md": "# Stats\n" },
    "2026-09-06T10:00:00Z",
  )
  commit(
    OLD_BOT,
    "Old bot edit\n\nProposed in #3.",
    { "chapters/chapter-one.md": `# One!\n\n${body}Typo fixed. Better. Bot.\n` },
    "2026-09-07T10:00:00Z",
  )

  const info = parseCommitInfo(git("log", "--no-merges", "-z", `--format=${COMMIT_INFO_FORMAT}`))
  const follow = parseFollowLog(
    git(
      "log",
      "--follow",
      "--no-merges",
      "-M",
      "--name-status",
      "-z",
      "--format=%x1e%H",
      "--",
      "chapters/chapter-one.md",
    ),
  )
  const list = revisionsOf(follow, info, automation)
  assert.deepEqual(
    list.map((r) => [r.message, r.who, r.path, r.date.slice(0, 10)]),
    [
      ["Old bot edit", "a reader", "chapters/chapter-one.md", "2026-09-07"],
      ["Rename the chapter", "Ann Author", "chapters/chapter-one.md", "2026-09-05"],
      ["Better words (#12)", "jo-reads", "chapters/one.md", "2026-09-04"],
      ["Clearer opening", "a reader", "chapters/one.md", "2026-09-03"],
      ["Fix a typo", "jo-reads", "chapters/one.md", "2026-09-02"],
      ["First draft", "Ann Author", "chapters/one.md", "2026-09-01"],
    ],
  )
  assert.equal(list[3].reader, true)
  assert.match(list[0].sha, /^[0-9a-f]{40}$/)

  const stats = revisionsOf(
    parseFollowLog(
      git(
        "log",
        "--follow",
        "--no-merges",
        "-M",
        "--name-status",
        "-z",
        "--format=%x1e%H",
        "--",
        "community/stats.md",
      ),
    ),
    info,
    automation,
  )
  assert.deepEqual(
    stats.map((r) => [r.who, r.automation]),
    [["automation", true]],
  )
})

test("revisionAuthor: never the App; a bot's human co-authors; plain names as git has them", () => {
  assert.deepEqual(revisionAuthor({ name: "Ann", email: "ann@example.org" }), { who: "Ann" })
  assert.deepEqual(revisionAuthor({ name: "Ann", email: "ann-gh@users.noreply.github.com" }), {
    who: "ann-gh",
  })
  assert.deepEqual(
    revisionAuthor({
      name: APP[0],
      email: APP[1],
      body: "x\n\nCo-authored-by: github-actions[bot] <1+github-actions[bot]@users.noreply.github.com>\nCo-authored-by: Bo <bo@example.org>\nCo-authored-by: Bo <bo@example.org>",
    }),
    { who: "Bo" },
  )
  assert.deepEqual(revisionAuthor({ name: APP[0], email: APP[1], body: "Something else" }), {
    who: "automation",
    automation: true,
  })
})

test("history files are builder output, and only JSON there", () => {
  assert.equal(outputAllowed(".well-known/history/chapters/one.json"), true)
  assert.equal(outputAllowed(".well-known/history/chapters/one.html"), false)
})
