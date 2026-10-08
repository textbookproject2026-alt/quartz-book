// The builder's decisions, as pure functions (BOOK-ONE-TO-QUARTZ §0). Everything
// that reads the disk or runs a process is in prepare.mjs and finish.mjs; this
// file is what test/ exercises.
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { join } from "node:path"

export const REGISTRY_URL =
  "https://raw.githubusercontent.com/textbookproject2026-alt/textbook-registry/main/registry.json"

/**
 * What the builder publishes from a book repo (D3). Everything else in the repo
 * is ignored, not just left unlinked: Quartz copies every non-Markdown file it
 * finds, so without this a build publishes configure.mjs, LICENSE and admin/.
 */
export const ALLOWLIST = ["index.md", "chapters", "assets", "glossary.md", "community"]

/** The reader page the builder adds to every book (D5). */
export const HOW_TO_COMMENT = "how-to-comment"

export const MARKER_PATH = ".well-known/textbook.json"

export class BuildRefused extends Error {}

const refuse = (message) => {
  throw new BuildRefused(message)
}

/** The book's entry, or a refusal saying why the builder won't build it. */
export function findBook(registry, slug) {
  if (!slug)
    refuse('textbook.config.json has no "slug", so the book cannot be found in the registry.')
  const book = registry?.books?.find((b) => b.slug === slug)
  if (!book) refuse(`no book with slug "${slug}" in the registry.`)
  if (book.status === "retired")
    refuse(`book "${slug}" is retired. The builder does not build retired books.`)
  if (!book.site?.domain) refuse(`book "${slug}" has no site.domain.`)
  if (!book.content?.repo) refuse(`book "${slug}" has no content.repo.`)
  if (!book.content?.live_branch) refuse(`book "${slug}" has no content.live_branch.`)
  return book
}

/**
 * Every per-book value the build uses, from the registry alone. This replaces
 * configure.mjs and templates/publish.js for the site (§0).
 */
export function bookOptions(registry, book, branch, { preview = false } = {}) {
  if (!branch) refuse("no branch given. Say which branch this build is for.")
  const suggestEnabled = book.suggest_edit?.enabled === true
  const endpoint = registry.platform?.suggest_edit_endpoint ?? ""
  if (suggestEnabled && !endpoint)
    refuse(
      `book "${book.slug}" has suggest_edit enabled, but the registry has no platform.suggest_edit_endpoint.`,
    )
  // D19 (§8 step 17a): the platform's one Plausible site, and only for a live
  // book, so a preview book on *.pages.dev never counts. The registry always
  // states platform.analytics (null for no analytics anywhere), so a missing
  // field is a typo, not "no analytics".
  if (registry.platform?.analytics === undefined)
    refuse("the registry has no platform.analytics. Give the platform's Plausible site, or null.")
  const counted = book.status === "live"
  const plausibleSrc = registry.platform.analytics?.plausible?.script_src ?? ""
  return {
    slug: book.slug,
    title: book.title,
    domain: book.site.domain,
    repo: book.content.repo,
    branch,
    liveBranch: book.content.live_branch,
    // D13: every branch but the live one is a preview: public, but noindex. So
    // is a design preview of the live branch (§4b), deployed beside it.
    noindex: preview || branch !== book.content.live_branch,
    // Shown only for books with suggest-edit on. Elsewhere the function would
    // answer 403, so the button stays hidden (edit-on-github's "" default).
    suggestEndpoint: suggestEnabled ? endpoint : "",
    // The History panel's revision endpoint, beside suggest-edit, for every
    // book: reading history isn't suggesting, so suggest_edit doesn't gate it.
    revisionEndpoint: endpoint ? revisionEndpoint(endpoint, book.slug) : "",
    plausibleScriptSrc: counted ? plausibleSrc : "",
    licence: book.licence,
    authors: book.maintainer?.name ?? "",
    editionTemplateRepo: book.editions?.template_repo ?? null,
  }
}

/** suggest-edit-function's /api/page-revision for this book, beside /api/suggest-edit. */
export const revisionEndpoint = (suggestEndpoint, slug) => {
  const url = new URL("page-revision", suggestEndpoint)
  url.searchParams.set("book", slug)
  return url.toString()
}

/** JSON with keys sorted at every level, so a digest doesn't depend on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`
  return JSON.stringify(value ?? null)
}

/**
 * The registry half of the build key (§0a). It covers the book's entry and the
 * platform values a build reads (the suggest-edit endpoint and the Plausible
 * site), so a change to either rebuilds the book, and a change to another
 * book's entry doesn't.
 */
