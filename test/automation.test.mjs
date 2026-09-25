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
