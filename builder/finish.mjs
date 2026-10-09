// Step 3 of build-book.sh: what the builder adds to Quartz's output, then the
// check that the output holds nothing it shouldn't.
//
//   node builder/finish.mjs <work dir> <out dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import YAML from "yaml"
import {
  CATALOG_PATH,
  HISTORY_DIR,
  HOW_TO_COMMENT,
  MARKER_PATH,
  buildCatalog,
  NOINDEX_HEADERS,
  addCanonical,
  addToHead,
  cslItem,
  headTags,
  scriptJson,
  orderFolderListing,
  htmlUrl,
  marker,
  SERVES,
  outputAllowed,
  redirectsFile,
  strayMessage,
  walkFiles,
} from "./lib.mjs"
import { citeData } from "./citations.mjs"

const [workDir, outDir] = process.argv.slice(2)
const facts = JSON.parse(readFileSync(join(workDir, "facts.json"), "utf8"))

const rel = (file) => relative(outDir, file).split(sep).join("/")
const write = (path, text) => {
  mkdirSync(dirname(join(outDir, path)), { recursive: true })
  writeFileSync(join(outDir, path), text)
}

// Every page's source and slug, from Quartz's own content index, so the
// redirects use Quartz's slugs rather than a copy of its slug rules.
const index = JSON.parse(readFileSync(join(outDir, "static/contentIndex.json"), "utf8"))
// Folder and tag listings have a filePath too, but no file: Publish never had them.
const pages = Object.entries(index)
  .filter(([, v]) => v.filePath && v.filePath !== `${HOW_TO_COMMENT}.md`)
  .filter(([, v]) => existsSync(join(workDir, "content", v.filePath)))
  .map(([slug, v]) => ({ relPath: v.filePath, slug }))
if (pages.length === 0) throw new Error("Quartz's content index lists no pages.")

write("_redirects", redirectsFile(pages, facts))
if (facts.noindex) write("_headers", NOINDEX_HEADERS)
write(MARKER_PATH, JSON.stringify({ ...marker(facts), serves: SERVES }, null, 2) + "\n")

// The catalog the portal reads (lib.mjs, "The book's catalog"). Frontmatter
// is read from the staged source; a page whose frontmatter doesn't parse is
// still listed, with none.
const sourceOf = (relPath) => {
  const src = readFileSync(join(workDir, "content", relPath), "utf8").trimStart()
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src)
  const markdown = (m ? src.slice(m[0].length) : src).replace(/\r\n/g, "\n")
  if (!m) return { frontmatter: {}, markdown }
  try {
    const fm = YAML.parse(m[1])
    return { frontmatter: fm && typeof fm === "object" && !Array.isArray(fm) ? fm : {}, markdown }
  } catch {
    return { frontmatter: {}, markdown }
  }
}
// Each page's revisions, newest first (lib.mjs, "Page history"): the History
// panel's lists, and the date of each file's first commit for the metadata.
const revisions = JSON.parse(readFileSync(join(workDir, "revisions.json"), "utf8"))
const historyFile = join(workDir, "history.json")
const commits = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, "utf8")) : []
const catalog = buildCatalog({
  facts,
  commits,
  pages: pages.map(({ relPath, slug }) => ({
    relPath,
    slug,
    title: index[slug].title,
    ...sourceOf(relPath),
    created: revisions[relPath]?.at(-1)?.date ?? "",
    indexedTags: index[slug].tags ?? [],
    links: index[slug].links ?? [],
  })),
})
write(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n")

// Every page: its canonical link, a listing in Contents order, and on the
// book's own pages the citation metadata (Highwire, Dublin Core, JSON-LD) and
// the Cite dialog's data (lib.mjs, "In every page's head"; citations.mjs).
const metaBySlug = new Map(
  catalog.pages
    .filter((p) => p.metadata)
    .map((p) => [pages.find((x) => x.relPath === p.source).slug, p.metadata]),
)
const bookItem = cslItem(catalog.metadata)
for (const file of walkFiles(outDir)) {
  const path = rel(file)
  const url = htmlUrl(path)
  if (!url) continue
  const slug = path.slice(0, -".html".length)
  let html = readFileSync(file, "utf8")
  html = addCanonical(html, facts.domain, url)
  html = orderFolderListing(html, slug, facts.contentsOrder ?? [])
  const meta = metaBySlug.get(slug)
  if (meta) {
    const cite = citeData(cslItem(meta), bookItem)
    html = addToHead(
      html,
      headTags(meta) + `<script type="application/json" id="tb-cite">${scriptJson(cite)}</script>`,
      url,
    )
  }
  writeFileSync(file, html)
}

// Each page's revision list, for the History panel.
for (const { relPath, slug } of pages)
  if (revisions[relPath])
    write(`${HISTORY_DIR}/${slug}.json`, JSON.stringify(revisions[relPath]) + "\n")

// The allowlist, checked on what was actually produced (§8 step 8): a file from
// outside it fails the build rather than going live.
const files = walkFiles(outDir).map(rel)
const stray = files.filter((p) => !outputAllowed(p))
if (stray.length) {
  console.error(`build-book: refused: ${strayMessage(stray)}`)
  process.exit(2)
}
console.log(
  `finish: ${files.length} files, ${pages.length} pages; marker at /${MARKER_PATH}, catalog at /${CATALOG_PATH} (${catalog.recent.length} recent changes)`,
)
