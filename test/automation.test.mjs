// The book automation scripts (automation/, §8 step 14), without the network:
// every script reads the registry from a file here, and nothing calls an API.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { slugifyFilePath } from "@quartz-community/utils/path"
import { slugUrl } from "../builder/lib.mjs"
import { pageUrls, publishUrl, quartzUrl } from "../automation/scripts/backup-annotations.mjs"
import { mergeIgnore } from "../automation/scripts/lychee-ignore.mjs"
import {
  contributorOf,
  decisionComment,
  MARKER,
  reasonOf,
} from "../automation/scripts/decision-notice.mjs"

const scripts = new URL("../automation/scripts/", import.meta.url).pathname
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/registry.json", import.meta.url), "utf8"),
)
const SITE = "https://book.example.invalid"

// --- the backup's per-URI fallback (§3c) -------------------------------------

// Book one's page names, and the characters Quartz's slug rules treat specially.
const PATHS = [
  "index.md",
  "glossary.md",
  "chapters/chapter-03.md",
  "chapters/Definitions/Critical Realism.md",
  "chapters/Definitions/The Three Domains.md",
  "chapters/Definitions/Emergence.md",
  "chapters/Chapter 3 – Reality & Unobservables.md",
  "chapters/100% sure? #1.md",
  "chapters/index.md",
  "chapters/Definitions/Definitions.md",
  "path-test/café-résumé.md",
  "path-test/em—dash-and-apostrophe's.md",
  "community/contributors.md",
]

test("the fallback's URL is the one the builder serves, for every kind of name", () => {
  for (const p of PATHS) {
    const served = slugUrl(slugifyFilePath(p))
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/")
    assert.equal(quartzUrl(p, SITE), `${SITE}${served}`, p)
  }
})

test("the fallback also asks for the Publish-era URL, only where it differs", () => {
  assert.deepEqual(pageUrls("chapters/Definitions/Critical Realism.md", SITE), [
    `${SITE}/chapters/definitions/critical-realism`,
    `${SITE}/chapters/Definitions/Critical+Realism`,
  ])
  assert.deepEqual(pageUrls("chapters/chapter-03.md", SITE), [`${SITE}/chapters/chapter-03`])
  assert.deepEqual(pageUrls("index.md", SITE), [`${SITE}/`])
  assert.equal(publishUrl("a/b+c.md", SITE), `${SITE}/a/b%2Bc`)
})

// --- the link check's ignore list ------------------------------------------------

test("the ignore list fills in the book's address and keeps the book's own lines", () => {
  const platform = readFileSync(new URL("../automation/.lycheeignore", import.meta.url), "utf8")
  assert.match(mergeIgnore(platform, null, "b.example.invalid"), /^https:\/\/b\.example\.invalid$/m)
  assert.doesNotMatch(mergeIgnore(platform, null, "b.example.invalid"), /__/)
  assert.equal(
    mergeIgnore("https://__SITE_DOMAIN__\n", "https://x.invalid\n", "b.example.invalid"),
    "https://b.example.invalid\n# From the book's own .lycheeignore\nhttps://x.invalid\n",
  )
  assert.throws(() => mergeIgnore("https://__OTHER__\n", null, "b"), /__OTHER__/)
})

// --- the community pages, run on a throwaway book ----------------------------------

