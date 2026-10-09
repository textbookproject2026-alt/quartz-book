// Step 4 of build-book.sh: the downloads. Per chapter a PDF and an EPUB, for
// the whole book a PDF, an EPUB and an ODT, in /downloads/, from the same
// sources as the site (lib.mjs, "Exports"). Each page's head gains the files it
// has (<script id="tb-downloads">, for edit-on-github's Download menu) and
// citation_pdf_url; each file a dateless alias, a redirect in _redirects.
//
//   node builder/export.mjs <work dir> <out dir>
//
// It never fails the build: an export that fails or is too large is left out
// with a warning (a GitHub annotation in Actions), and the site publishes
// without it. TB_EXPORTS=off skips them all (design previews that don't touch
// the exports). PANDOC and TYPST name the binaries (default: on the PATH).
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  CATALOG_PATH,
  EXPORT_DIR,
  EXPORT_FORMATS,
  EXPORT_MAX_BYTES,
  chapterSlugs,
  cslItem,
  exportMeta,
  exportName,
  frontPage,
  linkResolver,
  numberBlocks,
  pandocWords,
  preprocessMarkdown,
  splitTitle,
  withoutContents,
} from "./lib.mjs"
import { formatAll } from "./citations.mjs"

const [workDir, outDir] = process.argv.slice(2)
const PANDOC = process.env.PANDOC || "pandoc"
const TYPST = process.env.TYPST || "typst"
const started = Date.now()
// Paragraph numbers in the margin, as the site draws them.
const TYPST_HEADER = `#let pnum(n) = [#h(0pt, weak: true)#box(width: 0pt, move(dx: -2.6em, text(size: 0.7em, fill: luma(110), str(n))))]
`
const warnings = []
const warn = (msg) => {
  warnings.push(msg)
  console.log(`::warning title=export::${msg}`)
}

if (process.env.TB_EXPORTS === "off") {
  console.log("export: skipped (TB_EXPORTS=off)")
  process.exit(0)
}

const run = (cmd, args, input) =>
  execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  })

try {
  for (const [name, cmd] of [
    ["pandoc", PANDOC],
    ["typst", TYPST],
  ]) {
    try {
      console.log(`export: ${run(cmd, ["--version"]).split("\n")[0]}`)
    } catch {
      throw new Error(`${name} is not installed (${cmd}), so there are no downloads in this build.`)
    }
  }
  main()
} catch (err) {
  warn(err.message)
}
console.log(
  `export: ${((Date.now() - started) / 1000).toFixed(1)}s, ${warnings.length ? `${warnings.length} warning(s)` : "no warnings"}`,
)