export function registryDigest(registry, book) {
  const platform = {
    suggest_edit_endpoint: registry.platform?.suggest_edit_endpoint ?? null,
    analytics: registry.platform?.analytics ?? null,
  }
  const input = canonicalJson({ book, platform })
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

const LICENCE_URLS = {
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
  "CC-BY-NC-4.0": "https://creativecommons.org/licenses/by-nc/4.0/",
  "CC-BY-NC-SA-4.0": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
}

export const licenceLink = (id) => ({
  [`Licence (${id})`]:
    LICENCE_URLS[id] ?? `https://spdx.org/licenses/${encodeURIComponent(id)}.html`,
})

/**
 * Quartz's config for one book: the shared config with the "SET PER BOOK"
 * values filled in. `config` is the parsed quartz.config.yaml; it isn't changed.
 * `explorerOrder` is the book's contentsOrder().
 */
export function renderConfig(config, opts, ignorePatterns, explorerOrder = []) {
  const out = structuredClone(config)
  out.configuration.pageTitle = opts.title
  out.configuration.baseUrl = opts.domain
  out.configuration.ignorePatterns = ignorePatterns
  const plugin = (name) => {
    const found = out.plugins.find((p) =>
      typeof p.source === "object"
        ? p.source.name === name
        : p.source === `github:quartz-community/${name}`,
    )
    if (!found) throw new Error(`quartz.config.yaml has no ${name} plugin.`)
    return found
  }
  plugin("footer").options.links = licenceLink(opts.licence)
  Object.assign(plugin("edition-integrations").options, {
    plausibleScriptSrc: opts.plausibleScriptSrc,
    siteDomain: opts.domain,
    explorerOrder,
  })
  Object.assign(plugin("edit-on-github").options, {
    repo: opts.repo,
    branch: opts.branch,
    contentDir: "",
    suggestEndpoint: opts.suggestEndpoint,
    revisionEndpoint: opts.revisionEndpoint,
    authors: opts.authors ?? "",
    licence: opts.licence ?? "",
    // What each page was built from (the editor says when drafts has moved on).
    sourceCommit: opts.sourceCommit ?? "",
    sourceBlobs: opts.sourceBlobs ?? {},
  })
  return out
}

/**
 * `git ls-tree -r -z` output as { repo path: blob sha }, for the .md files: what
 * edit-on-github stamps on each page as data-source-blob.
 */
export function parseLsTree(out) {
  const blobs = {}
  for (const entry of out.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+\.md)$/.exec(entry)
    if (m) blobs[m[2]] = m[1]
  }
  return blobs
}

/**
 * index.md with every published page in its Contents (decision of 8 Oct 2026:
 * the explorer and the Contents always match). `pages` is [{ path, title }],
 * repo paths of the pages the explorer shows (bookPages()). Each one no item
 * links to is added at the end of the list, as `[[target|title]]` in the list's
 * own marker (the next number for a numbered list). With no "## Contents"
 * heading and something to add, the heading goes at the end of the page.
 * Returns { text, added: [paths] }; text is unchanged when nothing is missing.
 */
export function completeContents(indexMarkdown, pages) {
  const listed = new Set(contentsOrder(indexMarkdown))
  const missing = pages.filter((p) => !listed.has(pageSlug(p.path)))
  if (!missing.length) return { text: indexMarkdown, added: [] }
  const eol = indexMarkdown.includes("\r\n") ? "\r\n" : "\n"
  const lines = indexMarkdown.split(/\r?\n/)
  let start = lines.findIndex((l) => /^##\s+Contents\s*$/i.test(l))
  if (start === -1) {
    while (lines.length && !lines.at(-1).trim()) lines.pop()
    lines.push(...(lines.length ? [""] : []), "## Contents", "")
    start = lines.length - 2
  }
  let end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l))
  if (end === -1) end = lines.length
  const ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))\s/
  // After the last item and the lines indented under it.
  let last = -1
  for (let i = start + 1; i < end; i++) if (ITEM.test(lines[i])) last = i
  let at = last
  if (last !== -1) while (at + 1 < end && /^\s+\S/.test(lines[at + 1])) at++
  const m = last === -1 ? null : ITEM.exec(lines[last])
  let n = m?.[3] ? Number(m[3]) : 0
  const marker = () => (m?.[3] ? `${++n}${m[4]}` : (m?.[2] ?? "-"))
  const label = (t) => t.replace(/\s+/g, " ").trim().replace(/\|/g, "-").replace(/\]\]/g, "] ]")
  const items = missing.map((p) => `${m?.[1] ?? ""}${marker()} [[${p.path.replace(/\.md$/i, "")}|${label(p.title)}]]`)
  if (last === -1) lines.splice(start + 1, 0, "", ...items, ...(start + 1 < lines.length && lines[start + 1].trim() ? [""] : []))
  else lines.splice(at + 1, 0, ...items)
  return { text: lines.join(eol), added: missing.map((p) => p.path) }
}

/** A repo path as contentsOrder's slug: "chapters/Definitions/A b.md" -> "chapters/definitions/a-b". */
const pageSlug = (path) => path.replace(/\.md$/i, "").replace(/\s+/g, "-").toLowerCase()

/**
 * The pages the explorer shows from a book's files (repo paths, "/"-separated):
 * every .md under the allowlist but index.md files (the front page, a folder's
 * own page) and asset notes. The builder's how-to-comment page isn't the book's.
 */
export const bookPages = (paths) =>
  paths
    .filter((p) => /\.md$/i.test(p) && !/(^|\/)index\.md$/i.test(p) && !p.startsWith("assets/"))
    .filter((p) => ALLOWLIST.some((a) => p === a || p.startsWith(`${a}/`)))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }))

