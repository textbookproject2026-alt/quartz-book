// §8 step 8's proof on book one's real content, after CI has built it:
//
//   ./build-book.sh <book one checkout> --branch main --out <out>
//   node test/check-book-one.mjs <out> <book one checkout>
//
// The registry is the live one, as the build fetched it, so this also checks
// that the build took its per-book values from there.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { REGISTRY_URL } from "../builder/lib.mjs"

const [out, checkout] = process.argv.slice(2)
if (!out || !checkout) {
  console.error("usage: check-book-one.mjs <out dir> <book one checkout>")
  process.exit(1)
}
const read = (p) => readFileSync(join(out, p), "utf8")
const registry = await (await fetch(REGISTRY_URL)).json()
const book = registry.books.find((b) => b.slug === "social-research-methods")

const checks = []
const check = (name, fn) => checks.push([name, fn])

check(
  "the six Definitions pages redirect, in the + and %20 spellings, and the two docs pages",
  () => {
    const lines = read("_redirects")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
    const expected = [
      "/chapters/Definitions/Critical+Realism /chapters/definitions/critical-realism 301",
      "/chapters/Definitions/Critical%20Realism /chapters/definitions/critical-realism 301",
      // One word: the + and %20 spellings are the same path, so one line.
      "/chapters/Definitions/Emergence /chapters/definitions/emergence 301",
      "/chapters/Definitions/Monism /chapters/definitions/monism 301",
      "/chapters/Definitions/Retroduction /chapters/definitions/retroduction 301",
      "/chapters/Definitions/The+Three+Domains /chapters/definitions/the-three-domains 301",
      "/chapters/Definitions/The%20Three%20Domains /chapters/definitions/the-three-domains 301",
      "/chapters/Definitions/Unobservables /chapters/definitions/unobservables 301",
      "/docs/how-to-comment /how-to-comment 301",
      `/docs/for-course-coordinators https://github.com/${book.editions.template_repo}/blob/main/docs/for-course-coordinators.md 301`,
    ]
    for (const line of expected) assert.ok(lines.includes(line), `missing: ${line}`)
    for (const line of lines) assert.ok(/^\/\S+ \S+ 301$/.test(line), `malformed: ${line}`)
  },
)

check(
  "community/contributors.md's Chapter 3 link resolves, with Frankenstein/ in the tree but ignored",
  () => {
    assert.ok(
      existsSync(join(checkout, "Frankenstein/chapter-03.md")),
      "Frankenstein/chapter-03.md is no longer in book one",
    )
    assert.match(
      readFileSync(join(checkout, "community/contributors.md"), "utf8"),
      /\[\[chapter-03\\?\|Chapter 3\]\]/,
    )
    const html = read("community/contributors.html")
    assert.match(
      html,
      /<a href="\.\.\/chapters\/chapter-03" class="internal[^"]*"[^>]*>Chapter 3<\/a>/,
    )
    assert.ok(existsSync(join(out, "chapters/chapter-03.html")))
    assert.ok(!existsSync(join(out, "Frankenstein")), "Frankenstein/ was published")
  },
)

check('Edit and History use the repo root (contentDir ""), not content/', () => {
  const html = read("chapters/chapter-03.html")
  assert.match(
    html,
    /href="https:\/\/github\.com\/textbookproject2026-alt\/textbook\/edit\/main\/chapters\/chapter-03\.md"/,
  )
  assert.match(
    html,
    /href="https:\/\/github\.com\/textbookproject2026-alt\/textbook\/commits\/main\/chapters\/chapter-03\.md"/,
  )
  assert.match(
    read("chapters/definitions/critical-realism.html"),
    /\/edit\/main\/chapters\/Definitions\/Critical%20Realism\.md"/,
  )
  assert.doesNotMatch(html, /\/edit\/main\/content\//)
})

check("Suggest follows the registry: on for book one, with the platform endpoint", () => {
  assert.equal(book.suggest_edit.enabled, true)
  const endpoint = registry.platform.suggest_edit_endpoint
  assert.ok(
    read("chapters/chapter-03.html").includes(
      `class="tb-suggest-btn" hidden data-endpoint="${endpoint}"`,
    ),
  )
})

check("Plausible counts on the book's domain only", () => {
  const html = read("chapters/chapter-03.html")
  assert.ok(
    html.includes(book.analytics.plausible.script_src),
    "the registry's Plausible script is missing",
  )
  assert.ok(html.includes(book.site.domain))
})

check("the marker names the commit that was built", () => {
  const m = JSON.parse(read(".well-known/textbook.json"))
  const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  assert.equal(m.slug, "social-research-methods")
  assert.equal(m.branch, "main")
  assert.equal(m.book_commit, head)
})

check("main is indexable, and every page is canonical on the book's domain", () => {
  assert.ok(!existsSync(join(out, "_headers")))
  assert.match(
    read("chapters/chapter-03.html"),
    /<link rel="canonical" href="https:\/\/social-research-methods\.confused4now\.org\/chapters\/chapter-03">/,
  )
})

check("the graph is on, and the builder's /how-to-comment is there", () => {
  assert.match(read("chapters/chapter-03.html"), /class="graph"/)
  assert.match(read("how-to-comment.html"), /<title>Commenting in the Margins<\/title>/)
})

check("steps 3-6 are in: Chapter 3's citations work, and its title is its heading", () => {
  const html = read("chapters/chapter-03.html")
  assert.doesNotMatch(html, /href="#%5E/)
  const hrefs = [...html.matchAll(/href="#(ref-[^"]+)"/g)].map((m) => m[1])
  assert.ok(hrefs.length >= 32, `${hrefs.length} same-page citation links`)
  for (const id of hrefs) assert.ok(html.includes(`id="${id}"`), `no target for #${id}`)
  assert.match(html, /<title>Chapter 3: [^<]+<\/title>/)
})

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
