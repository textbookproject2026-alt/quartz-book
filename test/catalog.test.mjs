// The book's catalog (builder/lib.mjs, "The book's catalog"), without running
// Quartz. No npm install needed: lib.mjs has no dependencies.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import {
  CATALOG_PATH,
  GIT_LOG_FORMAT,
  authorsOf,
  buildCatalog,
  isConceptPage,
  normaliseTag,
  outputAllowed,
  parseGitLog,
  tagsOf,
} from "../builder/lib.mjs"

const facts = { slug: "fixture", bookCommit: "c".repeat(40) }

const page = (relPath, slug, extra = {}) => ({
  relPath,
  slug,
  title: extra.title ?? slug,
  frontmatter: extra.frontmatter ?? {},
  indexedTags: extra.indexedTags ?? [],
  links: extra.links ?? [],
})

test("the catalog is an allowed output", () => {
  assert.ok(outputAllowed(CATALOG_PATH))
})

test("tags: frontmatter and inline, without #, lower case, deduplicated", () => {
  assert.equal(normaliseTag(" #Ontology "), "ontology")
  assert.deepEqual(
    tagsOf({ tags: ["Ontology", "#method"], tag: "Method" }, ["ontology", "realism/critical"]),
    ["method", "ontology", "realism/critical"],
  )
  assert.deepEqual(tagsOf({ tags: "a, b" }), ["a", "b"])
  assert.deepEqual(tagsOf({ tags: null }), [])
})

test("authors: a list, a comma string, or `author`", () => {
  assert.deepEqual(authorsOf({ authors: ["A. Author", "B. Author"] }), ["A. Author", "B. Author"])
  assert.deepEqual(authorsOf({ authors: "A, B" }), ["A", "B"])
  assert.deepEqual(authorsOf({ author: "Brandon Sommer" }), ["Brandon Sommer"])
  assert.deepEqual(authorsOf({}), [])
})

test("concept pages: type, tag, or a Definitions/Concepts folder; concept: false wins", () => {
  assert.ok(isConceptPage("chapters/Definitions/Emergence.md"))
  assert.ok(isConceptPage("concepts/x.md"))
  assert.ok(isConceptPage("chapters/x.md", { type: "Concept" }))
  assert.ok(isConceptPage("chapters/x.md", {}, ["concept"]))
  assert.ok(!isConceptPage("chapters/chapter-03.md"))
  assert.ok(!isConceptPage("chapters/Definitions/index.md", { concept: false }))
  // Only folders count, not a file called Definitions.md.
  assert.ok(!isConceptPage("chapters/Definitions.md"))
})

test("the catalog: pages, links between them, concepts, book authors", () => {
  const catalog = buildCatalog({
    facts,
    pages: [
      page("index.md", "index", {
        frontmatter: { authors: ["Brandon Sommer"] },
        links: ["chapters/chapter-03"],
      }),
      page("chapters/chapter-03.md", "chapters/chapter-03", {
        title: "Chapter 3: Reality",
        frontmatter: { tags: ["ontology"] },
        links: ["chapters/Definitions/Emergence", "chapters/chapter-03", "tags/ontology", "gone"],
      }),
      page("chapters/Definitions/Emergence.md", "chapters/Definitions/Emergence", {
        title: "Emergence",
      }),
    ],
  })
  assert.equal(catalog.version, 1)
  assert.equal(catalog.slug, "fixture")
  assert.deepEqual(catalog.authors, ["Brandon Sommer"])
  const ch3 = catalog.pages.find((p) => p.path === "/chapters/chapter-03")
  // Only links to the book's own pages; never itself, a tag page or a missing page.
  assert.deepEqual(ch3.links, ["/chapters/Definitions/Emergence"])
  assert.deepEqual(ch3.tags, ["ontology"])
  assert.equal(ch3.source, "chapters/chapter-03.md")
  assert.equal(ch3.concept, false)
  assert.equal(catalog.pages.find((p) => p.title === "Emergence").concept, true)
  assert.equal(catalog.pages.find((p) => p.path === "/").concept, false)
})