/** A page's title as Quartz shows it: front matter `title:`, else its first "# " heading, else its file name. */
export function pageTitle(markdown, path) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  const t = fm && /^title:\s*(.+?)\s*$/m.exec(fm[1])
  if (t) return t[1].replace(/^(["'])(.*)\1$/, "$2")
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(fm ? markdown.slice(fm[0].length) : markdown)
  return h ? h[1] : path.split("/").pop().replace(/\.md$/i, "")
}

/**
 * The book's reading order: the link targets, in order, of the list under
 * "## Contents" in its index.md (up to the next heading), as Quartz slugs, for
 * edition-integrations' explorerOrder. Each list item's first link counts:
 * [[target|label]], [[target]] or [label](target). A target loses a leading
 * ./ or /, a trailing .md and any #fragment; spaces become hyphens, and it is
 * lowercased, as Quartz's slugs are. No Contents heading (or no index.md,
 * passed as "") gives [].
 */
export function contentsOrder(indexMarkdown) {
  const lines = indexMarkdown.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Contents\s*$/i.test(l))
  if (start === -1) return []
  const order = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    if (!/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) continue
    const m = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(line)
    if (!m) continue
    let target = m[1] ?? m[2]
    try {
      target = decodeURI(target)
    } catch {
      // a stray %: keep it as written
    }
    const slug = target
      .split("#")[0]
      .trim()
      .replace(/^\.?\//, "")
      .replace(/\.md$/i, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
    if (slug) order.push(slug)
  }
  return order
}

/** Markdown under assets/ is the book's own notes (the authoring app's README), not pages. */
export const ASSET_NOTES = "assets/**/*.md"

/** Word-processor files an author drops into a content folder are sources, not pages. */
export const WORD_FILES = ["docx", "doc", "odt", "pages", "rtf"]
  .map((ext) => `**/*.${ext}`)
  .concat("**/*.pages/**") // a .pages document can be a folder

/**
 * Which of the book repo's paths become part of the site: a top-level name on the
 * allowlist (a file by name, a folder with everything in it), except the globs.
 * Written into the served marker, so a reader of the site (the author site's
 * going-live list) can tell reader-facing changes from behind-the-scenes ones by
 * the rule the deployed builder used, not a copy of it.
 */
export const SERVES = { paths: ALLOWLIST, except: [ASSET_NOTES, ...WORD_FILES] }

/**
 * Quartz ignorePatterns for everything at the top of the book repo that isn't on
 * the allowlist. `entries` are the repo root's names. Both the name and
 * everything under it are listed, so a folder is ignored whole.
 */
export function ignorePatternsFor(entries) {
  return entries
    .filter((name) => name !== ".git" && !ALLOWLIST.includes(name))
    .sort()
    .flatMap((name) => [name, `${name}/**`])
    .concat(ASSET_NOTES, WORD_FILES)
}

/** Quartz's slug for a root-level name, near enough to catch a collision. */
const looseSlug = (name) =>
  name
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")

/** A book's own file at the builder's /how-to-comment fails the build (§0). */
export function howToCommentClash(entries) {
  return entries.find((name) => looseSlug(name) === HOW_TO_COMMENT) ?? null
}

/**
 * The URL Obsidian Publish served a vault file at (publish.js:48-73): the path
 * without ".md", case kept, each segment percent-encoded, spaces as "+" (the
 * "plus" spelling) or as "%20". A root index.md was also served at /index.
 */
export function publishUrl(relPath, spelling = "plus") {
  return (
    "/" +
    relPath
      .replace(/\.md$/i, "")
      .split("/")
      .map((seg) => {
        const enc = encodeURIComponent(seg)
        return spelling === "plus" ? enc.replace(/%20/g, "+") : enc
      })
      .join("/")
  )
}

/** The path a Quartz slug is served at on Pages: no .html, index as its folder. */
export function slugUrl(slug) {
  if (slug === "index") return "/"
  if (slug.endsWith("/index")) return `/${slug.slice(0, -"index".length)}`
  return `/${slug}`
}

/**
 * The _redirects file (§3c, D14). `pages` pairs each source file (relative to
 * the repo root) with its Quartz slug. Every page whose Publish URL differs from
 * its Quartz URL gets a 301, in both the "+" and "%20" spellings. Harmless for a
 * book that was never on Publish: nobody requests those paths.
 */
export function redirectsFile(pages, opts) {
  const lines = []
  const seen = new Set()
  const add = (from, to) => {
    if (from === to || seen.has(from)) return
    seen.add(from)
    lines.push(`${from} ${to} 301`)
  }
  for (const { relPath, slug } of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const to = slugUrl(slug)
    add(publishUrl(relPath, "plus"), to)
    add(publishUrl(relPath, "pct"), to)
  }
  // Book one's two reader-facing docs pages (§3c). Their old addresses are
  // linked from outside; the book's own links are updated at §8 step 18.
  add("/docs/how-to-comment", `/${HOW_TO_COMMENT}`)
  if (opts.editionTemplateRepo)
    add(
      "/docs/for-course-coordinators",
      `https://github.com/${opts.editionTemplateRepo}/blob/main/docs/for-course-coordinators.md`,
    )
  return `# Generated by quartz-book's build-book.sh. Do not edit: it is rebuilt with the book.\n${lines.join("\n")}\n`
}

/** D13: a preview branch is public but never indexed. */
export const NOINDEX_HEADERS = "/*\n  X-Robots-Tag: noindex\n"

/** The page URL an output .html file is served at, or null for one with no page. */
export function htmlUrl(outPath) {
  if (!outPath.endsWith(".html") || outPath === "404.html") return null
  return slugUrl(outPath.slice(0, -".html".length))
}

/**
 * Adds <link rel="canonical"> on the book's own domain, so the production
 * pages.dev alias and the previews don't compete with it in search (§0). A page
 * that already has one (Quartz's alias redirects) keeps its own.
 *
 * The tag ends with an attribute after `href` on purpose. Quartz's popovers
 * (quartz/components/scripts/util.ts, fetchCanonical) take a tag of exactly
 * `<link rel="canonical" href="…">` to mean "this page is an alias redirect"
 * and fetch the href instead. Every page then fetched its live-domain twin: on
 * pages.dev that was cross-origin and blocked, so no popover showed, and a
 * drafts preview would have shown the live text (BOOK-ONE-TO-QUARTZ proof run,
 * F4). test/lib.test.mjs holds this against Quartz's own pattern.
 */
export function addCanonical(html, domain, url) {
  if (/<link rel="canonical"/.test(html)) return html
  const href = `https://${domain}${url
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/")}`
  const tag = `<link rel="canonical" href="${href}" data-builder="quartz-book">`
  if (!html.includes("</head>"))
    throw new Error(`no </head> to put the canonical link before (${url}).`)
  return html.replace("</head>", `${tag}</head>`)
}

/**
 * A folder or tag listing (folder-page's <ul class="section-ul">) in the
 * book's Contents order, as the explorer is: the plugin sorts by title alone,
 * and its sort option is a function, which quartz.config.yaml can't hold.
 * `order` is contentsOrder(); `pageSlug` is the listing page's own slug
 * ("chapters/index"), which its relative hrefs resolve against. A subfolder
 * ranks by its first listed page. Unlisted items follow, by title, with
 * Chapter 2 before Chapter 10. Items are moved whole, never rewritten. A page
 * without the list, or with one that doesn't cut cleanly, is returned unchanged.
 */
export function orderFolderListing(html, pageSlug, order) {
  const open = '<ul class="section-ul">'
  const start = html.indexOf(open)
  if (start === -1) return html
  // Cut the top-level <li>s by tracking depth: each holds a nested <ul class="tags">.
  const tag = /<(\/?)(ul|li)\b[^>]*>/g
  tag.lastIndex = start + open.length
  const items = []
  let depth = 0
  let itemStart = -1
  let last = tag.lastIndex
  let end = -1
  for (let m; (m = tag.exec(html)); ) {
    const closing = m[1] === "/"
    if (depth === 0) {
      if (closing && m[2] === "ul") {
        if (html.slice(last, m.index).trim()) return html
        end = m.index
        break
      }
      if (closing || m[2] !== "li" || html.slice(last, m.index).trim()) return html
      itemStart = m.index
      depth = 1
    } else if (closing) {
      if (--depth === 0) {
        if (m[2] !== "li") return html
        items.push(html.slice(itemStart, tag.lastIndex))
        last = tag.lastIndex
      }
    } else depth++
  }
  if (end === -1) return html

  const ranked = []
  for (const li of items) {
    const a = /<h3><a href="([^"]*)" class="internal">([\s\S]*?)<\/a><\/h3>/.exec(li)
    if (!a) return html
    let slug = new URL(a[1], `https://x/${pageSlug}`).pathname.slice(1)
    try {
      slug = decodeURIComponent(slug)
    } catch {
      // a stray %: keep it as written
    }
    // A subfolder's href ends in "/" (its slug is "<folder>/index").
    const rank =
      slug === "" || slug.endsWith("/")
        ? order.findIndex((s) => s.startsWith(slug))
        : order.indexOf(slug)
    ranked.push({ li, rank: rank === -1 ? order.length : rank, title: a[2] })
  }
  ranked.sort(
    (x, y) =>
      x.rank - y.rank ||
      x.title.localeCompare(y.title, undefined, { numeric: true, sensitivity: "base" }),
  )
  return html.slice(0, start + open.length) + ranked.map((r) => r.li).join("") + html.slice(end)
}

