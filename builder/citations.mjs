// Citations at build time (batch 1, step 3): each page's CSL-JSON (lib.mjs,
// cslItem) formatted in the four styles the Cite dialog offers, with
// citation-js and the CSL styles vendored in builder/csl/ (from
// citation-style-language/styles f2c83bb and locales a89adec).
//
// citation-js is CommonJS: its ESM entry and the CSL plugin would register on
// two different copies, so both are loaded with require.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const { Cite, plugins } = require("@citation-js/core")
require("@citation-js/plugin-csl")

const CSL = join(import.meta.dirname, "csl")

/** The dialog's styles: key -> [CSL file, locale]. */
export const STYLES = {
  apa: ["apa", "en-US"],
  chicago: ["chicago-author-date", "en-US"],
  mla: ["modern-language-association", "en-US"],
  harvard: ["harvard-cite-them-right", "en-GB"],
}

const csl = plugins.config.get("@csl")
for (const [key, [file]] of Object.entries(STYLES))
  csl.styles.add(`tb-${key}`, readFileSync(join(CSL, `${file}.csl`), "utf8"))
csl.locales.add("en-GB", readFileSync(join(CSL, "locales-en-GB.xml"), "utf8"))

/**
 * The access date the styles are given: an impossible day the page's script
 * replaces with the reader's (only Cite Them Right prints one). As each style's
 * locale writes it.
 */
export const ACCESSED = { "date-parts": [[2999, 12, 31]] }
export const ACCESSED_TEXT = { "en-US": "December 31, 2999", "en-GB": "31 December 2999" }
export const ACCESSED_MARK = "{accessed}"

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }
const unescape = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) =>
    e[0] !== "#"
      ? (ENTITIES[e] ?? all)
      : String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
        ),
  )

/**
 * citeproc's HTML entry as runs, { text, italic? }: the Cite dialog sets them
 * with textContent, so no HTML from here reaches the page. Only <i> survives.
 */
export function runsOf(html) {
  const body = html.replace(/^[\s\S]*?<div class="csl-entry">/, "").replace(/<\/div>[\s\S]*$/, "")
  const runs = []
  for (const [i, part] of body.split(/<\/?i>/).entries()) {
    const text = unescape(part.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ")
    if (text) runs.push(i % 2 ? { text, italic: true } : { text })
  }
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart()
    runs.at(-1).text = runs.at(-1).text.trimEnd()
  }
  return runs
}

/** One item in every style: { apa: runs, chicago: runs, … }, the access date marked. */
export function formatAll(item) {
  const out = {}
  for (const [key, [, lang]] of Object.entries(STYLES)) {
    const html = new Cite({ ...item, accessed: ACCESSED }).format("bibliography", {
      format: "html",
      template: `tb-${key}`,
      lang,
    })
    out[key] = runsOf(html).map((r) => ({
      ...r,
      text: r.text.replaceAll(ACCESSED_TEXT[lang], ACCESSED_MARK),
    }))
  }
  return out
}

/**
 * The page's Cite data: the CSL-JSON of the page and of its book (one item on
 * the front page), and each formatted in every style. Embedded in the page as
 * <script type="application/json" id="tb-cite">.
 */
export function citeData(pageItem, bookItem) {
  const chapter = pageItem.id === bookItem.id ? null : pageItem
  return {
    version: 1,
    chapter,
    book: bookItem,
    styles: {
      ...(chapter ? { chapter: formatAll(chapter) } : {}),
      book: formatAll(bookItem),
    },
  }
}
