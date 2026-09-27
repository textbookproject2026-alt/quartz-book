// The builder's proof on a real book, after CI has built it:
//
//   node test/check-live-book.mjs --pick                  prints "<slug> <repo> <branch>"
//   ./build-book.sh <checkout> --branch <branch> --out <out>
//   node test/check-live-book.mjs <out> <checkout> <slug>
//
// The book is the first `live` book on the builder in the live registry, so CI
// always builds something readers are reading. This replaced check-book-one.mjs
// when book one (social-research-methods) was retired on 27 Sep 2026: that file
// checked book one's own pages and redirects; these checks hold for any book.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { REGISTRY_URL } from "../builder/lib.mjs"

const registry = await (await fetch(REGISTRY_URL)).json()
const liveOnBuilder = registry.books.filter(
  (b) => b.status === "live" && b.site?.host?.builder === "quartz-book",
)

if (process.argv[2] === "--pick") {
  const b = liveOnBuilder[0]
  if (!b) {
    console.error("no live book on the builder in the registry")
    process.exit(1)
  }
  console.log(`${b.slug} ${b.content.repo} ${b.content.live_branch}`)
  process.exit(0)
}

const [out, checkout, slug] = process.argv.slice(2)
if (!out || !checkout || !slug) {
  console.error("usage: check-live-book.mjs <out dir> <checkout> <slug> | --pick")
  process.exit(1)
}
const book = registry.books.find((b) => b.slug === slug)
assert.ok(book, `${slug} is not in the registry`)
const read = (p) => readFileSync(join(out, p), "utf8")
const catalog = JSON.parse(read(".well-known/textbook-catalog.json"))
// A page of the book's own, from its catalog: a chapter if there is one.
const page =
  catalog.pages.find((p) => p.path.startsWith("/chapters/") && !p.concept) ??
  catalog.pages.find((p) => p.path !== "/")
const pageHtml = () => read(`${page.path.slice(1)}.html`)

const checks = []
const check = (name, fn) => checks.push([name, fn])

check("the marker names the book, the branch and the commit that was built", () => {
  const m = JSON.parse(read(".well-known/textbook.json"))
  const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  assert.equal(m.slug, slug)
  assert.equal(m.branch, book.content.live_branch)
  assert.equal(m.book_commit, head)
})

check("the catalog is the book's, and lists its pages", () => {
  assert.equal(catalog.slug, slug)
  assert.ok(page, "the catalog has no page besides the front page")
  assert.ok(existsSync(join(out, "index.html")), "no front page")
  assert.ok(existsSync(join(out, `${page.path.slice(1)}.html`)), `${page.path} wasn't built`)
})

check("main is indexable, and pages are canonical on the book's domain", () => {
  assert.ok(!existsSync(join(out, "_headers")))
  const canonical = `<link rel="canonical" href="https://${book.site.domain}${page.path}" data-builder="quartz-book">`
  assert.ok(pageHtml().includes(canonical), `missing: ${canonical}`)
})

check('Edit and History use the repo root (contentDir ""), not content/', () => {
  const html = pageHtml()
  const source = catalog.pages.find((p) => p.path === page.path).source
  const repo = `https://github.com/${book.content.repo}`
  const branch = book.content.live_branch
  assert.ok(html.includes(`href="${repo}/edit/${branch}/${source}"`), "no Edit link")
  assert.ok(html.includes(`href="${repo}/commits/${branch}/${source}"`), "no History link")
  assert.doesNotMatch(html, /\/edit\/[^/"]+\/content\//)
})

check("Suggest follows the registry, with the platform endpoint", () => {
  const button = `class="tb-suggest-btn" hidden data-endpoint="${registry.platform.suggest_edit_endpoint}"`
  assert.equal(pageHtml().includes(button), book.suggest_edit?.enabled === true)
})

check("Plausible counts on the book's domain only", () => {
  const html = pageHtml()
  assert.ok(html.includes(registry.platform.analytics.plausible.script_src))
  assert.ok(html.includes(book.site.domain))
})

check("the graph is on, and the builder's /how-to-comment is there", () => {
  assert.match(pageHtml(), /class="graph"/)
  assert.match(read("how-to-comment.html"), /<title>Commenting in the Margins<\/title>/)
})

console.log(`book: ${slug} (${book.content.repo}), page checked: ${page?.path}`)
let failed = 0
for (const [name, fn] of checks) {
  try {
    fn()
    console.log(`pass  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message.split("\n").join("\n      ")}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
