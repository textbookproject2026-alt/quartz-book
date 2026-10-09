// The book automation scripts (automation/, §8 step 14), without the network:
// every script reads the registry from a file here, and nothing calls an API.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { slugifyFilePath } from "@quartz-community/utils/path"
import { slugUrl } from "../builder/lib.mjs"
import { pageUrls, publishUrl, quartzUrl } from "../automation/scripts/backup-annotations.mjs"
import { mergeIgnore } from "../automation/scripts/lychee-ignore.mjs"

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

test("contributors: full-path links, no bot, the registry's names, guides on GitHub", () => {
  const book = makeBook()
  const res = run("gen-contributors.mjs", book, "--stdout")
  assert.equal(res.status, 0, res.stderr)
  const page = res.stdout
  assert.match(
    page,
    /\| Ada Author \| 1 \| .* \| \[\[chapters\/chapter-03\\\|Chapter 3\]\], \[\[chapters\/Definitions\/Critical Realism\\\|Critical Realism\]\] \|/,
  )
  assert.doesNotMatch(page, /aldogobot/)
  assert.match(page, /Maintenance and review stay with Ada:/)
  assert.match(page, /under CC-BY-4\.0, the licence/)
  assert.match(
    page,
    /see \[Editing chapters in the browser\]\(https:\/\/github\.com\/someone\/automation-fixture\/blob\/main\/docs\/for-trusted-contributors\.md\), and \[setting up a department edition\]\(https:\/\/github\.com\/textbookproject2026-alt\/textbook-edition-template\/blob\/main\/docs\/department-edition-setup\.md\) if your course wants its own copy\./,
  )
  assert.doesNotMatch(page, /\[\[for-/)
})

test("contributors: anonymous in-site proposals by the name they gave, never the App", () => {
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
  propose("# Chapter 3: Reality\n\nThree.\n", `Fix\n\n${mark}\n\nProposed-by: Ada Author`)
  propose("# Chapter 3: Reality\n\nFour.\n", "Weekly housekeeping")
  const res = run("gen-contributors.mjs", book, "--stdout")
  assert.equal(res.status, 0, res.stderr)
  const page = res.stdout
  assert.match(page, /\| A reader \| 1 \|/, "a proposal from before the trailer")
  assert.match(
    page,
    /\| Jo &#60;b&#62;Reader&#60;\/b&#62; &#91;&#91;x&#93;&#93; \| 1 \|/,
    "plain text, whatever was typed",
  )
  assert.match(page, /\| Ada Author \| 1 \|/, "a typed name doesn't join the person's row")
  assert.equal(page.match(/\| Ada Author \|/g).length, 2)
  assert.doesNotMatch(page, /suggest-edit\[bot\]/)
})

test("contributors: a book without the guides gets no links to them", () => {
  const page = run(
    "gen-contributors.mjs",
    makeBook({ editions: null, trustedGuide: false }),
    "--stdout",
  )
  assert.equal(page.status, 0, page.stderr)
  assert.match(page.stdout, /that is the route to ask for\.\n/)
})

test("contributors writes the page into the book, and --check agrees afterwards", () => {
  const book = makeBook()
  assert.equal(run("gen-contributors.mjs", book).status, 0)
  assert.match(
    readFileSync(join(book.dir, "community/contributors.md"), "utf8"),
    /^# Contributors\n/,
  )
  assert.equal(run("gen-contributors.mjs", book, "--check").status, 0)
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

import {
  contributorOf,
  decisionComment,
  MARKER,
  reasonOf,
} from "../automation/scripts/decision-notice.mjs"

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
