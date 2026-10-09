// The exports' pure parts (builder/lib.mjs, "Exports"), against excerpts of the
// live books in fixtures/export/. No pandoc or Typst needed: export.mjs runs
// those, and CI's live build makes the files.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  bookMetadata,
  chapterSlugs,
  epubFontCss,
  exportFonts,
  exportName,
  frontPage,
  headingAnchor,
  licenceName,
  linkResolver,
  numberBlocks,
  odtStyles,
  outputAllowed,
  preprocessMarkdown,
  sectionOf,
  splitTitle,
  typstFontRules,
  uiTitle,
  withoutContents,
} from "../builder/lib.mjs"

const fixture = (name) =>
  readFileSync(new URL(`../fixtures/export/${name}`, import.meta.url), "utf8")
const DOMAIN = "book.example.org"
const pages = [
  { relPath: "index.md", slug: "index" },
  { relPath: "chapters/chapter-01.md", slug: "chapters/chapter-01" },
  {
    relPath: "chapters/Definitions/Example concept.md",
    slug: "chapters/Definitions/Example-concept",
  },
  { relPath: "glossary.md", slug: "glossary" },
]
const ctx = (relPath, extra = {}) => ({
  relPath,
  resolve: linkResolver(pages, DOMAIN),
  source: (p) =>
    p === "chapters/Definitions/Example concept.md" ? fixture("example-concept.md") : null,
  findFile: (name) => (name === "square.png" ? "assets/chapter-01/square.png" : null),
  ...extra,
})