function main() {
  const facts = JSON.parse(readFileSync(join(workDir, "facts.json"), "utf8"))
  const catalog = JSON.parse(readFileSync(join(outDir, CATALOG_PATH), "utf8"))
  const content = join(workDir, "content")
  const book = catalog.metadata
  if (!book)
    throw new Error("the catalog has no metadata, so there are no downloads in this build.")
  const date = book.published || "undated"
  const version = facts.bookCommit.slice(0, 7)

  const sourceOf = (relPath) => {
    const file = join(content, relPath)
    if (!existsSync(file)) return null
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimStart()
    const m = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(src)
    return m ? src.slice(m[0].length) : src
  }
  const files = walk(content)
  const findFile = (name) => {
    const want = name.toLowerCase()
    return (
      files.find((f) => f.toLowerCase() === want) ??
      files.find((f) => f.toLowerCase().endsWith(`/${want}`)) ??
      null
    )
  }
  const pages = catalog.pages.map((p) => ({ ...p, relPath: p.source, slug: slugOfPath(p.path) }))
  const resolve = linkResolver(pages, facts.domain)
  const htmlOf = (p) => join(outDir, `${p.slug}.html`)
  const webCount = (p) => {
    const file = htmlOf(p)
    return existsSync(file)
      ? (readFileSync(file, "utf8").match(/<p[^>]*\sdata-pnum="/g) ?? []).length
      : -1
  }

  // The book's reading order: index.md's Contents, then any page it misses.
  const order = facts.contentsOrder ?? []
  const rank = (p) => (order.indexOf(p.slug) === -1 ? order.length : order.indexOf(p.slug))
  const inOrder = pages.filter((p) => p.path !== "/").sort((a, b) => rank(a) - rank(b))
  const chapters = inOrder.filter((p) => p.metadata?.type !== "concept")
  const names = chapterSlugs(chapters.map((p) => p.slug))

  /** A page as pandoc blocks: preprocessed, read by pandoc, numbered as the site is (if it agrees). */
  let apiVersion = null
  const numbering = []
  const blocksOf = (p, body) => {
    const md = preprocessMarkdown(body, { relPath: p.relPath, resolve, source: sourceOf, findFile })
    const ast = JSON.parse(run(PANDOC, ["-f", "commonmark_x", "-t", "json"], md))
    apiVersion = ast["pandoc-api-version"]
    const site = webCount(p)
    const ours = numberBlocks(structuredClone(ast.blocks))
    const same = site === ours
    numbering.push({ page: p.path, site, export: ours })
    if (!same)
      warn(
        `${p.path}: the site numbers ${site} paragraphs, the export ${ours}; no paragraph numbers in its PDF.`,
      )
    if (same) numberBlocks(ast.blocks, true)
    return ast.blocks
  }
  const doc = (meta, blocks) => ({
    "pandoc-api-version": apiVersion,
    meta: exportMeta(meta),
    blocks,
  })
  const front = (meta) => frontPage(meta, { version, apa: formatAll(cslItem(meta)).apa })

  mkdirSync(join(outDir, EXPORT_DIR), { recursive: true })
  const made = new Map() // page path ("/" for the book) -> { ext: url path }
  const header = join(workDir, "export-header.typ")
  writeFileSync(header, TYPST_HEADER)

  const write = (key, chapter, ext, make) => {
    const name = exportName(facts.slug, chapter, date, ext)
    const out = join(outDir, EXPORT_DIR, name)
    try {
      make(out)
      const size = statSync(out).size
      if (size > EXPORT_MAX_BYTES) {
        rmSync(out)
        throw new Error(
          `${(size / 1048576).toFixed(1)} MiB, over the ${EXPORT_MAX_BYTES / 1048576} MiB limit`,
        )
      }
      made.set(key, { ...made.get(key), [ext]: `/${EXPORT_DIR}/${name}` })
    } catch (err) {
      rmSync(out, { force: true })
      warn(
        `${name} was not made: ${String(err.stderr || err.message)
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ")}`,
      )
    }
  }
  const pdf = (json, toc) => (out) => {
    const typ = join(content, `.tb-export-${process.pid}.typ`)
    try {
      writeFileSync(
        typ,
        run(
          PANDOC,
          ["-f", "json", "-t", "typst", "-s", "--wrap=none", "-V", "papersize=a4", "-H", header],
          JSON.stringify(json),
        ).replace("#outline-here", toc ? "#outline(depth: 2)\n#pagebreak()" : ""),
      )
      run(TYPST, ["compile", "--root", content, typ, out])
    } finally {
      rmSync(typ, { force: true })
    }
  }
  const pandocTo =
    (format, json, extra = []) =>
    (out) =>
      run(
        PANDOC,
        [
          "-f",
          "json",
          "-t",
          format,
          "--wrap=none",
          `--resource-path=${content}`,
          "-o",
          out,
          ...extra,
        ],
        JSON.stringify(json),
      )

  // Each chapter.
  const bodies = new Map()
  for (const p of inOrder) {
    const { title, body } = splitTitle(sourceOf(p.relPath) ?? "")
    bodies.set(p.path, { title: title || p.metadata?.title || p.title, blocks: blocksOf(p, body) })
  }
  for (const p of chapters) {
    const { blocks } = bodies.get(p.path)
    const json = doc(p.metadata, [...front(p.metadata), ...blocks])
    write(p.path, names.get(p.slug), "pdf", pdf(json, false))
    write(p.path, names.get(p.slug), "epub", pandocTo("epub3", json))
  }

  // The whole book: index.md's own text (no Contents list), then every page.
  const index = pages.find((p) => p.path === "/")
  const intro = index ? splitTitle(withoutContents(sourceOf(index.relPath) ?? "")).body : ""
  const introAst = JSON.parse(
    run(
      PANDOC,
      ["-f", "commonmark_x", "-t", "json"],
      index
        ? preprocessMarkdown(intro, { relPath: index.relPath, resolve, source: sourceOf, findFile })
        : "",
    ),
  )
  apiVersion ??= introAst["pandoc-api-version"]
  const introBlocks = introAst.blocks
  const chapterBlocks = inOrder.flatMap((p) => {
    const { title, blocks } = bodies.get(p.path)
    return [
      { t: "RawBlock", c: ["typst", "#pagebreak(weak: true)"] },
      { t: "Header", c: [1, ["", [], []], pandocWords(title)] },
      ...blocks,
    ]
  })
  const outline = { t: "RawBlock", c: ["typst", "#outline-here"] }
  const bookJson = doc(book, [...front(book), outline, ...introBlocks, ...chapterBlocks])
  write("/", "", "pdf", pdf(bookJson, true))
  write("/", "", "epub", pandocTo("epub3", bookJson, ["--toc"]))
  write("/", "", "odt", pandocTo("odt", bookJson, ["--toc"]))

  // Dateless aliases, as redirects to today's files.
  const aliases = []
  for (const files of made.values())
    for (const url of Object.values(files))
      aliases.push(`${url.replace(/-\d{4}-\d{2}-\d{2}(?=\.[a-z]+$)/, "")} ${url} 302`)
  if (aliases.length)
    writeFileSync(
      join(outDir, "_redirects"),
      `${readFileSync(join(outDir, "_redirects"), "utf8").trimEnd()}\n${aliases.join("\n")}\n`,
    )

  // Each page's head: its files and the book's, and citation_pdf_url.
  const bookFiles = made.get("/") ?? {}
  for (const p of pages) {
    const file = htmlOf(p)
    if (!existsSync(file)) continue
    const own = p.path === "/" ? null : (made.get(p.path) ?? null)
    const pdfUrl = (p.path === "/" ? bookFiles : (own ?? {})).pdf
    let html = readFileSync(file, "utf8")
    const data = JSON.stringify({
      chapter: own,
      book: Object.keys(bookFiles).length ? bookFiles : null,
    }).replace(/</g, "\\u003c")
    html = html.replace(
      "</head>",
      `<script type="application/json" id="tb-downloads">${data}</script></head>`,
    )
    if (pdfUrl)
      html = html.replace(
        /(<meta name="citation_public_url" content="[^"]*">)/,
        `$1<meta name="citation_pdf_url" content="https://${facts.domain}${pdfUrl}">`,
      )
    writeFileSync(file, html)
  }

  const count = [...made.values()].reduce((n, f) => n + Object.keys(f).length, 0)
  const numbered = numbering.filter((n) => n.site === n.export).length
  console.log(
    `export: ${count} files in /${EXPORT_DIR}/; paragraph numbers in ${numbered} of ${numbering.length} pages' PDFs`,
  )
  writeFileSync(
    join(workDir, "export-report.json"),
    JSON.stringify({ numbering, warnings, files: Object.fromEntries(made) }, null, 2),
  )
}

function walk(dir, base = "") {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return []
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory() ? walk(dir, rel) : [rel]
  })
}

function slugOfPath(path) {
  if (path === "/") return "index"
  return path.endsWith("/") ? `${path.slice(1)}index` : path.slice(1)
}