/** The build marker (§0). No timestamp: two builds of the same inputs are identical. */
export const marker = (facts) => ({
  slug: facts.slug,
  branch: facts.branch,
  book_commit: facts.bookCommit,
  registry_digest: facts.registryDigest,
  builder_commit: facts.builderCommit,
})

/** Paths Quartz itself generates, whatever the book holds. */
const QUARTZ_GENERATED = [
  /^404\.html$/,
  /^favicon\.ico$/,
  /^index\.xml$/,
  /^sitemap\.xml$/,
  /^static\//,
  /^tags\//,
  // Its hashed stylesheets and scripts.
  /^(index|component)-[0-9a-f]{8}\.css$/,
  /^(prescript|postscript)-[0-9a-f]{8}\.js$/,
]

/** What the builder adds. */
const BUILDER_GENERATED = [
  `${HOW_TO_COMMENT}.html`,
  "_redirects",
  "_headers",
  MARKER_PATH,
  ".well-known/textbook-catalog.json",
]

/** Each page's revision list, at HISTORY_DIR/<slug>.json (the History panel). */
export const HISTORY_DIR = ".well-known/history"

/**
 * Whether an output path may be published: it comes from an allowlisted
 * source, or Quartz or the builder generated it. `outPath` is relative to the
 * output directory, with "/" separators.
 */
export function outputAllowed(outPath) {
  if (BUILDER_GENERATED.includes(outPath)) return true
  if (outPath.startsWith(`${HISTORY_DIR}/`) && outPath.endsWith(".json")) return true
  if (QUARTZ_GENERATED.some((re) => re.test(outPath))) return true
  // A page's social preview image goes with its page.
  if (outPath.endsWith("-og-image.webp"))
    return outputAllowed(outPath.replace(/-og-image\.webp$/, ".html"))
  return ALLOWLIST.some((entry) =>
    entry.endsWith(".md")
      ? outPath === entry.replace(/\.md$/, ".html")
      : outPath.startsWith(`${entry}/`),
  )
}

export const strayMessage = (stray) =>
  `the output holds files from outside the allowlist (${ALLOWLIST.join(", ")}):\n  ${stray.join("\n  ")}`

/** Every file under `dir`, as absolute paths. */
export const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)],
  )

// ---------------------------------------------------------------------------
// reconcile (§0a, §8 step 9): which books and branches the builder looks
// after, where each one's served marker is, and whether it is current.

/** The value of a registry entry's site.host.builder that names this builder (§8 step 7). */
export const BUILDER_NAME = "quartz-book"

/**
 * Every (book, branch) pair reconcile looks after: each registered book whose
 * site.host.builder is this builder, and isn't retired, on its live branch and
 * its drafts branch, deployed to site.host.project. `slug` narrows the run to
 * one book.
 *
 * The host kind doesn't matter here. A static host is the site readers see. An
 * obsidian-publish host that names the builder (book one before its cutover,
 * §8 step 7 as amended on 24 Sep) is built the same way, and its project is a
 * preview only: readers are still served by Publish at site.domain.
 */