test("the converter's <img>: a markdown image from the book's root, its width kept, inline text untouched", () => {
  const out = preprocessMarkdown(fixture("ch3-inline-image.md"), ctx("chapters/chapter-03.md"))
  assert.match(
    out,
    /^!\[Ein Bild, das Kreis, Diagramm, Text, Schrift enthält\. KI-generierte Inhalte können fehlerhaft sein\.\]\(<assets\/chapter-03\/media\/image3\.png>\)\{width=2\.98403in\}\*\*The Empirical domain\*\* encompasses/m,
  )
  const fig = preprocessMarkdown(fixture("ch2-figure.md"), ctx("chapters/chapter-02.md"))
  assert.match(
    fig,
    /^!\[Figure 2\.1: how ontology, epistemology, methodology and methods relate, with epistemology's crosscutting role\]\(<assets\/chapter-02\/media\/image1\.png>\)\{width=6\.26389in\}$/m,
  )
  assert.ok(!fig.includes("<img"))
})

test("images: markdown, root-absolute and remote; never resolved twice", () => {
  const md =
    "![a](../assets/x.png) ![b](/assets/y%20z.png) ![c](<sub/w.png>) ![d](https://example.org/r.png)"
  assert.equal(
    preprocessMarkdown(md, ctx("chapters/one.md")),
    "![a](<assets/x.png>) ![b](<assets/y z.png>) ![c](<chapters/sub/w.png>) [d](https://example.org/r.png)",
  )
})

test("wikilinks and concept links: their text, linked to the live page; unknown targets are text", () => {
  const out = preprocessMarkdown(fixture("index-contents.md"), ctx("index.md"))
  assert.ok(
    out.includes(
      "- **[Chapter 1 — Title of the first chapter](https://book.example.org/chapters/chapter-01)**",
    ),
    out,
  )
  assert.ok(
    out.includes(
      "- [Example concept](https://book.example.org/chapters/Definitions/Example-concept)",
    ),
  )
  assert.ok(out.includes("- [Glossary](https://book.example.org/glossary)"))
  assert.ok(
    out.includes(
      "- [Example concept](https://book.example.org/chapters/Definitions/Example-concept) — one line",
    ),
  )
  // /how-to-comment is the builder's page, not the book's: plain text.
  assert.ok(out.includes("How to comment in the margins is a five-minute walkthrough"))
  assert.ok(!out.includes("[["))
})

test("comments go, callouts are titled quotes, embeds are images or the page's text", () => {
  const out = preprocessMarkdown(fixture("obsidian.md"), ctx("chapters/chapter-01.md"))
  assert.ok(!out.includes("%%") && !out.includes("note to self"))
  assert.ok(out.includes("> **Mind the gap**\n>\n> The callout's body."), out)
  assert.ok(out.includes("> **Tip**\n>\n> A folded one"))
  // The concept page's text, without its own H1.
  assert.ok(out.includes("A concept page: one idea, explained on its own"))
  assert.ok(!out.includes("# Example concept"))
  // Its section only, by heading: there is none called that, so nothing.
  assert.ok(out.includes("![](<assets/chapter-01/square.png>){width=200px}"))
  assert.ok(out.includes("Missing page"))
  assert.ok(
    out.includes("[analytical dualism](https://book.example.org/glossary#analytical-dualism)"),
  )
  assert.ok(out.includes("See [analytical dualism]") && out.includes(" and Local heading."))
})

test("embeds stop two levels deep", () => {
  const loop = { relPath: "chapters/chapter-01.md", slug: "chapters/chapter-01" }
  const out = preprocessMarkdown("![[chapter-01]]", {
    ...ctx("chapters/chapter-01.md"),
    resolve: linkResolver([loop], DOMAIN),
    source: () => "Again: ![[chapter-01]]",
  })
  assert.equal(
    out.trim(),
    "Again: \n\nAgain: [chapter-01](https://book.example.org/chapters/chapter-01)",
  )
})

test("sections, titles and the index's Contents", () => {
  assert.equal(
    sectionOf("# T\n\n## A\n\none\n\n### A.1\n\ntwo\n\n## B\n\nthree", "A").trim(),
    "one\n\n### A.1\n\ntwo",
  )
  assert.equal(sectionOf("## A\n\none", "Nope"), "")
  const { title, body } = splitTitle(fixture("ch1-opening.md").replace(/^---[\s\S]*?---\n/, ""))
  assert.equal(title, "Chapter 1: Introduction to Ontological Analysis in Social Research")
  assert.ok(body.trimStart().startsWith("## Introduction[^1]"))
  assert.deepEqual(splitTitle("Text first.\n\n# Later"), {
    title: "",
    body: "Text first.\n\n# Later",
  })
  const index = "# Book\n\nIntro.\n\n" + fixture("index-contents.md")
  const left = withoutContents(index)
  assert.ok(!left.includes("## Contents") && !left.includes("chapter-01|"))
  assert.ok(left.includes("## Concept index"))
  assert.equal(
    headingAnchor("2.1.3 Why Social Research Needs an Ontological Referent"),
    "213-why-social-research-needs-an-ontological-referent",
  )
})

test("paragraph numbers on pandoc's blocks: the site's rule (top level, with text, no references)", () => {
  const P = (text) => ({ t: "Para", c: [{ t: "Str", c: text }] })
  const H = (level, text) => ({ t: "Header", c: [level, ["", [], []], [{ t: "Str", c: text }]] })
  const blocks = [
    P("one"),
    { t: "Para", c: [{ t: "Image", c: [["", [], []], [], ["x.png", ""]] }] },
    { t: "Figure", c: [] },
    { t: "BulletList", c: [[P("in a list")]] },
    { t: "BlockQuote", c: [P("quoted")] },
    P("two"),
    H(2, "References"),
    P("Bhaskar, R. (1975)."),
    H(3, "Sub"),
    P("still references"),
    H(2, "Afterword"),
    { t: "Para", c: [{ t: "Strong", c: [{ t: "Str", c: "three" }] }] },
  ]
  assert.equal(numberBlocks(structuredClone(blocks)), 3)
  const marked = structuredClone(blocks)
  numberBlocks(marked, true)
  assert.deepEqual(marked[5].c[0], { t: "RawInline", c: ["typst", "#pnum(2)"] })
  assert.deepEqual(marked[11].c[0], { t: "RawInline", c: ["typst", "#pnum(3)"] })
  assert.equal(marked[1].c.length, 1, "an image alone isn't numbered")
})

test("file names, aliases, and the downloads in the allowlist", () => {
  assert.equal(
    exportName("ontology-book", "chapter-03", "2026-10-08", "pdf"),
    "ontology-book-chapter-03-2026-10-08.pdf",
  )
  assert.equal(exportName("ontology-book", "", "2026-10-08", "odt", false), "ontology-book.odt")
  assert.deepEqual(
    [
      ...chapterSlugs([
        "chapters/chapter-01",
        "chapters/Definitions/Émergence",
        "a/intro",
        "b/intro",
      ]),
    ],
    [
      ["chapters/chapter-01", "chapter-01"],
      ["chapters/Definitions/Émergence", "emergence"],
      ["a/intro", "a-intro"],
      ["b/intro", "b-intro"],
    ],
  )
  assert.ok(outputAllowed("downloads/ontology-book-2026-10-08.pdf"))
  assert.ok(!outputAllowed("downloads/notes.md"))
  assert.ok(!outputAllowed("downloads/../x.pdf"))
})

test("the front page: publisher, date, version, address, licence, APA", () => {
  const meta = bookMetadata(
    {
      domain: DOMAIN,
      title: "Ontology",
      authors: "B S",
      licence: "CC-BY-SA-4.0",
      bookCommitDate: "2026-10-08T10:00:00Z",
    },
    undefined,
  )
  const [div, brk] = frontPage(meta, {
    version: "0270693",
    apa: [{ text: "S, B. (2026). " }, { text: "Ontology", italic: true }, { text: "." }],
  })
  const text = (inlines) =>
    inlines
      .map((i) =>
        i.t === "Str"
          ? i.c
          : i.t === "Space"
            ? " "
            : i.c?.[1] && i.t === "Link"
              ? text(i.c[1])
              : text(i.c ?? []),
      )
      .join("")
  assert.deepEqual(
    div.c[1].map((p) => text(p.c)),
    [
      "Publisher: Confused for Now",
      "Published: 2026-10-08",
      "Version: 0270693",
      "Online at: https://book.example.org/",
      "Licence: This work is licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Open access.",
      "Cite as: S, B. (2026). Ontology.",
    ],
  )
  assert.ok(div.c[1][5].c.some((i) => i.t === "Emph"))
  assert.deepEqual(brk, { t: "RawBlock", c: ["typst", "#pagebreak()"] })
  assert.equal(licenceName("CC-BY-NC-SA-4.0"), "CC BY-NC-SA 4.0")
})

test("fonts: design.yaml's families when the builder fetches them and their files are there; else the default, said", () => {
  const all = () => true
  const f = exportFonts(
    { text: "Source Serif 4", ui: "Source Sans 3", mono: "JetBrains Mono" },
    "/fonts",
    all,
  )
  assert.deepEqual(f.warnings, [])
  assert.equal(f.text.dir, "/fonts/source-serif-4")
  assert.deepEqual(
    f.text.faces.map((x) => x.path.split("/").pop()),
    [
      "SourceSerif4-Regular.otf",
      "SourceSerif4-It.otf",
      "SourceSerif4-Semibold.otf",
      "SourceSerif4-SemiboldIt.otf",
      "SourceSerif4-Bold.otf",
      "SourceSerif4-BoldIt.otf",
    ],
  )
  assert.equal(f.mono.faces[3].path, "/fonts/jetbrains-mono/JetBrainsMono-SemiBoldItalic.ttf")
  const odd = exportFonts(
    { text: "Comic Sans", ui: "Source Sans 3" },
    "/fonts",
    (p) => !p.includes("SourceSans3-Bold.otf"),
  )
  assert.equal(odd.text, null)
  assert.equal(odd.ui, null)
  assert.equal(odd.mono, null)
  assert.match(odd.warnings[0], /"Comic Sans" is not one the builder fetches/)
  assert.match(odd.warnings[1], /Source Sans 3's files are missing \(SourceSans3-Bold\.otf\)/)
  assert.deepEqual(exportFonts(undefined, "/fonts", all), {
    text: null,
    ui: null,
    mono: null,
    warnings: [],
  })
})

test("fonts in each format: Typst's headings and title in the ui font, EPUB's @font-face, ODT's named families", () => {
  const f = exportFonts(
    { text: "Source Serif 4", ui: "Source Sans 3", mono: "JetBrains Mono" },
    "/fonts",
    () => true,
  )
  assert.equal(typstFontRules(f), '#show heading: set text(font: "Source Sans 3")\n')
  assert.equal(typstFontRules({}), "")
  const title = uiTitle(f, [{ t: "Str", c: "T" }])
  assert.deepEqual(
    title.map((i) => i.c[1] ?? i.c),
    ['#text(font: "Source Sans 3")[', "T", "]"],
  )
  const css = epubFontCss(f)
  assert.ok(
    css.includes(
      '@font-face { font-family: "Source Serif 4"; font-weight: 600; font-style: italic; src: url("../fonts/SourceSerif4-SemiboldIt.otf"); }',
    ),
  )
  assert.ok(css.includes('body { font-family: "Source Serif 4", serif; }'))
  assert.ok(
    css.includes(
      'h1, h2, h3, h4, h5, h6, .title, .subtitle, header { font-family: "Source Sans 3", sans-serif; }',
    ),
  )
  assert.ok(css.includes('code, pre, kbd, samp { font-family: "JetBrains Mono", monospace; }'))
  const xml = `<style:font-face style:name="Times New Roman" svg:font-family="'Times New Roman'"/><style:font-face style:name="Arial" svg:font-family="Arial"/><s fo:font-name="Courier New" svg:font-family="&apos;Courier New&apos;"/>`
  assert.equal(
    odtStyles(xml, f),
    `<style:font-face style:name="Source Serif 4" svg:font-family="'Source Serif 4'"/><style:font-face style:name="Source Sans 3" svg:font-family="Source Sans 3"/><s fo:font-name="JetBrains Mono" svg:font-family="&apos;JetBrains Mono&apos;"/>`,
  )
  assert.equal(odtStyles(xml, { text: null, ui: null, mono: null }), xml)
})