/** A git repo shaped like a book, and a registry file naming it. */
function makeBook({ editions = fixture.books[1].editions, trustedGuide = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "book-automation-"))
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  git("init", "--quiet", "-b", "main")
  const write = (rel, text) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const commit = (name, email, message) =>
    git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "-m", message)

  write("textbook.config.json", JSON.stringify({ slug: "automation-fixture" }))
  write("chapters/chapter-03.md", "# Chapter 3: Reality\n\nText.\n")
  write("chapters/Definitions/Critical Realism.md", "# Critical Realism\n\nText.\n")
  // The same name in another folder: the link must say which one (§2 #5).
  write("drafts-archive/chapter-03.md", "# An old copy\n")
  if (trustedGuide) write("docs/for-trusted-contributors.md", "# Guide\n")
  git("add", "-A")
  commit("Ada Author", "ada@example.invalid", "Write the book")
  write("chapters/chapter-03.md", "# Chapter 3: Reality\n\nText, suggested.\n")
  git("add", "-A")
  commit("aldogobot", "bot@example.invalid", "A reader's suggestion")

  const registry = structuredClone(fixture)
  registry.platform.automation_logins = ["aldogobot"]
  registry.books.push({
    ...structuredClone(fixture.books[1]),
    slug: "automation-fixture",
    content: { repo: "someone/automation-fixture", live_branch: "main", drafts_branch: "drafts" },
    editions,
    title: "Automation fixture",
    maintainer: { github: "someone", name: "Ada" },
    licence: "CC-BY-4.0",
  })
  const registryPath = join(dir, "..", `${dir.split("/").pop()}-registry.json`)
  writeFileSync(registryPath, JSON.stringify(registry))
  return { dir, registryPath }
}

/** Run a script in the book, as the workflow does: the book is the working directory. */
function run(script, { dir, registryPath }, ...args) {
  const env = { ...process.env, TEXTBOOK_REGISTRY: registryPath }
  delete env.GITHUB_REPOSITORY // CI's own repo is not the fixture book's
  delete env.GITHUB_ACTIONS
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
  })
}

/** A GitHub stand-in for the contributors' API reads: closed pulls and issues, from `data`. */
async function fakeGitHub(data) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    const kind = url.pathname.endsWith("/pulls")
      ? "pulls"
      : url.pathname.endsWith("/issues")
        ? "issues"
        : null
    const page = Number(url.searchParams.get("page") ?? 1)
    res.setHeader("content-type", "application/json")
    if (!kind || req.headers.authorization !== "Bearer test-token")
      return res.writeHead(401).end("[]")
    res.end(JSON.stringify(page === 1 ? (data[kind] ?? []) : []))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

/** The contributors generator in the book, against the fake API (async: the server answers in-process). */
async function contributorsRun(book, data, ...args) {
  const api = await fakeGitHub(data)
  const env = {
    ...process.env,
    TEXTBOOK_REGISTRY: book.registryPath,
    GITHUB_API_URL: api.url,
    GITHUB_TOKEN: "test-token",
  }
  delete env.GITHUB_REPOSITORY
  delete env.GITHUB_ACTIONS
  delete env.GH_TOKEN
  if (data.noToken) delete env.GITHUB_TOKEN
  const child = spawn(process.execPath, [join(scripts, "gen-contributors.mjs"), ...args], {
    cwd: book.dir,
    env,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))
  const status = await new Promise((r) => child.on("close", r))
  api.close()
  return { status, stdout, stderr }
}

const issue = (number, reason, who, labels, file = "chapters/chapter-03.md") => ({
  number,
  state_reason: reason,
  closed_at: "2026-10-09T10:53:20Z",
  html_url: `https://github.com/someone/automation-fixture/issues/${number}`,
  labels: labels.map((name) => ({ name })),
  body: `**File:** [\`${file}\`](x)\n\n---\n\n**Submitted by:** ${who}\n`,
})
const pull = (number, merged, who) => ({
  number,
  merged_at: merged ? "2026-10-08T09:00:00Z" : null,
  html_url: `https://github.com/someone/automation-fixture/pull/${number}`,
  labels: [{ name: "proposed-edit" }],
  head: { sha: "f".repeat(40) },
  body: `**File:** [\`chapters/chapter-03.md\`](x)\n\n---\n\n**Proposed by:** ${who}\n`,
})
const API = {
  pulls: [
    pull(7, true, "@ada-l (signed in with GitHub)"),
    pull(14, false, "@gobi10k (signed in with GitHub)"),
  ],
  issues: [
    issue(12, "completed", "@gobi10k (signed in with GitHub)", ["section-note"]),
    issue(15, "not_planned", "`Platform test`", ["suggested-edit", "section-note"]),
    issue(
      16,
      "completed",
      "`Bea Reader`",
      ["suggested-edit"],
      "chapters/Definitions/Critical Realism.md",
    ),
  ],
}

