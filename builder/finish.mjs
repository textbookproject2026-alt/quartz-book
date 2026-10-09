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
  HISTORY_PAGE,
  HISTORY_PATH,
  slugUrl,
  MARKER_PATH,
  buildCatalog,
  NOINDEX_HEADERS,
  addCanonical,
  addAfterArticle,
  addAfterTitle,
  bylineHtml,
  creatorsOf,
  creditsBlockHtml,
  creditsFootHtml,
  CREDIT_OVERRIDES,
  editorsOf,
  pageAnchor,
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
  setPlatform,
} from "./lib.mjs"
import { citeData } from "./citations.mjs"
import {
  applyOverrides,
  isAutomation,
  pageContributors,
} from "../automation/scripts/lib/credits.mjs"

const [workDir, outDir] = process.argv.slice(2)
const facts = JSON.parse(readFileSync(join(workDir, "facts.json"), "utf8"))
setPlatform(facts.platformPeople)

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
  .filter(
    ([, v]) => v.filePath && ![`${HOW_TO_COMMENT}.md`, `${HISTORY_PAGE}.md`].includes(v.filePath),
  )
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
const catalogPages = pages.map(({ relPath, slug }) => ({
  relPath,
  slug,
  title: index[slug].title,
  ...sourceOf(relPath),
  created: revisions[relPath]?.at(-1)?.date ?? "",
  indexedTags: index[slug].tags ?? [],
  links: index[slug].links ?? [],
}))

// The credit ledger (community/credits.json, written weekly by the book's
// contributors workflow), with community/credit-overrides.yml applied again, so a
// change to the overrides shows at this build. Listed authors and editors (any
// page's frontmatter) aren't contributors. A book with no ledger has no credits.
const readOptional = (rel, parse) => {
  const file = join(workDir, "content", rel)
  if (!existsSync(file)) return null
  try {
    return parse(readFileSync(file, "utf8"))
  } catch (err) {
    console.warn(
      `::warning title=credits::${rel} can't be read (${err.message}); left out of this build.`,
    )
    return null
  }
}
// Only people (batch 2b): a ledger written before the automation-accounts list
// grew still never shows a machine, an AI tool or the platform's own account.
const automation = isAutomation(facts.platformPeople ?? {})
const readLedger = readOptional("community/credits.json", JSON.parse)
const rawLedger = readLedger && {
  ...readLedger,
  contributors: (readLedger.contributors ?? []).filter((p) => !automation(p)),
}
const listed = catalogPages.flatMap((p) => [
  ...creatorsOf(p.frontmatter),
  ...editorsOf(p.frontmatter),
])
const ledger = rawLedger
  ? applyOverrides(rawLedger, readOptional(CREDIT_OVERRIDES, YAML.parse) ?? {}, listed)
  : null
const catalog = buildCatalog({ facts, commits, pages: catalogPages, credits: ledger })
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
const contributorsPage = pages.some((p) => p.relPath === "community/contributors.md")
  ? "/community/contributors"
  : ""
const relPathOf = new Map(pages.map((p) => [p.slug, p.relPath]))
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
    const relPath = relPathOf.get(slug)
    const front = slug === "index"
    // The front page acknowledges everyone; a page, those who changed it.
    const contributors = !ledger
      ? []
      : front
        ? ledger.contributors.map(({ name, github }) => ({ name, ...(github ? { github } : {}) }))
        : pageContributors(ledger, relPath)
    const cite = citeData(cslItem(meta), bookItem)
    html = addToHead(
      html,
      headTags(meta, { contributors }) +
        `<script type="application/json" id="tb-cite">${scriptJson(cite)}</script>`,
      url,
    )
    if (front) {
      html = addAfterTitle(
        html,
        creditsBlockHtml(meta, ledger ? contributors.length : 0, contributorsPage),
      )
    } else if (!relPath.startsWith("community/")) {
      html = addAfterTitle(html, bylineHtml(meta))
      html = addAfterArticle(
        html,
        creditsFootHtml(
          contributors,
          contributorsPage && `${contributorsPage}#${pageAnchor(relPath)}`,
        ),
      )
    }
  }
  writeFileSync(file, html)
}

// The book's version history (prepare.mjs; lib.mjs, "Version history"), with each
// page's address as Quartz made it.
const historyData = JSON.parse(readFileSync(join(workDir, "history-data.json"), "utf8"))
const slugOfRel = new Map(pages.map((p) => [p.relPath, p.slug]))
for (const p of historyData.pages)
  if (slugOfRel.has(p.source)) p.path = slugUrl(slugOfRel.get(p.source))
write(HISTORY_PATH, JSON.stringify(historyData) + "\n")

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