export function reconcileTargets(registry, { slug = "" } = {}) {
  const books = (registry?.books ?? []).filter(
    (b) => b.site?.host?.builder === BUILDER_NAME && b.status !== "retired",
  )

  const chosen = slug ? books.filter((b) => b.slug === slug) : books
  if (slug && chosen.length === 0) {
    const known = registry?.books?.some((b) => b.slug === slug)
    throw new Error(
      known
        ? `book "${slug}" is not on the builder: its registry entry has no site.host.builder "${BUILDER_NAME}", or it is retired.`
        : `no book with slug "${slug}" in the registry.`,
    )
  }

  return chosen.flatMap((book) => {
    const live = book.content.live_branch
    const drafts = book.content.drafts_branch
    const branches = drafts && drafts !== live ? [live, drafts] : [live]
    return branches.map((branch) => ({
      slug: book.slug,
      repo: book.content.repo,
      project: book.site.host.project,
      branch,
      live: branch === live,
    }))
  })
}

/**
 * The subdomain Pages gives a preview branch's latest deployment: lower case,
 * anything but a letter or digit as "-", at most 28 characters. A wrong guess
 * shows up as a failed check after the deploy, not as a silent miss.
 */
export const branchAlias = (branch) =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .slice(0, 28)

/**
 * Where a branch's build marker is served. The live branch is the project's
 * production branch, so it is on `<project>.pages.dev` whether or not a custom
 * domain is bound; any other branch is on its alias.
 */
export const markerUrl = ({ project, branch, live }) =>
  `https://${live ? "" : `${branchAlias(branch)}.`}${project}.pages.dev/${MARKER_PATH}`

/** A served marker is current when it names exactly what would be built now (§0a). */
export const markerCurrent = (served, want) =>
  !!served &&
  typeof served === "object" &&
  canonicalJson(marker(want)) ===
    canonicalJson({
      slug: served.slug,
      branch: served.branch,
      book_commit: served.book_commit,
      registry_digest: served.registry_digest,
      builder_commit: served.builder_commit,
    })

/** Why a served marker isn't current, for the run summary. */
export function markerDifference(served, want) {
  if (!served) return "nothing served yet"
  const w = marker(want)
  const fields = Object.keys(w).filter((k) => served[k] !== w[k])
  return fields.length ? `${fields.join(", ")} changed` : "current"
}

// ---------------------------------------------------------------------------
// The design preview gate (§4b, §8 step 11): the bot's pin pull request, the
// preview of every builder book it gets, and the `stable` tag that merging moves.

/** The tag `reconcile` builds from. A green CI run on main moves it there. */
export const STABLE_TAG = "stable"

/** The platform's plugins, quartz-edition-extras, as quartz.lock.json names their repo. */
export const EXTRAS_REPO = "https://github.com/textbookproject2026-alt/quartz-edition-extras.git"

const isSha = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)

/** Every extras plugin in the lock, with its pinned commit. */
export function extrasPins(lock) {
  const pins = Object.entries(lock?.plugins ?? {})
    .filter(([, p]) => p.resolved === EXTRAS_REPO)
    .map(([name, p]) => ({ name, commit: p.commit }))
  if (pins.length === 0) throw new Error(`quartz.lock.json pins nothing from ${EXTRAS_REPO}.`)
  return pins
}

/**
 * The lock with every extras plugin pinned at `commit`, and what moved. The
 * plugins move together: they come from one repo, and a book is built with one
 * extras commit. Nothing else in the lock changes, not even installedAt, so the
 * pull request's diff is the commits alone.
 */
export function bumpExtras(lock, commit) {
  if (!isSha(commit)) throw new Error(`"${commit}" is not a full commit hash.`)
  const changed = extrasPins(lock).filter((p) => p.commit !== commit)
  const plugins = { ...lock.plugins }
  for (const { name } of changed) plugins[name] = { ...plugins[name], commit }
  return {
    lock: { ...lock, plugins },
    changed: changed.map((p) => ({ name: p.name, from: p.commit, to: commit })),
  }
}

/** The bot's branch for a bump to `commit`: one per extras commit, ever. */
export const bumpBranch = (commit) => `bot/extras-${commit.slice(0, 7)}`

/** Only branches of this shape are ever deployed as design previews. */
export const PREVIEW_BRANCH = /^design-[1-9][0-9]*$/

/** The Pages branch a pull request's previews go to. */
export function previewBranch(pr) {
  const branch = `design-${String(pr).trim()}`
  if (!PREVIEW_BRANCH.test(branch)) throw new Error(`"${pr}" is not a pull request number.`)
  return branch
}

/**
 * One preview per book on the builder: its live branch, built by the pull
 * request's builder commit, deployed to its Pages project on `design-<pr>`
 * (§4b). The same books reconcile looks after, each once.
 */
export function previewTargets(registry, pr) {
  const preview = previewBranch(pr)
  return reconcileTargets(registry)
    .filter((t) => t.live)
    .map((t) => {
      const book = registry.books.find((b) => b.slug === t.slug)
      if ([book.content.live_branch, book.content.drafts_branch].includes(preview))
        throw new Error(
          `book "${t.slug}" has a branch named ${preview}, so its design preview would replace that branch's deployment.`,
        )
      return {
        slug: t.slug,
        repo: t.repo,
        project: t.project,
        branch: t.branch,
        preview,
        url: `https://${branchAlias(preview)}.${t.project}.pages.dev/`,
      }
    })
}

/** Marks the one comment the preview keeps up to date on a pull request. */
export const PREVIEW_COMMENT_TAG = "<!-- quartz-book design preview -->"