/** The fixture book with authors and editors in its frontmatter. */
function creditedBook() {
  const book = makeBook()
  const git = (...args) => execFileSync("git", ["-C", book.dir, ...args], { encoding: "utf8" })
  writeFileSync(
    join(book.dir, "index.md"),
    "---\nauthors:\n  - name: Ada Author\n    orcid: 0000-0002-1825-0097\neditors:\n  - name: Ed Itor\n    github: ed-itor\n---\n\n# Automation fixture\n",
  )
  writeFileSync(
    join(book.dir, "chapters/chapter-03.md"),
    "---\nauthors: [Cee Writer]\n---\n\n# Chapter 3: Reality\n\nText, edited.\n",
  )
  git("add", "-A")
  git(
    "-c",
    "user.name=Dee Direct",
    "-c",
    "user.email=dee@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Tidy chapter 3",
  )
  return book
}

test("contributors: authors and editors from the frontmatter; contributors from commits, merged proposals and completed notes", async () => {
  const book = creditedBook()
  const res = await contributorsRun(book, API, "--stdout")
  assert.equal(res.status, 0, res.stderr)
  const page = res.stdout
  assert.match(
    page,
    /## Authors\n\n- Ada Author \(\[ORCID\]\(https:\/\/orcid\.org\/0000-0002-1825-0097\)\)\n- Cee Writer — \[\[chapters\/chapter-03\\\|Chapter 3: Reality\]\]\n/,
  )
  assert.match(page, /## Editors\n\n- Ed Itor \(\[GitHub\]\(https:\/\/github\.com\/ed-itor\)\)\n/)
  // Ada and Cee are authors, so not contributors; the bot never; #14 declined, #15 not planned.
  assert.match(
    page,
    /\| ada-l \(\[GitHub\]\(https:\/\/github\.com\/ada-l\)\) \| 1 edit \| \[\[chapters\/chapter-03\\\|Chapter 3: Reality\]\] \| \[#7\]\(https:\/\/github\.com\/someone\/automation-fixture\/pull\/7\) \|/,
  )
  assert.match(
    page,
    /\| gobi10k \(\[GitHub\]\(https:\/\/github\.com\/gobi10k\)\) \| 1 note \| .* \| \[#12\]\(/,
  )
  assert.match(
    page,
    /\| Bea Reader \| 1 suggestion \| \[\[chapters\/Definitions\/Critical Realism\\\|Critical Realism\]\] \| \[#16\]\(/,
  )
  assert.match(page, /\| Dee Direct \| 1 commit \|/)
  for (const absent of [
    /#14/,
    /#15/,
    /Platform test/,
    /aldogobot/,
    /\| Ada Author \|/,
    /\| Cee Writer \|/,
  ])
    assert.doesNotMatch(page, absent)
  assert.match(
    page,
    /<a id="page-chapters-chapter-03"><\/a>\n\n\*\*\[\[chapters\/chapter-03\\\|Chapter 3: Reality\]\]\*\*: ada-l, Dee Direct and gobi10k/,
  )
  assert.match(page, /## How credit works/)
  assert.match(page, /under CC-BY-4\.0, the licence/)
})

test("contributors: anonymous in-site proposals by the name they gave, never the App, never 'a reader'", async () => {
  const book = makeBook()
  const git = (...args) => execFileSync("git", ["-C", book.dir, ...args], { encoding: "utf8" })
  const app = [
    "textbook-suggest-edit[bot]",
    "1+textbook-suggest-edit[bot]@users.noreply.github.com",
  ]
  const propose = (text, message) => {
    writeFileSync(join(book.dir, "chapters/chapter-03.md"), text)
    git("add", "-A")
    git(
      "-c",
      `user.name=${app[0]}`,
      "-c",
      `user.email=${app[1]}`,
      "commit",
      "--quiet",
      "-m",
      message,
    )
  }
  const mark = "Proposed by a reader with the in-site editor."
  propose("# Chapter 3: Reality\n\nOne.\n", `Fix\n\n${mark}`)
  propose("# Chapter 3: Reality\n\nTwo.\n", `Fix\n\n${mark}\n\nProposed-by: Jo <b>Reader</b> [[x]]`)
  propose("# Chapter 3: Reality\n\nThree.\n", "Weekly housekeeping")
  const res = await contributorsRun(book, {}, "--stdout")
  assert.equal(res.status, 0, res.stderr)
  assert.match(
    res.stdout,
    /\| Jo &#60;b&#62;Reader&#60;\/b&#62; &#91;&#91;x&#93;&#93; \| 1 commit \|/,
    "plain text, whatever was typed",
  )
  assert.doesNotMatch(res.stdout, /A reader|suggest-edit\[bot\]|aldogobot/)
})

test("contributors: credit-overrides.yml hides, renames and takes items out", async () => {
  const book = creditedBook()
  mkdirSync(join(book.dir, "community"), { recursive: true })
  writeFileSync(
    join(book.dir, "community/credit-overrides.yml"),
    'hide: ["@gobi10k"]\nrename:\n  Bea Reader: Beatrice Reader\nno-credit: ["#7"]\n',
  )
  const res = await contributorsRun(book, API, "--stdout")
  assert.equal(res.status, 0, res.stderr)
  assert.doesNotMatch(res.stdout, /gobi10k|#7|ada-l|Bea Reader \|/)
  assert.match(res.stdout, /\| Beatrice Reader \| 1 suggestion \|/)
})

test("contributors writes the page and the ledger into the book, --check agrees afterwards; no token, no run", async () => {
  const book = creditedBook()
  assert.equal((await contributorsRun(book, API)).status, 0)
  assert.match(
    readFileSync(join(book.dir, "community/contributors.md"), "utf8"),
    /^# Contributors\n/,
  )
  const ledger = JSON.parse(readFileSync(join(book.dir, "community/credits.json"), "utf8"))
  assert.deepEqual(
    ledger.contributors.map((c) => c.name),
    ["ada-l", "Bea Reader", "Dee Direct", "gobi10k"],
  )
  assert.equal((await contributorsRun(book, API, "--check")).status, 0)
  assert.equal(
    (await contributorsRun(book, { ...API, issues: [] }, "--check")).status,
    1,
    "a newly accepted note makes it stale",
  )
  const none = await contributorsRun(book, { ...API, noToken: true }, "--stdout")
  assert.notEqual(none.status, 0)
  assert.match(none.stderr, /GITHUB_TOKEN/)
})

test("derivatives: a book with no edition template writes nothing", () => {
  const book = makeBook({ editions: null })
  const res = run("gen-derivatives.mjs", book)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /no edition template/)
  assert.throws(() => readFileSync(join(book.dir, "community/derivatives.md")))
})

test("a script run in a repo the registry doesn't know stops before writing", () => {
  const book = makeBook()
  writeFileSync(join(book.dir, "textbook.config.json"), JSON.stringify({ slug: "nobody" }))
  const res = run("gen-contributors.mjs", book)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /no book with slug "nobody".*Nothing was written\./)
})

// --- the decision notice (book-decision-notice.yml) ----------------------------------

const BOOK = {
  site: { domain: "book.example.invalid" },
  content: { live_branch: "main", drafts_branch: "drafts" },
}
// Bodies as suggest-edit-function writes them.
const PR_BODY = [
  "### Summary",
  "",
  "```text",
  "Fixed the spelling of receive.",
  "```",
  "",
  "**File:** [`chapters/chapter-03.md`](https://github.com/o/b/blob/drafts/chapters/chapter-03.md)",
  "**Where:** ¶2",
  "",
  "---",
  "",
  "**Proposed by:** @ada-l (signed in with GitHub)",
  "",
  "_proposed with the in-site editor. Review **Files changed**, then merge into `drafts` or close._",
].join("\n")
const NOTE_BODY = [
  "**File:** [`chapters/chapter-03.md`](https://github.com/o/b/blob/main/chapters/chapter-03.md)",
  "**Where:** [¶4](https://book.example.invalid/chapters/chapter-03#p4)",
  "",
  "### Suggested edit",
  "",
  "---",
  "",
  "**Submitted by:** @ada-l (signed in with GitHub)",
].join("\n")
const person = (login, body, at) => ({ user: { login, type: "User" }, body, created_at: at })

test("decision notice: the signed-in contributor only; an anonymous one is nobody to tell", () => {
  assert.equal(contributorOf(PR_BODY), "ada-l")
  assert.equal(contributorOf(NOTE_BODY), "ada-l")
  assert.equal(contributorOf("**Submitted by:** `@ada-l`"), null)
  assert.equal(contributorOf("**Proposed by:** `A Reader` (`r***@example.org`)"), null)
  const event = {
    pull_request: {
      number: 7,
      body: "**Submitted by:** `Ada`",
      merged: true,
      base: { ref: "drafts" },
    },
  }
  assert.equal(decisionComment({ event, book: BOOK, items: [] }), null)
})

test("decision notice: a merged proposal into drafts is accepted, with the maintainer's word and the page", () => {
  const event = {
    pull_request: { number: 7, body: PR_BODY, merged: true, base: { ref: "drafts" } },
  }
  const items = [
    person("ada-l", "Happy to change it.", "2026-10-09T10:00:00Z"),
    person("BrandonAndCaroline", "Good catch,\nthanks!", "2026-10-09T09:00:00Z"),
    {
      user: { login: "textbook-suggest-edit[bot]", type: "Bot" },
      body: "bot",
      created_at: "2026-10-09T11:00:00Z",
    },
  ]
  assert.equal(
    decisionComment({ event, book: BOOK, items }),
    [
      MARKER,
      "@ada-l, the authors have accepted your proposed edit. Thank you for it.",
      "",
      "@BrandonAndCaroline wrote:",
      "",
      "> Good catch,\n> thanks!",
      "",
      "It is in the book's drafts now, and reaches the live page when the authors next publish: https://book.example.invalid/chapters/chapter-03",
    ].join("\n"),
  )
})

test("decision notice: closed unmerged is declined, a review counts as the reason, no page link", () => {
  const event = {
    pull_request: { number: 7, body: PR_BODY, merged: false, base: { ref: "drafts" } },
  }
  const items = [
    person("BrandonAndCaroline", "First thought.", "2026-10-09T09:00:00Z"),
    {
      user: { login: "caro", type: "User" },
      body: "We keep the original wording.",
      submitted_at: "2026-10-09T12:00:00Z",
    },
  ]
  const text = decisionComment({ event, book: BOOK, items })
  assert.match(text, /@ada-l, the authors have declined your proposed edit\./)
  assert.match(text, /@caro wrote:\n\n> We keep the original wording\.$/)
  assert.ok(!text.includes("https://book.example.invalid"))
  // No comment from anyone: just the decision.
  assert.equal(
    decisionComment({ event, book: BOOK, items: [] }),
    `${MARKER}\n@ada-l, the authors have declined your proposed edit. Thank you for it.`,
  )
})

test("decision notice: a note on a paragraph, closed as completed or not planned", () => {
  const done = decisionComment({
    event: { issue: { number: 9, body: NOTE_BODY, state_reason: "completed" } },
    book: BOOK,
    items: [],
  })
  assert.match(done, /accepted your note on ¶4\./)
  assert.match(done, /The page: https:\/\/book\.example\.invalid\/chapters\/chapter-03#p4$/)
  const no = decisionComment({
    event: { issue: { number: 9, body: NOTE_BODY, state_reason: "not_planned" } },
    book: BOOK,
    items: [],
  })
  assert.match(no, /declined your note on ¶4\./)
  assert.equal(
    reasonOf([person("x", `${MARKER} old notice`, "2026-01-01T00:00:00Z")], "ada-l"),
    null,
  )
})
