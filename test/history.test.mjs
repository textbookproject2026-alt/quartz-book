// Page history (builder/lib.mjs, "Page history"): each page's revisions from
// `git log --follow`, credited as the History panel shows them. Real git, no Quartz.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import {
  historyData,
  historyPageMarkdown,
  historySummary,
  markerCurrent,
  otherBranch,
  roleOf,
  swimlaneSvg,
} from "../builder/lib.mjs"
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
  assert.deepEqual(
    revisionAuthor({
      name: APP[0],
      email: APP[1],
      body: "Fix\n\nProposed by a reader with the in-site editor.\n\nProposed-by: Jo Reader",
    }),
    { who: "Jo Reader" },
    "an anonymous proposal's own name, from its trailer",
  )
  assert.deepEqual(
    revisionAuthor({
      name: "Ann",
      email: "ann@example.org",
      body: "x\n\nProposed-by: Someone Else",
    }),
    { who: "Ann" },
    "a person's commit is theirs, whatever its trailers say",
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

// --- The version history (batch 2a, Part B) ---------------------------------------

test("history summaries: the edit summary in full, PR titles' heads and tails off, stock messages in words", () => {
  assert.deepEqual(historySummary("Update chapter-03.md: Fixed the spelling of receive (#7)"), {
    summary: "Fixed the spelling of receive",
    pr: 7,
  })
  assert.deepEqual(historySummary("Edit ¶4 of chapter-03.md: Moved a sentence"), {
    summary: "Moved a sentence",
    pr: null,
  })
  const cut = "Fixed the spelling of receive in the second paragraph, because the old…"
  assert.equal(
    historySummary(
      cut,
      `${cut}\n\nFixed the spelling of receive in the second paragraph, because the old spelling was wrong.\n\nMore.`,
    ).summary,
    "Fixed the spelling of receive in the second paragraph, because the old spelling was wrong.",
  )
  assert.equal(
    historySummary("chore(community): refresh contributors page (#22)").summary,
    "refresh contributors page",
  )
  assert.equal(historySummary("Edit ¶12 of introduction.md").summary, "Paragraph 12 changed")
  assert.equal(historySummary("Update introduction.md").summary, "Text changed")
  assert.equal(historySummary("Create chapter-01.md").summary, "First published")
  assert.equal(historySummary("").summary, "Changed")
})

test("roles in the history: the page's (or book's) authors and editors by name or login, else a contributor, automation none", () => {
  const people = {
    creators: [{ name: "Ann Author", github: "ann-a" }],
    editors: [{ name: "Ed Itor" }],
  }
  assert.equal(roleOf({ who: "ann-a" }, people), "author")
  assert.equal(roleOf({ who: "Ed Itor" }, people), "editor")
  assert.equal(roleOf({ who: "gobi10k" }, people), "contributor")
  assert.equal(roleOf({ who: "automation", automation: true }, people), null)
})

const histFiles = {
  "chapters/c.md": {
    published: [
      {
        sha: "b".repeat(40),
        date: "2026-10-08T10:00:00+02:00",
        who: "ann-a",
        message: "Update c.md: Tidy (#3)",
        body: "",
      },
      {
        sha: "a".repeat(40),
        date: "2026-09-01T10:00:00Z",
        who: "automation",
        automation: true,
        message: "Create c.md",
        body: "",
      },
    ],
    drafts: [
      {
        sha: "c".repeat(40),
        date: "2026-10-09T10:00:00Z",
        who: "gobi10k",
        message: "Edit ¶2 of c.md: A clearer sentence",
        body: "",
      },
    ],
    releases: { "v2026.1": "a".repeat(40) },
  },
}
const histPages = {
  "chapters/c.md": {
    url: "/chapters/c",
    title: "C <one>",
    people: { creators: [{ name: "Ann", github: "ann-a" }], editors: [] },
  },
}
const histReleases = [{ tag: "v2026.1", date: "2026-09-15T12:00:00Z", commit: "a".repeat(40) }]

test("history.json: per page, published and being edited, with roles and summaries; releases; deterministic", () => {
  const h = historyData({ files: histFiles, pages: histPages, releases: histReleases })
  assert.deepEqual(h, {
    version: 1,
    releases: [{ tag: "v2026.1", date: "2026-09-15" }],
    pages: [
      {
        path: "/chapters/c",
        source: "chapters/c.md",
        title: "C <one>",
        published: [
          {
            sha: "b".repeat(40),
            date: "2026-10-08",
            who: "ann-a",
            role: "author",
            summary: "Tidy",
            pr: 3,
          },
          {
            sha: "a".repeat(40),
            date: "2026-09-01",
            who: "the platform",
            role: null,
            summary: "First published",
          },
        ],
        drafts: [
          {
            sha: "c".repeat(40),
            date: "2026-10-09",
            who: "gobi10k",
            role: "contributor",
            summary: "A clearer sentence",
          },
        ],
        releases: { "v2026.1": "a".repeat(40) },
      },
    ],
  })
  assert.deepEqual(historyData({ files: histFiles, pages: histPages, releases: histReleases }), h)
})

test("the swimlane: a static SVG, lanes, a dot per change with its summary, releases as rules; escaped", () => {
  const h = historyData({ files: histFiles, pages: histPages, releases: histReleases })
  const svg = swimlaneSvg(h)
  assert.match(svg, /^<svg class="tb-swimlane" viewBox="0 0 760 \d+" role="img"/)
  for (const lane of ["Proposed", "Being edited", "Published"])
    assert.ok(svg.includes(`>${lane}</text>`))
  assert.equal((svg.match(/<circle class="tb-swim-dot" data-lane="2"/g) ?? []).length, 2)
  assert.equal((svg.match(/<circle class="tb-swim-dot" data-lane="1"/g) ?? []).length, 1)
  assert.ok(svg.includes('<line class="tb-swim-release"'))
  assert.ok(svg.includes(">2026.1</text>"))
  assert.ok(svg.includes("<title>2026-10-09 · C &lt;one&gt;: A clearer sentence (gobi10k)</title>"))
  assert.ok(!svg.includes("<script"))
  const md = historyPageMarkdown(h, { repo: "o/b" })
  assert.match(md, /^---\ntitle: Book history\ntbBuilderPage: true\n/)
  assert.ok(md.includes("<div data-tb-book-history></div>"))
  assert.ok(
    md.includes(
      "- **2026.1**, 2026-09-15: [the book as it was](https://github.com/o/b/tree/v2026.1)",
    ),
  )
  assert.ok(md.includes("- 2026-10-08, [C &lt;one&gt;](/chapters/c): Tidy (ann-a)"))
})

test("the marker names the other branch's head: a build is stale when either branch moves", () => {
  const book = { content: { live_branch: "main", drafts_branch: "drafts" } }
  assert.equal(otherBranch(book, "main"), "drafts")
  assert.equal(otherBranch(book, "drafts"), "main")
  assert.equal(otherBranch(book, "x"), null)
  const want = {
    slug: "b",
    branch: "main",
    bookCommit: "1",
    otherCommit: "2",
    registryDigest: "d",
    builderCommit: "z",
  }
  const served = {
    slug: "b",
    branch: "main",
    book_commit: "1",
    other_commit: "2",
    registry_digest: "d",
    builder_commit: "z",
  }
  assert.ok(markerCurrent(served, want))
  assert.ok(!markerCurrent({ ...served, other_commit: "3" }, want))
  assert.ok(
    !markerCurrent({ ...served, other_commit: undefined }, want),
    "a marker from before batch 2a rebuilds once",
  )
})