/**
 * The comment on the pull request: a row per book, saying whether its preview
 * serves this builder commit. `served[i]` is the marker served at targets[i]'s
 * preview, or null.
 */
export function previewComment({ pr, head, targets, served }) {
  const short = (sha) => `\`${String(sha).slice(0, 7)}\``
  const good = (t, m) => !!m && m.slug === t.slug && m.builder_commit === head
  const rows = targets.map((t, i) => {
    const m = served[i]
    const preview = good(t, m)
      ? `[${t.url.slice("https://".length, -1)}](${t.url})`
      : `**not ready**: ${m ? `serves builder ${short(m.builder_commit)}` : "serves no marker"}`
    const content = m?.book_commit ? `${t.branch} at ${short(m.book_commit)}` : t.branch
    return `| ${t.slug} | ${preview} | ${content} | ${good(t, m) ? "✅" : "❌"} |`
  })
  const ready = targets.filter((t, i) => good(t, served[i])).length
  return [
    PREVIEW_COMMENT_TAG,
    `### Design preview: ${ready} of ${targets.length} books`,
    "",
    `Each book on the builder, its live branch built by this pull request's builder commit ${short(head)}, on the Pages branch \`${previewBranch(pr)}\` (noindex). No book's production changes until this merges; then \`stable\` moves and \`reconcile\` rebuilds every book.`,
    "",
    "| Book | Preview | Content | |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// The book's catalog (platform portal): what the book holds, for the portal to
// read at its own build time. Books, pages, tags, concept pages, authors and
// recent changes. Built from Quartz's content index, the pages' frontmatter
// and the checkout's history, all read by prepare.mjs and finish.mjs; the
// functions here only shape it. No timestamp of its own, like the marker: the
// same inputs give the same file.

export const CATALOG_PATH = ".well-known/textbook-catalog.json"
export const CATALOG_VERSION = 1

/** How many recent page changes the catalog carries. The portal shows fewer. */
export const RECENT_LIMIT = 25

/** How many commits prepare.mjs reads for them. */
export const HISTORY_COMMITS = 60

/** An Obsidian tag as the portal compares it: no "#", lower case, trimmed. */
export const normaliseTag = (tag) =>
  String(tag ?? "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()

const asList = (value) =>
  (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)

/** A page's authors from its frontmatter: `authors` (a list, or "A, B") or `author`. */
export const authorsOf = (frontmatter = {}) => asList(frontmatter.authors ?? frontmatter.author)

/** Every tag a page carries: frontmatter `tags` and `tag`, plus what Quartz found inline. */
export const tagsOf = (frontmatter = {}, indexed = []) => {
  const all = [...asList(frontmatter.tags), ...asList(frontmatter.tag), ...asList(indexed)]
  return [...new Set(all.map(normaliseTag).filter(Boolean))].sort()
}

/**
 * A page's topic, which colours it in the graphs: frontmatter `topic` (a
 * string, or the first of a list) as written, else the first frontmatter tag
 * other than `concept`, else null. The same rule as quartz-edition-extras'
 * textbook-graph (src/topics.ts), so a page is one topic in its book's graph
 * and on the portal. Inline #tags don't count: their order isn't the author's.
 */
export const topicOf = (frontmatter = {}) =>
  asList(frontmatter.topic)[0] ??
  asList(frontmatter.tags ?? frontmatter.tag)
    .map(normaliseTag)
    .find((t) => t && t !== "concept") ??
  null

/** Folders whose pages are concept pages without saying so (book one's chapters/Definitions/). */
const CONCEPT_FOLDERS = new Set(["definitions", "concepts", "concept"])

/**
 * Whether a page is a concept page. Obsidian has no such thing, so the book
 * says it one of three ways: `type: concept` in the frontmatter, the tag
 * `concept`, or living in a Definitions/ or Concepts/ folder. `concept: false`
 * in the frontmatter overrides all three.
 */
export function isConceptPage(relPath, frontmatter = {}, tags = []) {
  if (frontmatter.concept === false) return false
  if (frontmatter.concept === true) return true
  if (String(frontmatter.type ?? "").toLowerCase() === "concept") return true
  if (tags.includes("concept")) return true
  const folders = relPath.split("/").slice(0, -1)
  return folders.some((f) => CONCEPT_FOLDERS.has(f.toLowerCase()))
}

/**
 * The commits prepare.mjs reads: `git log --name-status -z` with the format
 * below. Commits named in the shallow file are left out: a shallow clone's
 * boundary commit shows every file as added.
 */
export const GIT_LOG_FORMAT = "%x1e%H%x1f%cI%x1f%an%x1f%s"

export function parseGitLog(text, shallow = []) {
  const skip = new Set(shallow)
  const commits = []
  for (const record of text.split("\x1e").slice(1)) {
    const [header, ...rest] = record.split("\x00")
    const [sha, date, author, subject] = header.replace(/\n+$/, "").split("\x1f")
    if (!sha || skip.has(sha)) continue
    // -z: status and path(s) are separate NUL-terminated fields, the first one
    // prefixed by the newline after the header.
    const fields = rest.map((f) => f.replace(/^\n/, "")).filter((f) => f !== "")
    const files = []
    for (let i = 0; i < fields.length; ) {
      const status = fields[i++]
      if (/^[RC]/.test(status)) {
        i++ // the old path
        files.push({ status: "M", path: fields[i++] })
      } else files.push({ status: status[0], path: fields[i++] })
    }
    commits.push({ sha, date, author, subject, files })
  }
  return commits
}

/**
 * The catalog. `pages` are the book's own pages: { relPath, slug, title,
 * frontmatter, indexedTags, links (slugs) }. `commits` are parseGitLog's,
 * newest first.
 */
export function buildCatalog({ facts, pages, commits = [] }) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]))
  const byRelPath = new Map(pages.map((p) => [p.relPath, p]))
  const index = pages.find((p) => p.slug === "index")

  const out = [...pages]
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map((p) => {
      const tags = tagsOf(p.frontmatter, p.indexedTags)
      return {
        path: slugUrl(p.slug),
        // The source file, so a reader of the catalog can work out the page's
        // address on a host that isn't Quartz (book one on Publish, D14).
        source: p.relPath,
        title: String(p.title ?? "").trim() || p.slug,
        tags,
        concept: p.slug !== "index" && isConceptPage(p.relPath, p.frontmatter, tags),
        authors: authorsOf(p.frontmatter),
        topic: topicOf(p.frontmatter),
        links: [...new Set((p.links ?? []).filter((s) => s !== p.slug && bySlug.has(s)))]
          .map(slugUrl)
          .sort(),
      }
    })

  // Recent changes: one entry per page per commit, newest first. Deleted pages
  // aren't there to visit, and a page changed twice shows once, at its latest.
  const recent = []
  const seen = new Set()
  for (const c of commits) {
    for (const f of c.files) {
      const page = byRelPath.get(f.path)
      if (!page || f.status === "D" || seen.has(page.slug)) continue
      // community/ is written by the stats workflow, not by authors: a weekly
      // refresh of the dashboard isn't work on the book.
      if (page.relPath.startsWith("community/")) continue
      seen.add(page.slug)
      recent.push({
        date: c.date,
        path: slugUrl(page.slug),
        title: out.find((o) => o.path === slugUrl(page.slug)).title,
        change: f.status === "A" ? "added" : "updated",
        commit: c.sha,
        summary: c.subject,
      })
    }
    if (recent.length >= RECENT_LIMIT) break
  }

  const bookAuthors = authorsOf(index?.frontmatter)
  return {
    version: CATALOG_VERSION,
    slug: facts.slug,
    book_commit: facts.bookCommit,
    authors: bookAuthors.length ? bookAuthors : [...new Set(out.flatMap((p) => p.authors))].sort(),
    pages: out,
    recent: recent.slice(0, RECENT_LIMIT),
  }
}

