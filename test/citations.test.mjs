// The Cite dialog's citations (builder/citations.mjs): citation-js with the
// vendored CSL styles. Needs `npm ci` (citation-js), not Quartz.
import assert from "node:assert/strict"
import { test } from "node:test"
import { ACCESSED_MARK, citeData, formatAll, runsOf } from "../builder/citations.mjs"
import { bookMetadata, cslItem, pageMetadata } from "../builder/lib.mjs"

const facts = {
  domain: "book.example.org",
  title: "Ontology for Social Research",
  authors: "Brandon Sommer, Caroline Laschkolnig",
  licence: "CC-BY-SA-4.0",
  bookCommitDate: "2026-10-08T10:00:00Z",
  type: "book",
}
const book = bookMetadata(facts, undefined)
const chapter = pageMetadata(
  {
    relPath: "chapters/c.md",
    slug: "chapters/c",
    title: "Chapter 3: Reality & <More>",
    frontmatter: {},
    markdown: "",
  },
  book,
  facts,
)
const text = (runs) => runs.map((r) => r.text).join("")

test("each style, as runs with the titles in italics", () => {
  const s = formatAll(cslItem(chapter))
  assert.equal(
    text(s.apa),
    "Sommer, B., & Laschkolnig, C. (2026). Chapter 3: Reality & <More>. In Ontology for Social Research. Confused for Now. https://book.example.org/chapters/c",
  )
  assert.deepEqual(
    s.apa.find((r) => r.italic),
    { text: "Ontology for Social Research", italic: true },
  )
  assert.match(
    text(s.chicago),
    /^Sommer, Brandon, and Caroline Laschkolnig\. 2026\. “Chapter 3: Reality & <More>\.” In Ontology/,
  )
  assert.match(
    text(s.mla),
    /“Chapter 3: Reality & <More>\.” Ontology for Social Research, Confused for Now, 2026, https:\/\/book\.example\.org\/chapters\/c\.$/,
  )
  // Only Cite Them Right prints the access date, which the page fills in.
  assert.match(
    text(s.harvard),
    new RegExp(
      `Available at: https://book\\.example\\.org/chapters/c \\(Accessed: ${ACCESSED_MARK}\\)\\.$`,
    ),
  )
  for (const key of ["apa", "chicago", "mla"]) assert.ok(!text(s[key]).includes("2999"))
})

test("the page's data: the chapter and the book; the front page has the book alone", () => {
  const d = citeData(cslItem(chapter), cslItem(book))
  assert.equal(d.chapter.title, "Chapter 3: Reality & <More>")
  assert.equal(d.book.type, "book")
  assert.deepEqual(Object.keys(d.styles), ["chapter", "book"])
  assert.match(
    text(d.styles.book.apa),
    /^Sommer, B\., & Laschkolnig, C\. \(2026\)\. Ontology for Social Research\. Confused for Now\. https:\/\/book\.example\.org\/$/,
  )
  const front = citeData(cslItem(book), cslItem(book))
  assert.equal(front.chapter, null)
  assert.deepEqual(Object.keys(front.styles), ["book"])
})

test("runs: entities decoded, only <i> kept", () => {
  assert.deepEqual(
    runsOf(
      '<div class="csl-bib-body"><div class="csl-entry">A &#38; B &lt;<i>T</i> <b>x</b>&#8217;</div></div>',
    ),
    [{ text: "A & B <" }, { text: "T", italic: true }, { text: " x’" }],
  )
})
