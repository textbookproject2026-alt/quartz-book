// The builder's decisions (builder/lib.mjs), without running Quartz.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import YAML from "yaml"
import {
  BuildRefused,
  addCanonical,
  bookOptions,
  findBook,
  howToCommentClash,
  ignorePatternsFor,
  outputAllowed,
  publishUrl,
  redirectsFile,
  registryDigest,
  renderConfig,
  slugUrl,
  stripControls,
} from "../builder/lib.mjs"

const registry = JSON.parse(
  readFileSync(new URL("../fixtures/registry.json", import.meta.url), "utf8"),
)
const shared = YAML.parse(readFileSync(new URL("../quartz.config.yaml", import.meta.url), "utf8"))
const plugin = (config, name) =>
  config.plugins.find(
    (p) => (typeof p.source === "object" ? p.source.name : p.source.split("/").pop()) === name,
  )

test("a retired book is refused", () => {
  assert.throws(() => findBook(registry, "retired-fixture"), BuildRefused)
  assert.throws(() => findBook(registry, "retired-fixture"), /retired/)
})

test("an unknown slug, or none, is refused", () => {
  assert.throws(() => findBook(registry, "no-such-book"), BuildRefused)
  assert.throws(() => findBook(registry, undefined), BuildRefused)
})

test("suggest-edit: the platform endpoint when the book has it on, empty when off", () => {
  const on = bookOptions(registry, findBook(registry, "design-fixture"), "main")
  assert.equal(on.suggestEndpoint, "https://suggest-edit.example.invalid/api/suggest-edit")
  const off = bookOptions(registry, findBook(registry, "no-suggest-fixture"), "main")
  assert.equal(off.suggestEndpoint, "")
})

test("suggest-edit on with no platform endpoint is refused, not built without the button", () => {
  const noEndpoint = { ...registry, platform: {} }
  assert.throws(
    () => bookOptions(noEndpoint, findBook(noEndpoint, "design-fixture"), "main"),
    BuildRefused,
  )
})

test("only the live branch is indexable (D13)", () => {
  const book = findBook(registry, "design-fixture")
  assert.equal(bookOptions(registry, book, "main").noindex, false)
  assert.equal(bookOptions(registry, book, "drafts").noindex, true)
  assert.equal(bookOptions(registry, book, "design-12").noindex, true)
})

test("the rendered config: contentDir is empty, and the per-book values come from the registry", () => {
  const opts = bookOptions(registry, findBook(registry, "design-fixture"), "drafts")
  const out = renderConfig(shared, opts, ["README.md", "README.md/**"])
  const edit = plugin(out, "edit-on-github").options
  assert.deepEqual(edit, {
    repo: "textbookproject2026-alt/quartz-book",
    branch: "drafts",
    contentDir: "",
    suggestEndpoint: "https://suggest-edit.example.invalid/api/suggest-edit",
  })
  assert.equal(
    plugin(out, "edition-integrations").options.siteDomain,
    "design-fixture.example.invalid",
  )
  assert.equal(plugin(out, "edition-integrations").options.plausibleScriptSrc, "")
  assert.equal(out.configuration.baseUrl, "design-fixture.example.invalid")
  assert.equal(out.configuration.pageTitle, "Design fixture")
  assert.deepEqual(out.configuration.ignorePatterns, ["README.md", "README.md/**"])
  assert.deepEqual(plugin(out, "footer").options.links, {
    "Licence (CC-BY-SA-4.0)": "https://creativecommons.org/licenses/by-sa/4.0/",
  })
  // The shared config itself is untouched.
  assert.equal(plugin(shared, "edit-on-github").options.repo, "")
})

test("the shared config: graph on, SPA off, the extras present", () => {
  assert.equal(shared.configuration.enableSPA, false)
  assert.equal(plugin(shared, "graph").enabled, true)
  assert.equal(plugin(shared, "edition-integrations").enabled, true)
  assert.equal(plugin(shared, "edit-on-github").options.contentDir, "")
})

test("the registry digest: stable across key order, sensitive to this book and the endpoint only", () => {
  const book = findBook(registry, "design-fixture")
  const digest = registryDigest(registry, book)
  const reordered = Object.fromEntries(Object.entries(book).reverse())
  assert.equal(registryDigest(registry, reordered), digest)
  assert.notEqual(registryDigest(registry, { ...book, title: "Changed" }), digest)
  const otherBookChanged = {
    ...registry,
    books: registry.books.map((b) => (b === book ? b : { ...b, title: "x" })),
  }
  assert.equal(registryDigest(otherBookChanged, book), digest)
  const endpointChanged = {
    ...registry,
    platform: { suggest_edit_endpoint: "https://elsewhere.invalid/" },
  }
  assert.notEqual(registryDigest(endpointChanged, book), digest)
})

test("everything at the repo root outside the allowlist is ignored, whole", () => {
  const entries = [
    ".git",
    ".github",
    "Frankenstein",
    "LICENSE",
    "admin",
    "assets",
    "chapters",
    "community",
    "configure.mjs",
    "glossary.md",
    "index.md",
    "textbook.config.json",
  ]
  assert.deepEqual(ignorePatternsFor(entries), [
    ".github",
    ".github/**",
    "Frankenstein",
    "Frankenstein/**",
    "LICENSE",
    "LICENSE/**",
    "admin",
    "admin/**",
    "configure.mjs",
    "configure.mjs/**",
    "textbook.config.json",
    "textbook.config.json/**",
  ])
})