// ---------------------------------------------------------------------------
// Page history (the History panel in each page's controls row): every page's
// revisions on the branch being built, from `git log --follow`, newest first.
// Opening one asks suggest-edit-function's /api/page-revision for the diff.

/** Every non-merge commit's facts, for revisionsOf: `git log -z` with this format. */
export const COMMIT_INFO_FORMAT = "%x1e%H%x1f%aI%x1f%aN%x1f%aE%x1f%s%x1f%B"

/** sha -> { date, name, email, subject, body } */
export function parseCommitInfo(text) {
  const out = new Map()
  for (const record of text.split("\x1e").slice(1)) {
    const [sha, date, name, email, subject, body = ""] = record.replace(/\x00$/, "").split("\x1f")
    out.set(sha, { date, name, email, subject, body })
  }
  return out
}

/** `git log --follow --name-status -z --format=%x1e%H -- <path>`: [{ sha, path }], path as it was then. */
export function parseFollowLog(text) {
  const out = []
  for (const record of text.split("\x1e").slice(1)) {
    const [sha, ...fields] = record.split("\x00").map((f) => f.replace(/^\n/, ""))
    const f = fields.filter((x) => x !== "")
    // [status, path] or, for a rename or copy, [status, old, new].
    const path = /^[RC]/.test(f[0] ?? "") ? f[2] : f[1]
    if (sha && path) out.push({ sha: sha.trim(), path })
  }
  return out
}

/** The name an anonymous in-site proposal gave: its commit's last `Proposed-by:` trailer. */
export const proposedBy = (body = "") =>
  [...body.matchAll(/^Proposed-by:[ \t]*(.+?)[ \t]*$/gm)].pop()?.[1].slice(0, 80) || null

const NOREPLY = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i

/**
 * Who a revision is by, as the History panel shows it. A person's GitHub login
 * when the commit carries their noreply address (signed-in in-site proposals and
 * the author site commit that way), else the name git has (%aN, which respects
 * .mailmap, as the Contributors page). Automation is never credited: an App or
 * bot commit is the Co-authored-by people it carries, an anonymous in-site
 * proposal is the name its Proposed-by: trailer gives, or "a reader" for one from
 * before the trailer (the panel asks /api/page-revision for those names when the
 * list opens), and anything else
 * is the platform's housekeeping. `automation` is the registry's
 * platform.automation_logins, lower-cased.
 */
export function revisionAuthor({ name = "", email = "", body = "" }, automation = new Set()) {
  const isBot = (n, e) =>
    /\[bot\]/i.test(n) || /\[bot\]/i.test(e) || automation.has(n.toLowerCase())
  const person = (n, e) => NOREPLY.exec(e)?.[1] ?? n
  if (!isBot(name, email)) return { who: person(name, email) }
  const co = [...body.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim)]
    .filter((m) => !isBot(m[1], m[2]))
    .map((m) => person(m[1], m[2]))
  if (co.length) return { who: [...new Set(co)].join(", ") }
  const given = proposedBy(body)
  if (given) return { who: given }
  if (/Proposed by a reader with the in-site editor\.|^Proposed in #\d+\./m.test(body))
    return { who: "a reader", reader: true }
  return { who: "automation", automation: true }
}

/** One page's list: [{ sha, date, who, reader?, automation?, message, path }], newest first. */
export const revisionsOf = (follow, info, automation) =>
  follow
    .filter((r) => info.has(r.sha))
    .map(({ sha, path }) => {
      const c = info.get(sha)
      return { sha, date: c.date, ...revisionAuthor(c, automation), message: c.subject, path }
    })