test("book authors fall back to the pages' own", () => {
  const catalog = buildCatalog({
    facts,
    pages: [
      page("index.md", "index"),
      page("chapters/a.md", "chapters/a", { frontmatter: { author: "B" } }),
      page("chapters/b.md", "chapters/b", { frontmatter: { authors: ["A", "B"] } }),
    ],
  })
  assert.deepEqual(catalog.authors, ["A", "B"])
})

// A real repository, so the git log parsing is tested against git itself.
const repo = mkdtempSync(join(tmpdir(), "catalog-"))
after(() => rmSync(repo, { recursive: true, force: true }))
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.org",
    },
  })
const commit = (date, message, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    if (text === null) rmSync(join(repo, path))
    else writeFileSync(join(repo, path), text)
  }
  git("add", "-A")
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.org",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  })
}

test("recent changes from git: newest first, added vs updated, renames, deletions, shallow roots", () => {
  git("init", "-q", "-b", "main")
  commit("2026-09-01T10:00:00+02:00", "first", { "index.md": "# Home\n", "chapters/a.md": "# A\n" })
  commit("2026-09-02T10:00:00+02:00", "add b and old", {
    "chapters/b.md": "# B\n",
    "chapters/old.md": "# Old\n",
  })
  commit("2026-09-03T10:00:00+02:00", "edit a; rename b; delete old", {
    "chapters/a.md": "# A\n\nMore.\n",
    "chapters/b.md": null,
    "chapters/b-renamed.md": "# B\n",
    "chapters/old.md": null,
  })
  commit("2026-09-04T10:00:00+02:00", "edit a again, and a file outside the book", {
    "chapters/a.md": "# A\n\nMore still.\n",
    "configure.mjs": "//\n",
  })

  const log = git(
    "log",
    "-n60",
    "-M",
    "--name-status",
    "-z",
    `--format=${GIT_LOG_FORMAT}`,
    "--",
    "index.md",
    "chapters",
  )
  const commits = parseGitLog(log)
  assert.deepEqual(
    commits.map((c) => c.subject),
    [
      "edit a again, and a file outside the book",
      "edit a; rename b; delete old",
      "add b and old",
      "first",
    ],
  )
  assert.deepEqual(
    commits[1].files.find((f) => f.path === "chapters/b-renamed.md"),
    {
      status: "M",
      path: "chapters/b-renamed.md",
    },
  )

  const catalog = buildCatalog({
    facts,
    commits,
    pages: [
      page("index.md", "index", { title: "Home" }),
      page("chapters/a.md", "chapters/a", { title: "A" }),
      page("chapters/b-renamed.md", "chapters/b-renamed", { title: "B" }),
    ],
  })
  // The stats workflow's pages never count as recent work.
  const withCommunity = buildCatalog({
    facts,
    commits: [
      {
        sha: "x",
        date: "2026-09-05T10:00:00+02:00",
        subject: "stats",
        files: [{ status: "M", path: "community/dashboard.md" }],
      },
      ...commits,
    ],
    pages: [
      page("community/dashboard.md", "community/dashboard", { title: "Dashboard" }),
      page("chapters/a.md", "chapters/a", { title: "A" }),
    ],
  })
  assert.deepEqual(
    withCommunity.recent.map((r) => r.path),
    ["/chapters/a"],
  )
  assert.deepEqual(
    catalog.recent.map((r) => [r.path, r.change, r.date.slice(0, 10)]),
    [
      ["/chapters/a", "updated", "2026-09-04"], // once, at its latest
      ["/chapters/b-renamed", "updated", "2026-09-03"],
      ["/", "added", "2026-09-01"],
    ],
  )

  // A shallow clone's boundary commit claims every file was added: dropped.
  const root = commits.at(-1).sha
  assert.equal(parseGitLog(log, [root]).length, 3)
})
