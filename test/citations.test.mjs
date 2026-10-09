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

// --- Books with editors (batch 2a) ----------------------------------------------

const edited = (fm) => {
  const b = bookMetadata(facts, {
    relPath: "index.md",
    slug: "index",
    frontmatter: fm,
    markdown: "# Book T\n",
  })
  const c = pageMetadata(
    {
      relPath: "chapters/c.md",
      slug: "chapters/c",
      title: "Chapter One",
      frontmatter: { authors: ["Cee Writer"] },
      markdown: "",
    },
    b,
    facts,
  )
  return { book: formatAll(cslItem(b)), chapter: formatAll(cslItem(c)) }
}

test("a chapter in a book with editors: the editors in all four styles", () => {
  const { book, chapter } = edited({ authors: ["Ann Author"], editors: ["Ed Itor", "Sue Second"] })
  assert.equal(
    text(chapter.apa),
    "Writer, C. (2026). Chapter One. In E. Itor & S. Second (Eds.), Book T. Confused for Now. https://book.example.org/chapters/c",
  )
  assert.equal(
    text(chapter.chicago),
    "Writer, Cee. 2026. “Chapter One.” In Book T, edited by Ed Itor and Sue Second. Confused for Now. https://book.example.org/chapters/c.",
  )
  assert.equal(
    text(chapter.mla),
    "Writer, Cee. “Chapter One.” Book T, edited by Ed Itor and Sue Second, Confused for Now, 2026, https://book.example.org/chapters/c.",
  )
  assert.match(
    text(chapter.harvard),
    /^Writer, C\. \(2026\) ‘Chapter One’, in E\. Itor and S\. Second \(eds\) Book T\./,
  )
  assert.match(text(book.apa), /^Author, A\. \(2026\)\. Book T \(E\. Itor & S\. Second, Eds\.\)\./)
})

test("a book with editors only: an edited volume, cited by its editors (Ed./Eds.)", () => {
  const { book } = edited({ editors: ["Ed Itor", "Sue Second"] })
  assert.equal(
    text(book.apa),
    "Itor, E., & Second, S. (Eds.). (2026). Book T. Confused for Now. https://book.example.org/",
  )
  assert.equal(
    text(book.chicago),
    "Itor, Ed, and Sue Second, eds. 2026. Book T. Confused for Now. https://book.example.org/.",
  )
  assert.equal(
    text(book.mla),
    "Itor, Ed, and Sue Second, editors. Book T. Confused for Now, 2026, https://book.example.org/.",
  )
  assert.match(text(book.harvard), /^Itor, E\. and Second, S\. \(eds\) \(2026\) Book T\./)
  const one = edited({ editors: ["Ed Itor"] }).book
  assert.match(text(one.apa), /^Itor, E\. \(Ed\.\)\. \(2026\)/)
})