// Branches the platform makes itself, never built and expected to differ from
// drafts: reader edits (proposed-edits/*, into drafts), the Sunday community pages
// and the config render (chore/*), and the annotation backups.
const PLATFORM_BRANCH = /^(proposed-edits\/|chore\/|backups$)/

/**
 * What the reconcile tick flags in one book (05 Oct): work its builds never see,
 * or that reached the live branch without going through drafts. `changed` maps
 * each branch to how many files it changes since it left drafts (0 when drafts
 * has everything, as after publishing, whose merge commit adds nothing); `pulls`
 * are the open pull requests into the live branch, as { number, head }.
 */
export function branchFindings({ live_branch: live, drafts_branch: drafts }, { changed, pulls }) {
  const found = []
  for (const [branch, files] of Object.entries(changed)) {
    if (!files || branch === drafts || PLATFORM_BRANCH.test(branch)) continue
    found.push(
      branch === live
        ? `\`${live}\` changes ${files} file(s) that \`${drafts}\` doesn't have, and the builder couldn't bring them in by itself (most likely a conflict: the same lines changed on both). Until someone merges \`${live}\` into \`${drafts}\` by hand, the drafts preview, the author site and the in-site editor don't show them.`
        : `\`${branch}\` changes ${files} file(s) that \`${drafts}\` doesn't have, and nothing builds \`${branch}\`. Bring that work onto \`${drafts}\`, then delete the branch.`,
    )
  }
  for (const pr of pulls) {
    if (pr.head === drafts || PLATFORM_BRANCH.test(pr.head)) continue
    found.push(
      `Pull request #${pr.number} goes into \`${live}\` from \`${pr.head}\`, not from \`${drafts}\`. Point it at \`${drafts}\` instead.`,
    )
  }
  return found
}

/**
 * The App tokens a run holds, by repository owner (lowercased): the books App for
 * the books org (registry platform.books_owner), the `quartz-book bot` App for the
 * platform's own account, where the books App can't be installed (06 Oct). An
 * owner whose App isn't set up here has token "".
 */
export function ownerTokens(env) {
  const out = new Map()
  for (const [owner, token, app] of [
    [env.BOOKS_OWNER, env.BOOKS_TOKEN, "the books App"],
    [env.PLATFORM_OWNER, env.PLATFORM_TOKEN, "the quartz-book bot App"],
  ])
    if (owner) out.set(owner.toLowerCase(), { token: token || "", app })
  return out
}

/**
 * Whether an App here can reach a book's repo: null when it can, else why not.
 * `tokens` is ownerTokens(); `installed` maps an owner to the full names (lowercased)
 * its App's token can see.
 */
export function appGap(repo, tokens, installed) {
  const owner = repo.split("/")[0].toLowerCase()
  const t = tokens.get(owner)
  if (!t?.token)
    return {
      why: `no App token for ${owner} in this run, so ${repo} is left as it is. ${t ? `Set up ${t.app} (quartz-book README).` : "Move the book to the books org, or to the platform's account."}`,
    }
  if (!installed.get(owner)?.has(repo.toLowerCase()))
    return { why: `${repo} isn't in ${t.app}'s installation. Add it there.` }
  return null
}

/** The merge commit message when drafts and the live branch have both moved. */
export const SYNC_MESSAGE =
  "Bring the live book's changes into drafts\n\nquartz-book keeps drafts current with the live branch (builder/sync-drafts.mjs)."

/**
 * Keeps a book's drafts branch current with its live branch (06 Oct): drafts is
 * what the in-site editor and the author site edit, so whatever reached the live
 * branch without passing through drafts (a publish's merge commit, a fix made on
 * the live branch) must be in drafts too.
 *
 *   drafts has everything already      nothing at all: no write, no push event
 *   drafts is behind                   fast-forward (a ref update, no new commit)
 *   both moved                         merge the live head into drafts
 *   both moved, and the merge conflicts  { outcome: "conflict" }: nothing written;
 *                                      the branch check's issue asks for it by hand
 *
 * `gh(path, { method, body })` answers { status, data }. Never throws for an
 * answer GitHub gives; a network failure does.
 */
export async function syncDrafts({ repo, live_branch: live, drafts_branch: drafts }, gh) {
  const enc = encodeURIComponent
  const cmp = await gh(`/repos/${repo}/compare/${enc(live)}...${enc(drafts)}`)
  if (cmp.status !== 200) return { outcome: "error", status: cmp.status, step: "compare" }
  if (cmp.data.status === "identical" || cmp.data.status === "ahead") return { outcome: "current" }
  // Exactly the live head that was compared, not whatever the branch is by now.
  const head = cmp.data.base_commit.sha
  if (cmp.data.status === "behind") {
    const ff = await gh(`/repos/${repo}/git/refs/heads/${enc(drafts)}`, {
      method: "PATCH",
      body: { sha: head, force: false },
    })
    if (ff.status === 200) return { outcome: "fast-forwarded", sha: head }
    // 422: drafts moved since the compare, so it's no longer a fast-forward. Merge.
    if (ff.status !== 422) return { outcome: "error", status: ff.status, step: "fast-forward" }
  }
  const m = await gh(`/repos/${repo}/merges`, {
    method: "POST",
    body: { base: drafts, head, commit_message: SYNC_MESSAGE },
  })
  if (m.status === 201) return { outcome: "merged", sha: m.data.sha }
  if (m.status === 204) return { outcome: "current" }
  if (m.status === 409) return { outcome: "conflict" }
  return { outcome: "error", status: m.status, step: "merge" }
}