test("a book's own how-to-comment clashes with the builder's page", () => {
  assert.equal(howToCommentClash(["index.md", "how-to-comment.md"]), "how-to-comment.md")
  assert.equal(howToCommentClash(["How To Comment.md"]), "How To Comment.md")
  assert.equal(howToCommentClash(["how-to-comment"]), "how-to-comment")
  assert.equal(howToCommentClash(["index.md", "chapters", "docs"]), null)
})

// The inverse of book one's tests/test-path-mapping.js, which locks what Publish served.
test("Publish URLs, as publish.js maps them", () => {
  const cases = [
    ["index.md", "/index"],
    ["path-test/simple.md", "/path-test/simple"],
    ["path-test/with spaces.md", "/path-test/with+spaces"],
    ["path-test/MixedCase Title.md", "/path-test/MixedCase+Title"],
    ["path-test/nested/deeper/level-three.md", "/path-test/nested/deeper/level-three"],
    ["path-test/special-&-(parens).md", "/path-test/special-%26-(parens)"],
    ["path-test/café-résumé.md", "/path-test/caf%C3%A9-r%C3%A9sum%C3%A9"],
    ["path-test/em—dash-and-apostrophe's.md", "/path-test/em%E2%80%94dash-and-apostrophe's"],
    ["chapters/Definitions/Critical Realism.md", "/chapters/Definitions/Critical+Realism"],
  ]
  for (const [path, url] of cases) assert.equal(publishUrl(path), url, path)
  assert.equal(
    publishUrl("chapters/Definitions/Critical Realism.md", "pct"),
    "/chapters/Definitions/Critical%20Realism",
  )
  assert.equal(publishUrl("a+b.md"), "/a%2Bb")
})

test("slug URLs as Pages serves them", () => {
  assert.equal(slugUrl("index"), "/")
  assert.equal(slugUrl("chapters/index"), "/chapters/")
  assert.equal(
    slugUrl("chapters/definitions/the-three-domains"),
    "/chapters/definitions/the-three-domains",
  )
})

test("_redirects: a 301 per changed page in both spellings, none for unchanged pages", () => {
  const pages = [
    { relPath: "chapters/chapter-03.md", slug: "chapters/chapter-03" },
    {
      relPath: "chapters/Definitions/Critical Realism.md",
      slug: "chapters/definitions/critical-realism",
    },
    { relPath: "chapters/Definitions/Emergence.md", slug: "chapters/definitions/emergence" },
    { relPath: "index.md", slug: "index" },
  ]
  const lines = redirectsFile(pages, { editionTemplateRepo: "o/template" }).split("\n")
  assert.deepEqual(
    lines.filter((l) => l && !l.startsWith("#")),
    [
      "/chapters/Definitions/Critical+Realism /chapters/definitions/critical-realism 301",
      "/chapters/Definitions/Critical%20Realism /chapters/definitions/critical-realism 301",
      "/chapters/Definitions/Emergence /chapters/definitions/emergence 301",
      "/index / 301",
      "/docs/how-to-comment /how-to-comment 301",
      "/docs/for-course-coordinators https://github.com/o/template/blob/main/docs/for-course-coordinators.md 301",
    ],
  )
  const noEditions = redirectsFile(pages, { editionTemplateRepo: null })
  assert.doesNotMatch(noEditions, /for-course-coordinators/)
})

test("canonical links go on the book's domain; an existing one is kept", () => {
  const html = "<html><head><title>x</title></head><body></body></html>"
  assert.match(
    addCanonical(html, "book.example", "/chapters/definitions/the-three-domains"),
    /<link rel="canonical" href="https:\/\/book\.example\/chapters\/definitions\/the-three-domains"><\/head>/,
  )
  const alias = '<html><head><link rel="canonical" href="https://book.example/x"></head></html>'
  assert.equal(addCanonical(alias, "book.example", "/y"), alias)
})

test("the builder's page loses its controls row", () => {
  const html =
    '<p>a</p><div class="tb-page-controls"><a class="edit-on-github" href="x">Edit</a></div><p>b</p>'
  assert.equal(stripControls(html), "<p>a</p><p>b</p>")
  assert.throws(() => stripControls("<p>no row</p>"))
})

test("output: book-repo machinery fails the allowlist, generated files pass", () => {
  for (const stray of [
    "configure.mjs",
    "LICENSE",
    "admin/index.html",
    "admin/config.yml",
    "publish.js",
    "publish.css",
    "README.html",
    "Frankenstein/chapter-03.html",
    "templates/index.html",
    "textbook.config.json",
    "docs/how-to-comment.html",
    "QA.html",
    "CNAME",
    "path-test/simple.html",
    "scripts/lib/registry.mjs",
  ])
    assert.equal(outputAllowed(stray), false, stray)
  for (const ok of [
    "index.html",
    "glossary.html",
    "404.html",
    "how-to-comment.html",
    "_redirects",
    "_headers",
    ".well-known/textbook.json",
    "chapters/chapter-03.html",
    "chapters/definitions/index.html",
    "assets/chapter-05/image1.png",
    "community/contributors.html",
    "tags/index.html",
    "static/contentIndex.json",
    "index-6f53fa25.css",
    "component-1ea6ad18.css",
    "prescript-20e13e31.js",
    "postscript-d6c7fcd5.js",
    "favicon.ico",
    "sitemap.xml",
    "index.xml",
    "index-og-image.webp",
    "glossary-og-image.webp",
    "chapters/chapter-03-og-image.webp",
  ])
    assert.equal(outputAllowed(ok), true, ok)
  assert.equal(outputAllowed("README-og-image.webp"), false)
})
