// The builder's decisions (builder/lib.mjs), without running Quartz.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { test } from "node:test"
import YAML from "yaml"
import {
  BuildRefused,
  addCanonical,
  bookOptions,
  branchFindings,
  contentsOrder,
  branchAlias,
  findBook,
  howToCommentClash,
  ignorePatternsFor,
  marker,
  markerCurrent,
  markerDifference,
  markerUrl,
  orderFolderListing,
  outputAllowed,
  publishUrl,
  reconcileTargets,
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

test("history: every book gets the revision endpoint, whatever suggest_edit says", () => {
  const off = bookOptions(registry, findBook(registry, "no-suggest-fixture"), "main")
  assert.equal(
    off.revisionEndpoint,
    "https://suggest-edit.example.invalid/api/page-revision?book=no-suggest-fixture",
  )
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
  const out = renderConfig(shared, opts, ["README.md", "README.md/**"], ["chapters/introduction"])
  assert.deepEqual(plugin(out, "edition-integrations").options.explorerOrder, [
    "chapters/introduction",
  ])
  const edit = plugin(out, "edit-on-github").options
  assert.deepEqual(edit, {
    repo: "textbookproject2026-alt/quartz-book",
    branch: "drafts",
    contentDir: "",
    suggestEndpoint: "https://suggest-edit.example.invalid/api/suggest-edit",
    revisionEndpoint: "https://suggest-edit.example.invalid/api/page-revision?book=design-fixture",
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
  assert.equal(plugin(shared, "textbook-graph").enabled, true)
  // The platform's fork replaces the community graph; never both.
  assert.equal(plugin(shared, "graph"), undefined)
  assert.equal(plugin(shared, "edition-integrations").enabled, true)
  assert.equal(plugin(shared, "edit-on-github").options.contentDir, "")
})

test("the shared config: the home link is first in the left sidebar, on every page type", () => {
  const home = plugin(shared, "home-link")
  assert.equal(home.enabled, true)
  assert.equal(home.options.url, "https://confused4now.org/")
  assert.equal(home.layout.position, "left")
  // Above every other left-sidebar item, the page title (10) first among them.
  const left = shared.plugins.filter(
    (p) => p !== home && p.enabled && p.layout?.position === "left",
  )
  assert.ok(left.some((p) => p.source === "github:quartz-community/page-title"))
  for (const p of left)
    assert.ok(p.layout.priority > home.layout.priority, JSON.stringify(p.source))
  // No page type drops it. The 404 keeps it and nothing else of the left
  // sidebar, in the default frame (Quartz's "minimal" frame has no sidebar).
  const byType = shared.layout.byPageType
  for (const [type, o] of Object.entries(byType)) {
    assert.ok(!o.exclude?.includes("home-link"), type)
    assert.equal(o.positions?.left, undefined, type)
  }
  assert.equal(byType["404"].template, "default")
  const leftNames = left.map((p) => p.source.replace("github:quartz-community/", ""))
  const disabledLeft = shared.plugins
    .filter((p) => !p.enabled && p.layout?.position === "left")
    .map((p) => p.source.replace("github:quartz-community/", ""))
  assert.deepEqual([...byType["404"].exclude].sort(), [...leftNames, ...disabledLeft].sort())
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

test("the registry digest moves with the platform's Plausible site", () => {
  const book = findBook(registry, "design-fixture")
  const digest = registryDigest(registry, book)
  const withSite = (plausible) => ({
    ...registry,
    platform: { ...registry.platform, analytics: { plausible } },
  })
  const site = {
    script_src: "https://plausible.io/js/pa-a.js",
    site: "p.example",
    dashboard_public: true,
  }
  assert.notEqual(registryDigest(withSite(site), book), digest)
  assert.notEqual(
    registryDigest(withSite({ ...site, script_src: "https://plausible.io/js/pa-b.js" }), book),
    registryDigest(withSite(site), book),
  )
})

test("Plausible: the platform's one site, for live books only (D19)", () => {
  const live = findBook(registry, "no-suggest-fixture")
  const preview = findBook(registry, "design-fixture")
  const src = (reg, book) => bookOptions(reg, book, "main").plausibleScriptSrc
  const withPlatform = (plausible) => ({
    ...registry,
    platform: { ...registry.platform, analytics: { plausible } },
  })
  const site = {
    script_src: "https://plausible.io/js/pa-a.js",
    site: "p.example",
    dashboard_public: true,
  }
  const own = { analytics: { plausible: { script_src: "https://plausible.io/js/pa-own.js" } } }
  assert.equal(src(withPlatform(site), live), site.script_src)
  assert.equal(src(withPlatform(null), live), "")
  assert.equal(src(registry, live), "") // the fixture's platform.analytics is null
  // A preview book never counts, even on the platform's site.
  assert.equal(src(withPlatform(site), preview), "")
  // A book's own analytics field is never read, even with no platform site.
  assert.equal(src(withPlatform(site), { ...live, ...own }), site.script_src)
  assert.equal(src(registry, { ...live, ...own }), "")
  // A registry without platform.analytics is refused, not read as "no analytics".
  const { analytics, ...noAnalytics } = registry.platform
  assert.throws(
    () => src({ ...registry, platform: noAnalytics }, live),
    (e) => e instanceof BuildRefused && /platform\.analytics/.test(e.message),
  )
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
    "assets/**/*.md",
  ])
})

test("markdown under assets/ is ignored, its pictures aren't", () => {
  const ignored = (path) => ignorePatternsFor(["assets"]).some((g) => matchesGlob(path, g))
  assert.equal(ignored("assets/README.md"), true)
  assert.equal(ignored("assets/chapter-02/notes.md"), true)
  assert.equal(ignored("assets/chapter-02/figure-1.png"), false)
  assert.equal(ignored("chapters/chapter-02.md"), false)
})

test("contentsOrder: the Contents list's link targets, as slugs, in order", () => {
  const index = [
    "# A book",
    "",
    "Intro text with [[chapters/chapter-09|a link]] that isn't in the list.",
    "",
    "## Contents",
    "",
    "- **[[chapters/introduction|Introduction]]**",
    "- **[[chapters/chapter-01]]**",
    "  One line on what the chapter does, with [[glossary]] in it.",
    "- **[Chapter 2](./chapters/chapter-02.md)**",
    "- [Chapter 10](/chapters/chapter-10.md#start)",
    "- [[chapters/Definitions/The Three Domains#Part|Domains]]",
    "1. [Glossary](glossary.md)",
    "- No link here",
    "",
    "## Concept index",
    "",
    "- [[Example concept]]",
  ].join("\n")
  assert.deepEqual(contentsOrder(index), [
    "chapters/introduction",
    "chapters/chapter-01",
    "chapters/chapter-02",
    "chapters/chapter-10",
    "chapters/definitions/the-three-domains",
    "glossary",
  ])
})

test("contentsOrder: no Contents heading, or no index.md, gives []", () => {
  assert.deepEqual(contentsOrder("# A book\n\n- [[chapters/chapter-01]]\n"), [])
  assert.deepEqual(contentsOrder(""), [])
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
    /<link rel="canonical" href="https:\/\/book\.example\/chapters\/definitions\/the-three-domains" data-builder="quartz-book"><\/head>/,
  )
  const alias = '<html><head><link rel="canonical" href="https://book.example/x"></head></html>'
  assert.equal(addCanonical(alias, "book.example", "/y"), alias)
})

test("popovers don't take the builder's canonical link for an alias redirect", () => {
  // Quartz's own pattern, read from its source so an upgrade that changes it
  // fails here rather than on readers' hovers.
  const util = readFileSync(
    new URL("../quartz/components/scripts/util.ts", import.meta.url),
    "utf8",
  )
  const src = util.match(/const canonicalRegex = \/(.+)\/(\w*)\n/)
  assert.ok(src, "canonicalRegex not found in quartz/components/scripts/util.ts")
  const canonicalRegex = new RegExp(src[1], src[2])
  const html = addCanonical("<html><head></head></html>", "book.example", "/chapters/chapter-03")
  assert.doesNotMatch(html, canonicalRegex)
  // It still recognises Quartz's own alias pages.
  assert.match('<link rel="canonical" href="../x">', canonicalRegex)
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

// reconcile (§0a, §8 step 9)

/**
 * The fixture registry with two Publish books: one like book one before its
 * cutover, naming the builder and a preview project (§8 step 7, amended 24 Sep),
 * and one that doesn't name the builder at all.
 */
const publishHost = {
  kind: "obsidian-publish",
  site_id: "x",
  publish_host: "publish-01.obsidian.md",
}
const publishBook = (slug, host) => ({
  ...registry.books[0],
  slug,
  status: "live",
  content: { repo: `example/${slug}`, live_branch: "main", drafts_branch: "drafts" },
  site: { domain: `${slug}.example.invalid`, host, legacy_origins: [] },
})
const withPublish = {
  ...registry,
  books: [
    ...registry.books,
    publishBook("publish-preview-fixture", {
      ...publishHost,
      builder: "quartz-book",
      project: "publish-preview-project",
    }),
    publishBook("publish-fixture", publishHost),
  ],
}

test("reconcile looks after each builder book's live and drafts branches, never a retired one", () => {
  assert.deepEqual(
    reconcileTargets(withPublish).map(
      (t) => `${t.slug}@${t.branch}${t.live ? " live" : ""} → ${t.project}`,
    ),
    [
      "design-fixture@main live → design-fixture",
      "design-fixture@drafts → design-fixture",
      "no-suggest-fixture@main live → no-suggest-fixture",
      "no-suggest-fixture@drafts → no-suggest-fixture",
      "publish-preview-fixture@main live → publish-preview-project",
      "publish-preview-fixture@drafts → publish-preview-project",
    ],
  )
})

test("a Publish book that names the builder is built on its recorded project, not one named after its slug", () => {
  const targets = reconcileTargets(withPublish, { slug: "publish-preview-fixture" })
  assert.deepEqual(
    targets.map((t) => [t.branch, t.project, t.repo, t.live]),
    [
      ["main", "publish-preview-project", "example/publish-preview-fixture", true],
      ["drafts", "publish-preview-project", "example/publish-preview-fixture", false],
    ],
  )
})

test("a book with no drafts branch, or drafts the same as live, has one target", () => {
  const book = registry.books[0]
  const one = (content) => ({
    ...registry,
    books: [{ ...book, content: { ...book.content, ...content } }],
  })
  assert.equal(reconcileTargets(one({ drafts_branch: null })).length, 1)
  assert.equal(reconcileTargets(one({ drafts_branch: "main" })).length, 1)
})

test("slug narrows the run to one builder book, and names what is wrong otherwise", () => {
  assert.deepEqual(
    reconcileTargets(withPublish, { slug: "no-suggest-fixture" }).map((t) => t.branch),
    ["main", "drafts"],
  )
  assert.throws(
    () => reconcileTargets(withPublish, { slug: "publish-fixture" }),
    /not on the builder/,
  )
  assert.throws(() => reconcileTargets(withPublish, { slug: "retired-fixture" }), /retired/)
  assert.throws(() => reconcileTargets(withPublish, { slug: "nope" }), /no book with slug/)
})

test("markers: production on the project, previews on the branch alias", () => {
  assert.equal(
    markerUrl({ project: "social-research-methods", branch: "main", live: true }),
    "https://social-research-methods.pages.dev/.well-known/textbook.json",
  )
  assert.equal(
    markerUrl({ project: "social-research-methods", branch: "drafts", live: false }),
    "https://drafts.social-research-methods.pages.dev/.well-known/textbook.json",
  )
  assert.equal(branchAlias("design/PR_12"), "design-pr-12")
  assert.equal(branchAlias("a".repeat(40)).length, 28)
})

test("a served marker is current only when every field matches what would be built", () => {
  const want = {
    slug: "b",
    branch: "main",
    bookCommit: "1".repeat(40),
    registryDigest: "sha256:abc",
    builderCommit: "2".repeat(40),
  }
  const served = marker(want)
  assert.equal(markerCurrent(served, want), true)
  assert.equal(markerCurrent(JSON.parse(JSON.stringify(served)), want), true)
  assert.equal(markerCurrent(null, want), false)
  assert.equal(markerCurrent("<html>", want), false)
  for (const field of Object.keys(served)) {
    assert.equal(markerCurrent({ ...served, [field]: "other" }, want), false, field)
  }
  assert.equal(markerDifference({ ...served, builder_commit: "x" }, want), "builder_commit changed")
  assert.equal(markerDifference(null, want), "nothing served yet")
})

// folder-page's listing markup, as Quartz renders it (one item per page).
const item = (href, title, tags = "") =>
  `<li class="section-li"><div class="section"><p class="meta"></p><div class="desc"><h3><a href="${href}" class="internal">${title}</a></h3></div><ul class="tags">${tags}</ul></div></li>`
const listing = (...items) =>
  `<html><body><div class="page-listing"><ul class="section-ul">${items.join("")}</ul></div><ul><li>footer</li></ul></body></html>`
const titlesOf = (html) =>
  [...html.matchAll(/class="internal">([^<]*)<\/a><\/h3>/g)].map((m) => m[1])
const chapters = [
  item("../chapters/chapter-1", "Chapter 1"),
  item("../chapters/chapter-10", "Chapter 10"),
  item("../chapters/chapter-11", "Chapter 11"),
  item("../chapters/chapter-2", "Chapter 2"),
  item("../chapters/definitions/", "Definitions"),
  item("../chapters/introduction", "Introduction"),
]

test("a folder listing follows the Contents; a subfolder ranks by its first listed page", () => {
  const order = [
    "chapters/introduction",
    "chapters/chapter-1",
    "chapters/definitions/the-three-domains",
    "chapters/chapter-2",
  ]
  const out = orderFolderListing(listing(...chapters), "chapters/index", order)
  assert.deepEqual(titlesOf(out), [
    "Introduction",
    "Chapter 1",
    "Definitions",
    "Chapter 2",
    // unlisted, by title, numerically
    "Chapter 10",
    "Chapter 11",
  ])
  assert.equal((out.match(/class="section-li"/g) ?? []).length, chapters.length)
  assert.ok(out.endsWith("</ul></div><ul><li>footer</li></ul></body></html>"))
})

test("with no Contents a folder listing is in numeric title order", () => {
  assert.deepEqual(titlesOf(orderFolderListing(listing(...chapters), "chapters/index", [])), [
    "Chapter 1",
    "Chapter 2",
    "Chapter 10",
    "Chapter 11",
    "Definitions",
    "Introduction",
  ])
})

test("a listing item's nested tags list moves byte-for-byte", () => {
  const tagged = item(
    "../chapters/chapter-2",
    "Chapter 2",
    '<li><a class="internal tag-link" href="../tags/realism">realism</a></li><li><a class="internal tag-link" href="../tags/method">method</a></li>',
  )
  const html = listing(item("../chapters/chapter-10", "Chapter 10"), tagged)
  const out = orderFolderListing(html, "chapters/index", [])
  assert.equal(out, listing(tagged, item("../chapters/chapter-10", "Chapter 10")))
  // a tag page's listing resolves against its own slug
  assert.equal(orderFolderListing(html, "tags/realism", []), out)
})

test("a page without a listing, or with one that doesn't cut cleanly, is unchanged", () => {
  const plain = "<html><body><ul><li>x</li></ul></body></html>"
  assert.equal(orderFolderListing(plain, "chapters/index", []), plain)
  const unclosed = listing(...chapters).replace(/<\/ul><\/div><ul><li>footer.*$/, "")
  assert.equal(orderFolderListing(unclosed, "chapters/index", []), unclosed)
  const stray = listing(chapters[1], "<p>stray</p>", chapters[0])
  assert.equal(orderFolderListing(stray, "chapters/index", []), stray)
})

test("branchFindings flags work drafts doesn't have, and nothing the platform makes", () => {
  const content = { live_branch: "main", drafts_branch: "drafts" }
  const found = branchFindings(content, {
    changed: {
      main: 2,
      "add-chapters": 3,
      done: 0,
      "proposed-edits/x": 1,
      "chore/contributors-update": 1,
      backups: 4,
    },
    pulls: [
      { number: 4, head: "drafts" },
      { number: 5, head: "add-chapters" },
      { number: 6, head: "chore/dashboard-update" },
    ],
  })
  assert.equal(found.length, 3)
  assert.match(found[0], /^`main` changes 2 file\(s\) that `drafts` doesn't have/)
  assert.match(found[1], /^`add-chapters` changes 3 file\(s\).*nothing builds/)
  assert.match(found[2], /^Pull request #5 goes into `main` from `add-chapters`/)
  // After publishing, main is a merge commit ahead of drafts but changes nothing.
  assert.deepEqual(branchFindings(content, { changed: { main: 0 }, pulls: [] }), [])
})
