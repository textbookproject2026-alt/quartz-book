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
  bookMetadata,
  buildCatalog,
  cslItem,
  cslName,
  headTags,
  jsonLd,
  creatorsOf,
  editorsOf,
  CREDIT_ROLES,
  addAfterArticle,
  addAfterTitle,
  bylineHtml,
  contributorsBackMatter,
  creditsBlockHtml,
  creditsFootHtml,
  ignorePatternsFor,
  cutAtWord,
  dateOnly,
  firstParagraph,
  pageMetadata,
  isConceptPage,
  normaliseTag,
  outputAllowed,
  parseGitLog,
  tagsOf,
  topicOf,
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

test("topic: frontmatter topic as written, else the first tag that isn't concept", () => {
  assert.equal(topicOf({ topic: "Social ontology", tags: ["methods"] }), "Social ontology")
  assert.equal(topicOf({ topic: ["Ontology", "Methods"] }), "Ontology")
  assert.equal(topicOf({ tags: ["concept", "#Ontology"] }), "ontology")
  assert.equal(topicOf({ tag: "methods, ontology" }), "methods")
  assert.equal(topicOf({ topic: " ", tags: ["concept"] }), null)
  assert.equal(topicOf({}), null)
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
  assert.equal(ch3.topic, "ontology")
  assert.equal(catalog.pages.find((p) => p.title === "Emergence").topic, null)
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

// --- Citation metadata (bookMetadata, pageMetadata) ---------------------------

const bookFacts = {
  slug: "fixture",
  bookCommit: "c".repeat(40),
  bookCommitDate: "2026-10-08T14:03:00+02:00",
  title: "Registry title",
  domain: "fixture.example.org",
  licence: "CC-BY-4.0",
  authors: "Brandon Sommer, Caroline Laschkolnig",
  type: "paper",
  summary: "The registry's summary.",
  publisher: "",
  lang: "",
  doi: "",
}

test("creators: names or { name, orcid }, ORCID bare or as a URL, a bad iD dropped", () => {
  assert.deepEqual(
    creatorsOf({
      authors: [
        "A. Author",
        { name: "B. Author", orcid: "https://orcid.org/0000-0002-1825-009x" },
        { name: "C. Author", orcid: "not an id" },
        { orcid: "0000-0002-1825-0097" },
      ],
    }),
    [
      { name: "A. Author" },
      { name: "B. Author", orcid: "0000-0002-1825-009X" },
      { name: "C. Author" },
    ],
  )
  assert.deepEqual(authorsOf({ authors: [{ name: "B", orcid: "0000-0002-1825-0097" }, "C"] }), [
    "B",
    "C",
  ])
})

test("dates: YAML dates, ISO strings and git's dates to YYYY-MM-DD; anything else is empty", () => {
  assert.equal(dateOnly(new Date("2026-03-01T00:00:00Z")), "2026-03-01")
  assert.equal(dateOnly("2026-10-08T23:30:00-05:00"), "2026-10-08")
  assert.equal(dateOnly("2026-02-30"), "")
  assert.equal(dateOnly("March 2026"), "")
  assert.equal(dateOnly(undefined), "")
})

test("summary: the first prose paragraph, as plain text, cut at a word under 300", () => {
  const md = [
    "# Chapter 3: Reality",
    "",
    "## Introduction[^1]",
    "",
    "> a quote",
    "",
    '<img src="../assets/x.png" alt="x" />',
    "",
    "- a list",
    "",
    "%% a comment %%",
    "",
    "The **Empirical** domain, as [[Definitions/Critical realism|critical realism]] puts it,",
    "is what we [observe](https://example.org)[^2] and [[Emergence]].",
  ].join("\n")
  assert.equal(
    firstParagraph(md),
    "The Empirical domain, as critical realism puts it, is what we observe and Emergence.",
  )
  assert.equal(firstParagraph("# Only a title\n"), "")
  const long = "word ".repeat(100).trim()
  const cut = cutAtWord(long)
  assert.ok(cut.length <= 300 && cut.endsWith("word…"), cut)
  assert.equal(cutAtWord("short"), "short")
})

test("book metadata: index.md first, then the registry, then the platform", () => {
  const index = page("index.md", "index", {
    frontmatter: {
      authors: ["Brandon Sommer"],
      tags: ["Ontology", "concept"],
      keywords: "realism, ontology",
    },
  })
  index.markdown = "# Ontology for Social Research\n\nFirst paragraph.\n"
  index.created = "2026-09-20T10:00:00+02:00"
  const book = bookMetadata(bookFacts, index)
  assert.deepEqual(book, {
    type: "paper",
    title: "Ontology for Social Research",
    creators: [{ name: "Brandon Sommer" }],
    editors: [],
    publisher: "Confused for Now",
    created: "2026-09-20",
    published: "2026-10-08",
    summary: "The registry's summary.",
    keywords: ["realism", "ontology"],
    url: "https://fixture.example.org/",
    lang: "en",
    format: "text/html",
    rights: "open access",
    licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  })
  // No index.md at all: the registry's title and maintainer, CC BY-SA, no doi.
  const bare = bookMetadata(
    { ...bookFacts, licence: "", type: "", publisher: "Press", lang: "de", doi: "10.1/x" },
    undefined,
  )
  assert.equal(bare.title, "Registry title")
  assert.deepEqual(bare.creators, [{ name: "Brandon Sommer" }, { name: "Caroline Laschkolnig" }])
  assert.equal(bare.type, "book")
  assert.equal(bare.publisher, "Press")
  assert.equal(bare.lang, "de")
  assert.equal(bare.doi, "10.1/x")
  assert.equal(bare.licence.id, "CC-BY-SA-4.0")
  assert.equal(bare.created, "")
  // index.md's own summary, description and dates win.
  const own = bookMetadata(bookFacts, {
    ...index,
    frontmatter: {
      description: "Own *summary*.",
      created: "2025-01-02",
      published: "2025-02-03",
      resource_type: "report",
    },
  })
  assert.equal(own.summary, "Own summary.")
  assert.equal(own.created, "2025-01-02")
  assert.equal(own.published, "2025-02-03")
  assert.equal(own.type, "report")
  assert.ok(!("doi" in own))
})

test("page metadata: the page's own, else its book's; chapter, concept or as given", () => {
  const book = bookMetadata(bookFacts, undefined)
  const ch = page("chapters/chapter-03.md", "chapters/chapter-03", {
    title: "Chapter 3: Reality",
    frontmatter: { tags: ["ontology"], lang: "en-GB", doi: "10.5/ch3" },
  })
  ch.markdown = "# Chapter 3: Reality\n\nIt begins here.\n"
  ch.created = "2026-09-21T09:00:00Z"
  const m = pageMetadata(ch, book, bookFacts)
  assert.equal(m.type, "chapter")
  assert.equal(m.title, "Chapter 3: Reality")
  assert.deepEqual(m.creators, book.creators)
  assert.equal(m.created, "2026-09-21")
  assert.equal(m.published, "2026-10-08")
  assert.equal(m.summary, "It begins here.")
  assert.deepEqual(m.keywords, ["ontology"])
  assert.equal(m.url, "https://fixture.example.org/chapters/chapter-03")
  assert.equal(m.lang, "en-GB")
  assert.equal(m.doi, "10.5/ch3")
  assert.deepEqual(m.book, { title: "Registry title", url: "https://fixture.example.org/" })
  const concept = page("chapters/Definitions/Emergence.md", "chapters/Definitions/Emergence", {
    frontmatter: { author: { name: "E", orcid: "0000-0002-1825-0097" } },
  })
  const c = pageMetadata(concept, book, bookFacts)
  assert.equal(c.type, "concept")
  assert.deepEqual(c.creators, [{ name: "E", orcid: "0000-0002-1825-0097" }])
  assert.equal(
    pageMetadata({ ...concept, frontmatter: { resource_type: "article" } }, book, bookFacts).type,
    "article",
  )
  assert.equal(
    pageMetadata({ ...concept, frontmatter: { resource_type: "poem" } }, book, bookFacts).type,
    "concept",
  )
})

test("the catalog carries the metadata when the build gives the registry facts, and stays deterministic", () => {
  const pages = [page("index.md", "index"), page("chapters/a.md", "chapters/a", { title: "A" })]
  assert.ok(!("metadata" in buildCatalog({ facts, pages })))
  const one = buildCatalog({ facts: bookFacts, pages })
  assert.equal(one.metadata.title, "Registry title")
  assert.equal(one.pages.find((p) => p.path === "/chapters/a").metadata.type, "chapter")
  assert.deepEqual(one, buildCatalog({ facts: bookFacts, pages }))
})

test("head tags: Highwire, Dublin Core and JSON-LD, escaped, optional fields only when set", () => {
  const book = bookMetadata({ ...bookFacts, type: "book" }, undefined)
  const ch = page("chapters/c.md", "chapters/c", {
    title: 'Quotes "and" <tags> & more',
    frontmatter: { authors: [{ name: "E", orcid: "0000-0002-1825-0097" }], keywords: ["a", "b"] },
  })
  ch.markdown = "Body </script><script>alert(1)</script>"
  const tags = headTags(pageMetadata(ch, book, bookFacts), { pdfUrl: "https://x/c.pdf" })
  assert.ok(
    tags.includes(
      '<meta name="citation_title" content="Quotes &quot;and&quot; &lt;tags&gt; &amp; more">',
    ),
  )
  assert.ok(
    tags.includes(
      '<meta name="citation_author_orcid" content="https://orcid.org/0000-0002-1825-0097">',
    ),
  )
  assert.ok(tags.includes('<meta name="citation_publication_date" content="2026/10/08">'))
  assert.ok(tags.includes('<meta name="citation_book_title" content="Registry title">'))
  assert.ok(tags.includes('<meta name="citation_keywords" content="a; b">'))
  assert.ok(tags.includes('<meta name="citation_pdf_url" content="https://x/c.pdf">'))
  assert.ok(
    tags.includes('<meta name="DC.subject" content="a"><meta name="DC.subject" content="b">'),
  )
  assert.ok(
    tags.includes('<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">'),
  )
  assert.ok(!tags.includes("citation_doi"))
  // Nothing in the JSON-LD can close its <script>.
  assert.equal(tags.match(/<\/script>/g).length, 1)
  const front = headTags(book)
  assert.ok(
    !front.includes("citation_book_title") &&
      front.includes('<meta name="DC.type" content="book">'),
  )
  const report = headTags(bookMetadata({ ...bookFacts, type: "report", doi: "10.1/x" }, undefined))
  assert.ok(
    report.includes(
      '<meta name="citation_technical_report_institution" content="Confused for Now">',
    ),
  )
  assert.ok(report.includes('<meta name="citation_doi" content="10.1/x">'))
})

test("JSON-LD: Book (or its kind) on the front page, Chapter in the Book, DefinedTerm for a concept", () => {
  const book = bookMetadata({ ...bookFacts, type: "book" }, undefined)
  assert.equal(jsonLd(book)["@type"], "Book")
  assert.equal(jsonLd(bookMetadata(bookFacts, undefined))["@type"], "ScholarlyArticle")
  const ch = jsonLd(
    pageMetadata(
      page("chapters/c.md", "chapters/c", {
        title: "C",
        frontmatter: { author: { name: "E", orcid: "0000-0002-1825-0097" } },
      }),
      book,
      bookFacts,
    ),
  )
  assert.equal(ch["@type"], "Chapter")
  assert.deepEqual(ch.isPartOf, {
    "@type": "Book",
    name: "Registry title",
    url: "https://fixture.example.org/",
  })
  assert.deepEqual(ch.author, [
    { "@type": "Person", name: "E", sameAs: "https://orcid.org/0000-0002-1825-0097" },
  ])
  assert.equal(ch.isAccessibleForFree, true)
  assert.equal(ch.license, "https://creativecommons.org/licenses/by/4.0/")
  const term = jsonLd(
    pageMetadata(
      page("chapters/Definitions/E.md", "chapters/Definitions/E", { title: "E" }),
      book,
      bookFacts,
    ),
  )
  assert.equal(term["@type"], "DefinedTerm")
  assert.equal(term.inDefinedTermSet.name, "Registry title")
})

test("CSL-JSON: names split at the last word unless inverted; a chapter of its book", () => {
  assert.deepEqual(cslName("Brandon Sommer"), { family: "Sommer", given: "Brandon" })
  assert.deepEqual(cslName("van Beethoven, Ludwig"), { family: "van Beethoven", given: "Ludwig" })
  assert.deepEqual(cslName("UNESCO"), { literal: "UNESCO" })
  const book = bookMetadata({ ...bookFacts, type: "book" }, undefined)
  const item = cslItem(
    pageMetadata(page("chapters/c.md", "chapters/c", { title: "C" }), book, bookFacts),
  )
  assert.equal(item.type, "chapter")
  assert.equal(item["container-title"], "Registry title")
  assert.deepEqual(item.issued, { "date-parts": [[2026, 10, 8]] })
  assert.equal(item.id, "https://fixture.example.org/chapters/c")
  assert.equal(cslItem(book).type, "book")
  assert.equal(cslItem(bookMetadata(bookFacts, undefined)).type, "article")
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

// --- Editors and roles (batch 2a) ------------------------------------------------

test("editors: like authors (names or { name, orcid, github }), no fallback; GitHub logins checked", () => {
  assert.deepEqual(
    editorsOf({
      editors: [
        "A",
        { name: "B", github: "@b-login", orcid: "0000-0002-1825-0097" },
        { name: "C", github: "not a login!" },
      ],
    }),
    [{ name: "A" }, { name: "B", orcid: "0000-0002-1825-0097", github: "b-login" }, { name: "C" }],
  )
  assert.deepEqual(editorsOf({ editor: "Solo" }), [{ name: "Solo" }])
  assert.deepEqual(editorsOf({}), [])
  assert.deepEqual(Object.keys(CREDIT_ROLES), ["author", "editor", "contributor"])
  assert.deepEqual(CREDIT_ROLES.editor.credit, ["Writing – review & editing", "Supervision"])
})

test("an edited volume: no book authors but editors, so cited by its editors; a chapter's editors are the book's unless it has its own", () => {
  const index = page("index.md", "index", { frontmatter: { editors: ["Ed Itor", "Sue Second"] } })
  index.markdown = "# Book T\n"
  const book = bookMetadata(bookFacts, index)
  assert.deepEqual(book.creators, [])
  assert.deepEqual(book.editors, [{ name: "Ed Itor" }, { name: "Sue Second" }])
  const ch = pageMetadata(
    page("chapters/c.md", "chapters/c", { frontmatter: { authors: ["Cee Writer"] } }),
    book,
    bookFacts,
  )
  assert.deepEqual(ch.creators, [{ name: "Cee Writer" }])
  assert.deepEqual(ch.editors, book.editors)
  // A chapter with no authors of its own in an edited volume: batch 1's chain ends at the maintainer.
  const bare = pageMetadata(page("chapters/d.md", "chapters/d"), book, bookFacts)
  assert.deepEqual(bare.creators, [{ name: "Brandon Sommer" }, { name: "Caroline Laschkolnig" }])
  const own = pageMetadata(
    page("chapters/e.md", "chapters/e", { frontmatter: { editors: ["Other Ed"] } }),
    book,
    bookFacts,
  )
  assert.deepEqual(own.editors, [{ name: "Other Ed" }])
  // Authors and editors: authors cited, editors as editors.
  const both = bookMetadata(bookFacts, {
    ...index,
    frontmatter: { authors: ["Ann Author"], editors: ["Ed Itor"] },
  })
  assert.deepEqual(both.creators, [{ name: "Ann Author" }])
  assert.deepEqual(both.editors, [{ name: "Ed Itor" }])
  // Neither: the maintainer, as batch 1.
  assert.deepEqual(bookMetadata(bookFacts, page("index.md", "index")).creators, [
    { name: "Brandon Sommer" },
    { name: "Caroline Laschkolnig" },
  ])
})

test("editors in the head: citation_editor (Zotero), DC.contributor with contributors, JSON-LD editor and contributor", () => {
  const index = page("index.md", "index", {
    frontmatter: {
      editors: [{ name: "Ed Itor", orcid: "0000-0002-1825-0097", github: "editor1" }],
    },
  })
  index.markdown = "# Book T\n"
  const book = bookMetadata({ ...bookFacts, type: "book" }, index)
  const ch = pageMetadata(
    page("chapters/c.md", "chapters/c", { title: "C", frontmatter: { authors: ["Cee Writer"] } }),
    book,
    bookFacts,
  )
  const tags = headTags(ch, { contributors: [{ name: "Gobi", github: "gobi10k" }] })
  assert.ok(
    tags.includes(
      '<meta name="citation_author" content="Cee Writer"><meta name="citation_editor" content="Ed Itor">',
    ),
  )
  assert.ok(
    tags.includes(
      '<meta name="DC.contributor" content="Ed Itor"><meta name="DC.contributor" content="Gobi">',
    ),
  )
  assert.ok(!tags.includes('citation_author" content="Gobi'), "contributors are never cited")
  const ld = jsonLd(ch, { contributors: [{ name: "Gobi", github: "gobi10k" }] })
  assert.deepEqual(ld.isPartOf.editor, [
    {
      "@type": "Person",
      name: "Ed Itor",
      sameAs: ["https://orcid.org/0000-0002-1825-0097", "https://github.com/editor1"],
    },
  ])
  assert.ok(!("editor" in ld), "a chapter's editors are its book's")
  assert.deepEqual(ld.contributor, [
    { "@type": "Person", name: "Gobi", sameAs: "https://github.com/gobi10k" },
  ])
  const front = jsonLd(book)
  assert.ok(!("author" in front))
  assert.equal(front.editor[0].name, "Ed Itor")
  assert.ok(headTags(book).includes('<meta name="citation_editor" content="Ed Itor">'))
  assert.ok(!headTags(book).includes("citation_author"))
})

test("CSL: an edited volume has editor and no author; a chapter carries its book's editors", () => {
  const index = page("index.md", "index", { frontmatter: { editors: ["Ed Itor"] } })
  index.markdown = "# Book T\n"
  const book = bookMetadata({ ...bookFacts, type: "book" }, index)
  const item = cslItem(book)
  assert.ok(!("author" in item))
  assert.deepEqual(item.editor, [{ family: "Itor", given: "Ed" }])
  const ch = cslItem(
    pageMetadata(
      page("chapters/c.md", "chapters/c", { title: "C", frontmatter: { authors: ["Cee Writer"] } }),
      book,
      bookFacts,
    ),
  )
  assert.deepEqual(ch.author, [{ family: "Writer", given: "Cee" }])
  assert.deepEqual(ch.editor, [{ family: "Itor", given: "Ed" }])
})

// --- Credit on the page (batch 2a) ------------------------------------------------

const ledger = {
  version: 1,
  contributors: [
    {
      name: "gobi10k",
      github: "gobi10k",
      counts: { edit: 0, note: 1, suggestion: 0, commit: 0 },
      contributions: [
        { kind: "note", ref: "#12", url: "u", date: "2026-10-09", pages: ["chapters/c.md"] },
      ],
    },
    {
      name: "Bea <Reader>",
      counts: { edit: 0, note: 0, suggestion: 1, commit: 0 },
      contributions: [
        { kind: "suggestion", ref: "#16", url: "u", date: "2026-10-09", pages: ["chapters/d.md"] },
      ],
    },
  ],
}

test("the byline, the chapter's contributors and the front page's credits: escaped, linked, absent when empty", () => {
  assert.equal(
    bylineHtml({ creators: [{ name: "A" }, { name: "B & C" }], editors: [{ name: "E" }] }),
    '<p class="tb-byline">By A and B &amp; C<span class="tb-sep" aria-hidden="true">·</span>Edited by E</p>',
  )
  assert.equal(bylineHtml({ creators: [], editors: [] }), "")
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `P${i}` }))
  assert.equal(
    creditsFootHtml(many, "/community/contributors#page-chapters-c"),
    '<p class="tb-credits-foot"><a href="/community/contributors#page-chapters-c">With contributions from P0, P1, P2, P3, P4, P5, P6, P7 and 3 others.</a></p>',
  )
  assert.equal(
    creditsFootHtml([{ name: "<b>" }], ""),
    '<p class="tb-credits-foot">With contributions from &lt;b&gt;.</p>',
  )
  assert.equal(creditsFootHtml([], "/x"), "")
  assert.equal(
    creditsBlockHtml({ creators: [{ name: "A" }], editors: [] }, 1, "/community/contributors"),
    '<div class="tb-credits-block" role="note" aria-label="Credits"><p><span class="tb-role" data-role="author">Author</span> A</p><p><a href="/community/contributors"><span class="tb-role" data-role="contributor">Contributor</span> 1 person has contributed: see who, and how credit works</a></p><p><a href="/history">Book history: what has changed, and what is being edited</a></p></div>',
  )
  const html =
    '<h1 class="article-title">T</h1><p class="content-meta">x</p><article><p>Text</p></article><hr/>'
  assert.equal(
    addAfterTitle(html, "<b>by</b>"),
    '<h1 class="article-title">T</h1><b>by</b><p class="content-meta">x</p><article><p>Text</p></article><hr/>',
  )
  assert.equal(
    addAfterArticle(html, "<i>foot</i>"),
    '<h1 class="article-title">T</h1><p class="content-meta">x</p><article><p>Text</p></article><i>foot</i><hr/>',
  )
  assert.equal(addAfterTitle("<p>no title</p>", "<b>x</b>"), "<p>no title</p>")
})

test("the catalog carries the ledger and each page's contributors (version stays 1); the overrides file is never published", () => {
  const pages = [page("index.md", "index"), page("chapters/c.md", "chapters/c", { title: "C" })]
  const c = buildCatalog({ facts: bookFacts, pages, credits: ledger })
  assert.equal(c.version, 1)
  assert.deepEqual(c.credits, ledger)
  assert.deepEqual(c.pages.find((p) => p.path === "/chapters/c").contributors, [
    { name: "gobi10k", github: "gobi10k" },
  ])
  assert.ok(!("credits" in buildCatalog({ facts: bookFacts, pages })))
  assert.ok(ignorePatternsFor(["chapters", "community"]).includes("community/credit-overrides.yml"))
})

test("the exports' Contributors page: names only, or nothing", () => {
  const blocks = contributorsBackMatter([{ name: "gobi10k" }, { name: "Bea" }])
  assert.equal(blocks[1].t, "Header")
  assert.match(JSON.stringify(blocks[2]), /"With"/)
  assert.deepEqual(contributorsBackMatter([]), [])
})
