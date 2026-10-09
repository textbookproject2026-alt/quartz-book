// The builder's decisions, as pure functions (BOOK-ONE-TO-QUARTZ §0). Everything
// that reads the disk or runs a process is in prepare.mjs and finish.mjs; this
// file is what test/ exercises.
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { join } from "node:path"
// The credit ledger's pure functions live with the book automation that writes it.
import { pageAnchor, pageContributors } from "../automation/scripts/lib/credits.mjs"

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
/**
 * The platform's public Plausible dashboard (https://plausible.io/<site>, public for
 * good, decided 9 Oct 2026), or "" when it isn't public: no statistics links.
 */
export function statsDashboard(registry) {
  const p = registry.platform?.analytics?.plausible
  if (!p) return ""
  return p.dashboard_public ? `https://plausible.io/${p.site}` : ""
}

/** The platform's Privacy page, on the portal. */
export const privacyUrl = (registry) => {
  const domain = registry.platform?.portal?.domain
  return domain ? `https://${domain}/privacy` : ""
}

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
    // Page and Book statistics (⋯): the platform's dashboard, for the books it counts.
    statsUrl: counted ? statsDashboard(registry) : "",
    // registry books[].type: the header badge. Absent means a book.
    type: book.type ?? "book",
    // The platform's Privacy page (the portal's /privacy): every footer, and the
    // first-visit notice.
    privacyUrl: privacyUrl(registry),
    // Hypothes.is groups readers may use besides the platform's anchor group
    // (registry annotations.hypothesis_groups; the public layer is off).
    hypothesisGroups: (book.annotations?.hypothesis_groups ?? []).map((g) => g.id),
    licence: book.licence,
    authors: book.maintainer?.name ?? "",
    // Citation metadata (bookMetadata): the registry's optional publisher, lang
    // and doi, and its summary, the front page's fallback.
    summary: book.summary ?? "",
    publisher: book.publisher ?? "",
    lang: book.lang ?? "",
    doi: book.doi ?? "",
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
  plugin("footer").options.links = {
    ...licenceLink(opts.licence),
    ...(opts.privacyUrl ? { Privacy: opts.privacyUrl } : {}),
  }
  Object.assign(plugin("edition-integrations").options, {
    plausibleScriptSrc: opts.plausibleScriptSrc,
    siteDomain: opts.domain,
    explorerOrder,
    privacyUrl: opts.privacyUrl ?? "",
    hypothesisGroups: opts.hypothesisGroups ?? [],
  })
  Object.assign(plugin("edit-on-github").options, {
    repo: opts.repo,
    branch: opts.branch,
    contentDir: "",
    suggestEndpoint: opts.suggestEndpoint,
    revisionEndpoint: opts.revisionEndpoint,
    authors: opts.authors ?? "",
    licence: opts.licence ?? "",
    statsUrl: opts.statsUrl ?? "",
    statsHost: opts.statsUrl ? opts.domain : "",
    type: opts.type ?? "",
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
  const items = missing.map(
    (p) => `${m?.[1] ?? ""}${marker()} [[${p.path.replace(/\.md$/i, "")}|${label(p.title)}]]`,
  )
  if (last === -1)
    lines.splice(
      start + 1,
      0,
      "",
      ...items,
      ...(start + 1 < lines.length && lines[start + 1].trim() ? [""] : []),
    )
  else lines.splice(at + 1, 0, ...items)
  return { text: lines.join(eol), added: missing.map((p) => p.path) }
}

/**
 * completeContents for a book checkout: `files` is its tracked files (git ls-files)
 * and `read(path)` a file's text. The builder's prepare step and the live-book
 * check both use it, so they agree on the order.
 */
export const bookContents = (indexMarkdown, files, read) =>
  completeContents(
    indexMarkdown,
    bookPages(files).map((path) => ({ path, title: pageTitle(read(path), path) })),
  )

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
    .concat(ASSET_NOTES, WORD_FILES, CREDIT_OVERRIDES)
}

/**
 * The book's credit overrides: read by the build, never published (it can name
 * someone who asked to be left out).
 */
export const CREDIT_OVERRIDES = "community/credit-overrides.yml"

/** Quartz's slug for a root-level name, near enough to catch a collision. */
const looseSlug = (name) =>
  name
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")

/** A book's own file at the builder's /how-to-comment fails the build (§0). */
export function howToCommentClash(entries) {
  // The builder's own pages: /how-to-comment, and /history (batch 2a).
  return entries.find((name) => [HOW_TO_COMMENT, "history"].includes(looseSlug(name))) ?? null
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
  const href = canonicalHref(domain, url)
  const tag = `<link rel="canonical" href="${href}" data-builder="quartz-book">`
  if (!html.includes("</head>"))
    throw new Error(`no </head> to put the canonical link before (${url}).`)
  return html.replace("</head>", `${tag}</head>`)
}

/** A page's address on the book's domain, each path segment encoded once. */
export const canonicalHref = (domain, url) =>
  `https://${domain}${url
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/")}`

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
  // The other of the book's two branches (drafts for the live branch, and the
  // live branch for drafts): the version history shows both, so a build is
  // stale when either moves (batch 2a). "" where there is none.
  other_commit: facts.otherCommit ?? "",
  registry_digest: facts.registryDigest,
  builder_commit: facts.builderCommit,
})

/** The book's other branch for a build of `branch`: drafts for the live branch, live for drafts, else null. */
export const otherBranch = (book, branch) =>
  branch === book.content.live_branch
    ? (book.content.drafts_branch ?? null)
    : branch === book.content.drafts_branch
      ? book.content.live_branch
      : null

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
  "history.html",
  ".well-known/history.json",
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
  if (EXPORT_FILE.test(outPath)) return true
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
      other_commit: served.other_commit ?? "",
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

const ORCID = /^(?:https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i

/**
 * A page's creators from its frontmatter: `authors` (a list, or "A, B") or
 * `author`, each a name or { name, orcid }. An ORCID iD is kept as its bare
 * 0000-0000-0000-000X form, whether given bare or as its orcid.org URL; one
 * that isn't an iD is dropped, the name kept.
 */
const GITHUB_LOGIN = /^@?([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/

/** People from a frontmatter value: names, "A, B", or { name, orcid, github }. */
const peopleOf = (raw) =>
  (Array.isArray(raw) ? raw : [raw]).flatMap((item) => {
    if (item && typeof item === "object") {
      const name = String(item.name ?? "").trim()
      if (!name) return []
      const orcid = ORCID.exec(String(item.orcid ?? "").trim())?.[1]?.toUpperCase()
      const github = GITHUB_LOGIN.exec(String(item.github ?? "").trim())?.[1]
      return [{ name, ...(orcid ? { orcid } : {}), ...(github ? { github } : {}) }]
    }
    return asList(item).map((name) => ({ name }))
  })

export const creatorsOf = (frontmatter = {}) => peopleOf(frontmatter.authors ?? frontmatter.author)

/** A page's (or the book's) editors: `editors:` or `editor:`, as creatorsOf. No fallback. */
export const editorsOf = (frontmatter = {}) => peopleOf(frontmatter.editors ?? frontmatter.editor)

/**
 * The platform's three credit roles, and the CRediT terms each stands for
 * (https://credit.niso.org), for DOIs and ORCID later. Authors and editors are
 * cited; contributors are acknowledged, never cited.
 */
export const CREDIT_ROLES = {
  author: { label: "Author", credit: ["Writing – original draft", "Conceptualization"] },
  editor: { label: "Editor", credit: ["Writing – review & editing", "Supervision"] },
  contributor: { label: "Contributor", credit: ["Writing – review & editing"] },
}

/** A page's authors' names, from its frontmatter (creatorsOf). */
export const authorsOf = (frontmatter = {}) => creatorsOf(frontmatter).map((c) => c.name)

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
export function buildCatalog({ facts, pages, commits = [], credits = null }) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]))
  const byRelPath = new Map(pages.map((p) => [p.relPath, p]))
  const index = pages.find((p) => p.slug === "index")
  // The citation metadata (bookMetadata, pageMetadata), when the build gave the
  // registry facts it needs. Added beside what the portal already reads.
  const book = facts.domain ? bookMetadata(facts, index) : null

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
        ...(book ? { metadata: pageMetadata(p, book, facts) } : {}),
        // The page's contributors (credits.json, overrides applied), when the book has a ledger.
        ...(credits ? { contributors: pageContributors(credits, p.relPath) } : {}),
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
    ...(book ? { metadata: book } : {}),
    // The credit ledger, as this build applied the overrides (catalog stays version 1).
    ...(credits ? { credits } : {}),
    pages: out,
    recent: recent.slice(0, RECENT_LIMIT),
  }
}

// ---------------------------------------------------------------------------
// Citation metadata: what the page heads (Highwire, Dublin Core, JSON-LD), the
// citations and the exports say about a page and its book. One shape for both,
// most specific source first. Pages are buildCatalog's, plus `markdown` (the
// source without frontmatter) and `created` (the date of the file's first
// commit). No timestamp of the build's own: the dates are the content's.

/** The resource types a page can be (frontmatter `resource_type:`). */
export const RESOURCE_TYPES = ["book", "chapter", "paper", "report", "article", "concept"]
export const PUBLISHER = "Confused for Now"
export const DEFAULT_LICENCE = "CC-BY-SA-4.0"
export const SUMMARY_MAX = 300

/** YYYY-MM-DD from a frontmatter date (a string or a YAML date) or git's ISO date, else "". */
export const dateOnly = (value) => {
  if (value instanceof Date) return isNaN(value) ? "" : value.toISOString().slice(0, 10)
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/.exec(String(value ?? "").trim())
  // A real day: Date rolls 2026-02-30 over into March, so compare the round trip.
  const day = m && new Date(`${m[1]}T00:00:00Z`)
  return day && !isNaN(day) && day.toISOString().startsWith(m[1]) ? m[1] : ""
}

/** Markdown inline syntax to plain text: links to their text, no emphasis, footnote marks or tags. */
export const plainText = (md) =>
  md
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]#|]+)(?:#[^\]|]*)?\]\]/g, (_, t) => t.split("/").pop())
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`|==|~~)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The first prose paragraph of a page's markdown (no frontmatter): not a
 * heading, list, quote, table, code, HTML block, image or `%%comment%%`.
 */
export function firstParagraph(markdown) {
  const text = markdown.replace(/%%[^]*?%%/g, "").replace(/```[^]*?```/g, "")
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.trim()
    if (!b || /^(#|[-*+] |\d+[.)] |>|\||<|!\[|\[\^|---|\$\$)/.test(b)) continue
    const plain = plainText(b)
    if (plain) return plain
  }
  return ""
}

/** At most `max` characters, cut at a word boundary with an ellipsis. */
export const cutAtWord = (text, max = SUMMARY_MAX) => {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`
}

const keywordsOf = (frontmatter, tags) => {
  const seen = new Set()
  return [...asList(frontmatter.keywords), ...tags].filter((k) => {
    const key = normaliseTag(k)
    if (!key || key === "concept" || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const docOf = (page) => ({
  frontmatter: page?.frontmatter ?? {},
  markdown: page?.markdown ?? "",
  title: String(page?.title ?? "").trim(),
  created: page?.created ?? "",
})

/**
 * The book's metadata, from its index page (`index`, a catalog page, or
 * undefined) and the build's facts (bookOptions, plus bookCommitDate).
 */
export function bookMetadata(facts, index) {
  const { frontmatter: fm, markdown, created } = docOf(index)
  const creators = creatorsOf(fm)
  const editors = editorsOf(fm)
  // index.md's own title (frontmatter, else its H1), else the registry's: an
  // index without either is titled "index" by Quartz.
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]
  const title = String(fm.title ?? "").trim() || (h1 ? plainText(h1) : "")
  const licence = facts.licence || DEFAULT_LICENCE
  const doi = String(fm.doi ?? facts.doi ?? "").trim()
  return {
    type: RESOURCE_TYPES.includes(fm.resource_type) ? fm.resource_type : facts.type || "book",
    title: title || facts.title,
    // An edited volume (editors, no book-level authors) is cited by its editors;
    // otherwise index.md's authors, else the registry's maintainer.
    creators: creators.length || editors.length ? creators : maintainerOf(facts),
    editors,
    publisher: facts.publisher || PUBLISHER,
    created: dateOnly(fm.created) || dateOnly(created),
    published: dateOnly(fm.published) || dateOnly(facts.bookCommitDate),
    summary: cutAtWord(
      plainText(String(fm.summary ?? fm.description ?? "")) ||
        String(facts.summary ?? "").trim() ||
        firstParagraph(markdown),
    ),
    keywords: keywordsOf(fm, tagsOf(fm, index?.indexedTags)),
    url: `https://${facts.domain}/`,
    ...(doi ? { doi } : {}),
    lang: String(fm.lang ?? "").trim() || facts.lang || "en",
    format: "text/html",
    rights: "open access",
    licence: { id: licence, url: Object.values(licenceLink(licence))[0] },
  }
}

const maintainerOf = (facts) => asList(facts.authors).map((name) => ({ name }))

/** A page's metadata: its own where it says, else its book's (bookMetadata). */
export function pageMetadata(page, book, facts) {
  if (page?.slug === "index") return book
  const { frontmatter: fm, markdown, title, created } = docOf(page)
  const tags = tagsOf(fm, page?.indexedTags)
  const creators = creatorsOf(fm)
  const editors = editorsOf(fm)
  const doi = String(fm.doi ?? "").trim()
  const type = RESOURCE_TYPES.includes(fm.resource_type)
    ? fm.resource_type
    : isConceptPage(page?.relPath ?? "", fm, tags)
      ? "concept"
      : "chapter"
  return {
    type,
    title:
      title ||
      String(page?.relPath ?? "")
        .split("/")
        .pop()
        .replace(/\.md$/i, ""),
    // The page's authors, else the book's, else (an edited volume's chapter) the
    // registry's maintainer: batch 1's chain.
    creators: creators.length
      ? creators
      : book.creators.length
        ? book.creators
        : maintainerOf(facts),
    // The page's editors, else the book's: the container's editors in a citation.
    editors: editors.length ? editors : book.editors,
    publisher: book.publisher,
    created: dateOnly(fm.created) || dateOnly(created),
    published: dateOnly(fm.published) || dateOnly(facts.bookCommitDate),
    summary: cutAtWord(
      plainText(String(fm.summary ?? fm.description ?? "")) || firstParagraph(markdown),
    ),
    keywords: keywordsOf(fm, tags),
    url: canonicalHref(facts.domain, slugUrl(page.slug)),
    ...(doi ? { doi } : {}),
    lang: String(fm.lang ?? "").trim() || book.lang,
    format: "text/html",
    rights: "open access",
    licence: book.licence,
    book: { title: book.title, url: book.url },
  }
}

// --- In every page's head -----------------------------------------------------
// Highwire Press tags (what Zotero and Google Scholar read), Dublin Core, and
// schema.org JSON-LD, from pageMetadata; finish.mjs puts them before </head>.

const escAttr = (v) =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

/** JSON for inside <script>: no "</script>" or "<!--" can close or confuse it. */
export const scriptJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")

const BOOKISH = {
  book: "Book",
  paper: "ScholarlyArticle",
  article: "ScholarlyArticle",
  report: "Report",
}

/** The schema.org object for a page: Book (or its book type) on the front page, Chapter, DefinedTerm. */
/** schema.org Persons: ORCID (and GitHub, when given) as sameAs. */
export const ldPeople = (people = []) =>
  people.map((c) => {
    const same = [
      ...(c.orcid ? [`https://orcid.org/${c.orcid}`] : []),
      ...(c.github ? [`https://github.com/${c.github}`] : []),
    ]
    return {
      "@type": "Person",
      name: c.name,
      ...(same.length ? { sameAs: same.length === 1 ? same[0] : same } : {}),
    }
  })

/**
 * `contributors` are the page's (or the book's) credited contributors (the
 * credit ledger): acknowledged in JSON-LD and DC.contributor, never cited.
 */
export function jsonLd(meta, { pdfUrl = "", contributors = [] } = {}) {
  const people = ldPeople(meta.creators)
  const common = {
    name: meta.title,
    url: meta.url,
    ...(meta.summary ? { description: meta.summary } : {}),
    inLanguage: meta.lang,
    license: meta.licence.url,
    isAccessibleForFree: true,
    ...(meta.doi ? { identifier: `https://doi.org/${meta.doi}` } : {}),
  }
  const editors = ldPeople(meta.editors)
  const work = {
    ...(people.length ? { author: people } : {}),
    // A chapter's editors are its book's (isPartOf, below).
    ...(editors.length && !meta.book ? { editor: editors } : {}),
    ...(contributors.length ? { contributor: ldPeople(contributors) } : {}),
    publisher: { "@type": "Organization", name: meta.publisher },
    ...(meta.created ? { dateCreated: meta.created } : {}),
    ...(meta.published ? { datePublished: meta.published } : {}),
    ...(meta.keywords.length ? { keywords: meta.keywords.join(", ") } : {}),
    ...(pdfUrl
      ? {
          encoding: {
            "@type": "MediaObject",
            contentUrl: pdfUrl,
            encodingFormat: "application/pdf",
          },
        }
      : {}),
  }
  const book = meta.book && {
    "@type": "Book",
    name: meta.book.title,
    url: meta.book.url,
    ...(editors.length ? { editor: editors } : {}),
  }
  const body =
    meta.type === "concept"
      ? {
          "@type": "DefinedTerm",
          ...common,
          inDefinedTermSet: {
            "@type": "DefinedTermSet",
            name: meta.book.title,
            url: meta.book.url,
          },
        }
      : meta.book
        ? { "@type": "Chapter", ...common, ...work, isPartOf: book }
        : { "@type": BOOKISH[meta.type] ?? "Book", ...common, ...work }
  return { "@context": "https://schema.org", ...body }
}

/** The head tags for one page, as one HTML string. `pdfUrl` once its export exists. */
export function headTags(meta, { pdfUrl = "", contributors = [] } = {}) {
  const tags = []
  const m = (name, content) =>
    content && tags.push(`<meta name="${name}" content="${escAttr(content)}">`)
  m("citation_title", meta.title)
  for (const c of meta.creators) {
    m("citation_author", c.name)
    if (c.orcid) m("citation_author_orcid", `https://orcid.org/${c.orcid}`)
  }
  // Zotero's Embedded Metadata translator reads citation_editor (a chapter's are
  // its book's editors, as a book section's are). Contributors are never cited.
  for (const e of meta.editors ?? []) m("citation_editor", e.name)
  m("citation_publication_date", meta.published.replace(/-/g, "/"))
  m("citation_publisher", meta.publisher)
  m("citation_language", meta.lang)
  m("citation_keywords", meta.keywords.join("; "))
  // Zotero's Embedded Metadata translator: citation_book_title makes a page a
  // book section (a concept page too, an entry in the book); the front page is
  // typed by DC.type (book, report), and a report needs its institution.
  if (meta.book) m("citation_book_title", meta.book.title)
  if (!meta.book && meta.type === "report")
    m("citation_technical_report_institution", meta.publisher)
  m("citation_public_url", meta.url)
  m("citation_pdf_url", pdfUrl)
  m("citation_doi", meta.doi ?? "")
  tags.push(`<link rel="schema.DC" href="http://purl.org/dc/elements/1.1/">`)
  m("DC.title", meta.title)
  for (const c of meta.creators) m("DC.creator", c.name)
  for (const c of [...(meta.editors ?? []), ...contributors]) m("DC.contributor", c.name)
  m("DC.publisher", meta.publisher)
  m("DC.date.created", meta.created)
  m("DC.date.issued", meta.published)
  m("DC.description", meta.summary)
  for (const k of meta.keywords) m("DC.subject", k)
  m("DC.identifier", meta.url)
  if (meta.doi) m("DC.identifier", `https://doi.org/${meta.doi}`)
  m("DC.type", meta.type)
  m("DC.format", meta.format)
  m("DC.language", meta.lang)
  m("DC.rights", `${meta.licence.id} (${meta.licence.url}), ${meta.rights}`)
  tags.push(`<link rel="license" href="${escAttr(meta.licence.url)}">`)
  tags.push(
    `<script type="application/ld+json">${scriptJson(jsonLd(meta, { pdfUrl, contributors }))}</script>`,
  )
  return tags.join("")
}

/** `extra` (head tags) before </head>, once: a page that already has them is left alone. */
export function addToHead(html, extra, url) {
  if (!extra || html.includes('<meta name="citation_title"')) return html
  if (!html.includes("</head>")) throw new Error(`no </head> to put the metadata before (${url}).`)
  return html.replace("</head>", `${extra}</head>`)
}

// --- Citations: CSL-JSON from the metadata (builder/citations.mjs formats it) ---

/** "Brandon Sommer" -> { family: "Sommer", given: "Brandon" }; one word stays a literal (an organisation). */
export const cslName = (name) => {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return { literal: name.trim() }
  // ponytail: the last word is the family name ("Ludwig van Beethoven" -> "Beethoven"),
  // as cite.ts always did. An author who needs otherwise writes the name inverted
  // in the frontmatter's object form: `{ name: "van Beethoven, Ludwig" }`.
  if (name.includes(",")) {
    const [family, given] = name.split(",", 2).map((s) => s.trim())
    return { family, given }
  }
  return { family: parts.pop(), given: parts.join(" ") }
}

const dateParts = (d) => (d ? { "date-parts": [d.split("-").map(Number)] } : undefined)

/** One CSL-JSON item: the book, or a page (a chapter of the book). `id` is the citation key. */
export function cslItem(meta) {
  const item = {
    id: meta.url,
    type: meta.book
      ? "chapter"
      : meta.type === "report"
        ? "report"
        : meta.type === "book"
          ? "book"
          : "article",
    title: meta.title,
    // An edited volume has editors and no author: CSL styles cite it by them (Ed./Eds.).
    ...(meta.creators.length ? { author: meta.creators.map((c) => cslName(c.name)) } : {}),
    // A chapter's editors are its container's, as CSL reads `editor` on a chapter.
    ...(meta.editors?.length ? { editor: meta.editors.map((c) => cslName(c.name)) } : {}),
    publisher: meta.publisher,
    issued: dateParts(meta.published),
    URL: meta.url,
    language: meta.lang,
    ...(meta.summary ? { abstract: meta.summary } : {}),
    ...(meta.keywords.length ? { keyword: meta.keywords.join(", ") } : {}),
    ...(meta.doi ? { DOI: meta.doi } : {}),
    ...(meta.book ? { "container-title": meta.book.title } : {}),
    license: meta.licence.url,
  }
  if (!item.issued) delete item.issued
  return item
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

// ---------------------------------------------------------------------------
// Exports (builder/export.mjs): a PDF and an EPUB of each chapter, and a PDF,
// an EPUB and an ODT of the whole book, made after the site from the same
// sources: markdown -> (preprocessed here) -> pandoc -> Typst for the PDF,
// pandoc itself for EPUB and ODT. An export that fails is left out, never the
// site.

export const EXPORT_DIR = "downloads"
export const EXPORT_FORMATS = { chapter: ["pdf", "epub"], book: ["pdf", "epub", "odt"] }
/** What the exports may publish: downloads/<name>.<pdf|epub|odt>. */
const EXPORT_FILE = /^downloads\/[a-z0-9][a-z0-9-]*\.(pdf|epub|odt)$/
/** Cloudflare Pages takes files up to 25 MiB; an export over this is dropped. */
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024

/** A file name part: lower case, ASCII letters, digits and single hyphens. */
export const fileSlug = (s) =>
  String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/**
 * The export's file name: <book>[-<chapter>]-<YYYY-MM-DD>.<ext>, or without
 * the date for the stable alias (a redirect to the dated file).
 */
export const exportName = (book, chapter, date, ext, dated = true) =>
  `${[fileSlug(book), chapter ? fileSlug(chapter) : "", dated ? date : ""].filter(Boolean).join("-")}.${ext}`

/**
 * Each exported page's file part: its file name, or its whole path where two
 * pages share a file name.
 */
export function chapterSlugs(slugs) {
  const last = (s) => s.split("/").pop()
  const count = new Map()
  for (const s of slugs) count.set(fileSlug(last(s)), (count.get(fileSlug(last(s))) ?? 0) + 1)
  return new Map(
    slugs.map((s) => [s, count.get(fileSlug(last(s))) > 1 ? fileSlug(s) : fileSlug(last(s))]),
  )
}

/** A heading's anchor as Quartz writes it (github-slugger's rule). */
export const headingAnchor = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-")

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i

const normPath = (path) => {
  const out = []
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") out.pop()
    else out.push(seg)
  }
  return out.join("/")
}

/**
 * A book's pages for link resolution: Obsidian's "shortest" links (a file name
 * alone where it is unique, else a path from the root), as Quartz resolves
 * them. `pages` are { relPath, slug }.
 */
export function linkResolver(pages, domain) {
  // Spaces and hyphens alike, in any case: Quartz's slugs, from file names with spaces.
  const norm = (s) =>
    s
      .trim()
      .replace(/^\.?\//, "")
      .replace(/\.md$/i, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
  const byPath = new Map()
  const byName = new Map()
  for (const p of pages) {
    const key = norm(p.relPath)
    byPath.set(key, p)
    const name = key.split("/").pop()
    byName.set(name, byName.has(name) ? null : p)
  }
  return (target) => {
    const key = norm(target)
    const page = byPath.get(key) ?? byName.get(key.split("/").pop()) ?? null
    return page ? { ...page, url: canonicalHref(domain, slugUrl(page.slug)) } : null
  }
}

/**
 * A page's markdown (no frontmatter) as pandoc should read it. What Quartz
 * renders and pandoc doesn't:
 * - `%%comments%%` go;
 * - callouts (`> [!note] Title`) become block quotes headed by their title;
 * - embeds: `![[image.png]]` an image, `![[Page]]` or `![[Page#Heading]]` that
 *   page's text (two levels deep at most), unresolved ones a link;
 * - wikilinks and concept links (`[[Page|label]]`, `[[glossary#Term|term]]`)
 *   their text, linked to the page on the book's site;
 * - images (markdown or the converter's `<img>`) a path from the book's root,
 *   with an `<img>`'s width kept; remote images a link (Typst can't fetch them).
 *
 * ctx: { relPath (the page's), resolve (linkResolver), source (relPath -> its
 * markdown without frontmatter, or null), findFile (a file name -> its path
 * from the root, or null), depth }
 */
export function preprocessMarkdown(markdown, ctx) {
  const dir = ctx.relPath.split("/").slice(0, -1).join("/")
  const depth = ctx.depth ?? 0
  const fromRoot = (src) => {
    const path = decodeURI(src.split(/[?#]/)[0])
    return src.startsWith("/") ? normPath(path) : normPath(`${dir}/${path}`)
  }
  // A root-absolute path ("/assets/…") while preprocessing, so no pass resolves
  // it twice; the leading "/" goes at the end, for pandoc and Typst's --root.
  const image = (alt, src, attrs = "") =>
    /^[a-z]+:/i.test(src) ? `[${alt || src}](${src})` : `![${alt}](</${fromRoot(src)}>)${attrs}`
  const link = (target, label) => {
    const [page, heading] = target.split("#")
    const text = label ?? (page.trim() ? page.split("/").pop() : heading)
    // A heading on this page ([[#…]]) is just its text in an export.
    const found = page.trim() ? ctx.resolve(page) : null
    return found ? `[${text}](${found.url}${heading ? `#${headingAnchor(heading)}` : ""})` : text
  }

  let text = markdown.replace(/%%[^]*?%%/g, "")

  // Callouts: the marker line becomes the quote's bold title.
  text = text.replace(
    /^([ \t]*>[ \t]*)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm,
    (_, quote, kind, title) => {
      const head = title.trim() || kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase()
      return `${quote}**${head}**\n${quote.trimEnd()}`
    },
  )

  // Embeds before links: ![[...]] is a wikilink after a "!".
  text = text.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (all, target, label) => {
    const name = target.split("#")[0].trim()
    if (IMAGE_EXT.test(name)) {
      const path = ctx.findFile(name)
      const width = /^\d+$/.test(label ?? "") ? `{width=${label}px}` : ""
      return path ? `![](</${path}>)${width}` : name
    }
    const page = ctx.resolve(name)
    const body = page && depth < 2 ? ctx.source(page.relPath) : null
    if (body == null) return link(target, label)
    const heading = target.split("#")[1]
    const section = heading ? sectionOf(body, heading) : body.replace(/^#\s+.*$/m, "")
    return `\n\n${preprocessMarkdown(section, { ...ctx, relPath: page.relPath, depth: depth + 1 }).trim()}\n\n`
  })

  text = text.replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_, target, label) =>
    link(target, label),
  )

  // Markdown images: a path from the root, in <> so spaces survive.
  text = text.replace(
    /!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g,
    (all, alt, a, b) => image(alt, a ?? b),
  )
  // The converter's <img>: alt and width kept, the rest of its style dropped.
  text = text.replace(/<img\b([^>]*?)\/?>/gi, (all, attrs) => {
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1] ?? ""
    const src = attr("src")
    if (!src) return ""
    const width = /(?:^|;)\s*width\s*:\s*([\d.]+(?:in|cm|mm|px|%))/i.exec(attr("style"))?.[1]
    return image(attr("alt").replace(/[[\]]/g, ""), src, width ? `{width=${width}}` : "")
  })
  return depth ? text : text.replace(/(!\[[^\]]*\]\(<)\//g, "$1")
}

/** The text under `heading` (any level) up to the next heading of that level or higher. */
export function sectionOf(markdown, heading) {
  const lines = markdown.split("\n")
  const want = headingAnchor(heading)
  const start = lines.findIndex(
    (l) => /^#{1,6}\s/.test(l) && headingAnchor(l.replace(/^#+\s+/, "")) === want,
  )
  if (start === -1) return ""
  const level = /^#+/.exec(lines[start])[0].length
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l))
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n")
}

/** index.md for the book's export: no "## Contents" list (the export has its own). */
export const withoutContents = (markdown) => {
  const lines = markdown.split("\n")
  const start = lines.findIndex((l) => /^##\s+Contents\s*$/i.test(l))
  if (start === -1) return markdown
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l))
  return [...lines.slice(0, start), ...(end === -1 ? [] : lines.slice(end))].join("\n")
}

/** The page's first H1 and the rest: the H1 is the export's title, not its first line. */
export const splitTitle = (markdown) => {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown)
  if (!m || markdown.slice(0, m.index).trim()) return { title: "", body: markdown }
  return { title: plainText(m[1]), body: markdown.slice(m.index + m[0].length) }
}

// --- On pandoc's AST (pandoc -t json) ---

const inlineText = (inlines) =>
  inlines
    .map((i) =>
      i.t === "Str"
        ? i.c
        : i.t === "Space" || i.t === "SoftBreak" || i.t === "LineBreak"
          ? " "
          : i.t === "Code"
            ? i.c[1]
            : i.t === "Math"
              ? i.c[1]
              : [
                    "Emph",
                    "Strong",
                    "Strikeout",
                    "Superscript",
                    "Subscript",
                    "SmallCaps",
                    "Underline",
                  ].includes(i.t)
                ? inlineText(i.c)
                : ["Link", "Span", "Quoted", "Cite"].includes(i.t)
                  ? inlineText(i.c[1])
                  : "",
    )
    .join("")

const REFERENCE_HEADING =
  /^(?:[\d.]+\s+)?(?:references|reference list|bibliography|works cited|literature cited)\s*:?$/i

/**
 * Paragraph numbers on pandoc's blocks, by edition-integrations' rule for the
 * site (numberParagraphs): top-level paragraphs with text, not inside a
 * references section (up to the next heading of the same or higher rank).
 * With `mark`, each numbered paragraph starts with Typst's #pnum(n). Returns
 * how many it numbered.
 */
export function numberBlocks(blocks, mark = false) {
  let n = 0
  let refsRank = 0
  for (const b of blocks) {
    if (b.t === "Header") {
      const rank = b.c[0]
      if (refsRank && rank <= refsRank) refsRank = 0
      if (REFERENCE_HEADING.test(inlineText(b.c[2]).replace(/\s+/g, " ").trim())) refsRank = rank
      continue
    }
    if (b.t !== "Para" || refsRank || !inlineText(b.c).trim()) continue
    n++
    if (mark) b.c.unshift({ t: "RawInline", c: ["typst", `#pnum(${n})`] })
  }
  return n
}

/** "A", "A and B", "A, B and C". */
export const joinNames = (names) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/** Text as pandoc inlines: Str and Space. */
export const pandocWords = (text) =>
  String(text)
    .split(/(\s+)/)
    .filter(Boolean)
    .map((w) => (/^\s+$/.test(w) ? { t: "Space" } : { t: "Str", c: w }))
const para = (...inlines) => ({ t: "Para", c: inlines.flat(Infinity) })
const strong = (text) => ({ t: "Strong", c: pandocWords(text) })
const linkTo = (url, text = url) => ({ t: "Link", c: [["", [], []], pandocWords(text), [url, ""]] })

/**
 * The export's front page, as pandoc blocks after the title, authors and date
 * (pandoc's own title block): publisher, published date, version, canonical
 * URL, licence and the APA citation (`apa`, the build's runs). A page break
 * follows it in the PDF.
 */
export function frontPage(meta, { version, apa }) {
  const line = (label, ...value) => para(strong(`${label}:`), { t: "Space" }, ...value)
  return [
    {
      t: "Div",
      c: [
        ["front-page", [], []],
        [
          // Authors are pandoc's title block; editors (the book's, or a chapter's container's) here.
          ...(meta.editors?.length
            ? [
                line(
                  meta.book ? "In a book edited by" : "Edited by",
                  pandocWords(joinNames(meta.editors.map((e) => e.name))),
                ),
              ]
            : []),
          line("Publisher", pandocWords(meta.publisher)),
          line("Published", pandocWords(meta.published || "not yet")),
          line("Version", pandocWords(version)),
          line("Online at", linkTo(meta.url)),
          line(
            "Licence",
            pandocWords(`This work is licensed under ${licenceName(meta.licence.id)} (`),
            linkTo(meta.licence.url),
            pandocWords(meta.rights === "open access" ? "). Open access." : ")."),
          ),
          line(
            "Cite as",
            apa.map((r) =>
              r.italic ? { t: "Emph", c: pandocWords(r.text) } : pandocWords(r.text),
            ),
          ),
        ],
      ],
    },
    { t: "RawBlock", c: ["typst", "#pagebreak()"] },
  ]
}

/** "CC-BY-SA-4.0" as people write it: "CC BY-SA 4.0"; any other id as it is. */
export const licenceName = (id) =>
  /^CC0-1\.0$/.test(id)
    ? "CC0 1.0"
    : (/^CC-([A-Z-]+)-(\d\.\d)$/.exec(id)?.slice(1).join(" ").replace(/^/, "CC ") ?? id)

/** pandoc's metadata for an export: title, authors, date, language. */
export const exportMeta = (meta) => {
  const str = (s) => ({ t: "MetaInlines", c: pandocWords(s) })
  return {
    title: str(meta.title),
    author: { t: "MetaList", c: meta.creators.map((c) => str(c.name)) },
    ...(meta.published ? { date: str(meta.published) } : {}),
    lang: { t: "MetaString", c: meta.lang },
  }
}

// --- The exports' fonts: design.yaml's families, embedded --------------------
// The families the builder knows how to fetch (SIL OFL, from their upstream
// releases, pinned in .github/actions/export-tools), and each one's static
// files by weight and style. design.yaml names the families; a family not
// here, or whose files aren't there, falls back to Typst's and the readers'
// defaults with a warning.

export const EXPORT_FONTS = {
  "Source Serif 4": { dir: "source-serif-4", generic: "serif", stem: "SourceSerif4", ext: "otf" },
  "Source Sans 3": { dir: "source-sans-3", generic: "sans-serif", stem: "SourceSans3", ext: "otf" },
  "JetBrains Mono": {
    dir: "jetbrains-mono",
    generic: "monospace",
    stem: "JetBrainsMono",
    ext: "ttf",
  },
}
const FACES = [
  [400, "normal", { otf: "Regular", ttf: "Regular" }],
  [400, "italic", { otf: "It", ttf: "Italic" }],
  [600, "normal", { otf: "Semibold", ttf: "SemiBold" }],
  [600, "italic", { otf: "SemiboldIt", ttf: "SemiBoldItalic" }],
  [700, "normal", { otf: "Bold", ttf: "Bold" }],
  [700, "italic", { otf: "BoldIt", ttf: "BoldItalic" }],
]

/**
 * The exports' fonts from design.yaml's `fonts` (text, ui, mono), under
 * `root` (one folder per family). `exists(path)` checks a file. Each role is
 * { family, dir, generic, faces: [{ weight, style, path }] } or null, with a
 * warning saying why.
 */
export function exportFonts(designFonts = {}, root, exists) {
  const warnings = []
  const role = (name) => {
    const family = String(designFonts?.[name] ?? "").trim()
    if (!family) return null
    const known = EXPORT_FONTS[family]
    if (!known) {
      warnings.push(
        `design.yaml's ${name} font "${family}" is not one the builder fetches (${Object.keys(EXPORT_FONTS).join(", ")}); the downloads use the default.`,
      )
      return null
    }
    const dir = `${root}/${known.dir}`
    const faces = FACES.map(([weight, style, names]) => ({
      weight,
      style,
      path: `${dir}/${known.stem}-${names[known.ext]}.${known.ext}`,
    }))
    const missing = faces.filter((f) => !exists(f.path))
    if (missing.length) {
      warnings.push(
        `${family}'s files are missing (${missing.map((f) => f.path.split("/").pop()).join(", ")}); the downloads use the default for the ${name} font.`,
      )
      return null
    }
    return { family, dir, generic: known.generic, faces }
  }
  return { text: role("text"), ui: role("ui"), mono: role("mono"), warnings }
}

const cssString = (s) => `"${s.replace(/["\\]/g, "\\$&")}"`

/** The EPUB's font CSS: @font-face for each embedded file (pandoc puts them in fonts/), then the roles. */
export function epubFontCss(fonts) {
  const roles = [fonts.text, fonts.ui, fonts.mono].filter(Boolean)
  const faces = roles.flatMap((r) =>
    r.faces.map(
      (f) =>
        `@font-face { font-family: ${cssString(r.family)}; font-weight: ${f.weight}; font-style: ${f.style}; src: url("../fonts/${f.path.split("/").pop()}"); }`,
    ),
  )
  const use = (r, sel) =>
    r ? [`${sel} { font-family: ${cssString(r.family)}, ${r.generic}; }`] : []
  return [
    ...faces,
    ...use(fonts.text, "body"),
    ...use(fonts.ui, "h1, h2, h3, h4, h5, h6, .title, .subtitle, header"),
    ...use(fonts.mono, "code, pre, kbd, samp"),
  ].join("\n")
}

/** Typst's preamble for the roles: headings in the ui font (the body and code are pandoc's mainfont/codefont). */
export const typstFontRules = (fonts) =>
  fonts.ui ? `#show heading: set text(font: ${JSON.stringify(fonts.ui.family)})\n` : ""

/** Text in the ui font, for pandoc's title (Typst raw inside its metadata). */
export const uiTitle = (fonts, inlines) =>
  fonts.ui
    ? [
        { t: "RawInline", c: ["typst", `#text(font: ${JSON.stringify(fonts.ui.family)})[`] },
        ...inlines,
        { t: "RawInline", c: ["typst", "]"] },
      ]
    : inlines

/**
 * pandoc's default ODT reference styles with design.yaml's families: its
 * serif (Times New Roman) the text font, its sans (Arial, the headings) the ui
 * font, its mono (Courier New) the code font. ODT names fonts, it can't carry
 * them: a reader without them installed sees their own fallback.
 */
export function odtStyles(xml, fonts) {
  let out = xml
  for (const [from, role] of [
    ["Times New Roman", fonts.text],
    ["Arial", fonts.ui],
    ["Courier New", fonts.mono],
  ]) {
    if (!role) continue
    const to = role.family.replace(/[&<>"']/g, "")
    out = out
      .replaceAll(`"${from}"`, `"${to}"`)
      .replaceAll(`"'${from}'"`, `"'${to}'"`)
      .replaceAll(`"&apos;${from}&apos;"`, `"&apos;${to}&apos;"`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Credit on the page (batch 2a): the byline under a chapter's title, its
// contributors after the article, the front page's credits block. Written into the
// built HTML by finish.mjs, outside <article>, so the text Hypothes.is anchors on
// doesn't move; styled by edit-on-github (.tb-byline, .tb-credits-foot,
// .tb-credits-block, .tb-role).

/** Text for HTML: & < > " escaped. */
export const escHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/** Where the contributors page puts a page's credits (gen-contributors' pageAnchor). */
export { pageAnchor }

/** How many names a chapter's foot shows before "and n others". */
export const FOOT_NAMES = 8

const roleBadgeHtml = (role) =>
  `<span class="tb-role" data-role="${role}">${CREDIT_ROLES[role].label}</span>`

/** "By A and B · Edited by C" under a page's title; "" for neither. */
export function bylineHtml(meta) {
  const parts = []
  if (meta.creators?.length)
    parts.push(`By ${escHtml(joinNames(meta.creators.map((c) => c.name)))}`)
  if (meta.editors?.length)
    parts.push(`Edited by ${escHtml(joinNames(meta.editors.map((c) => c.name)))}`)
  return parts.length
    ? `<p class="tb-byline">${parts.join('<span class="tb-sep" aria-hidden="true">·</span>')}</p>`
    : ""
}

/** "With contributions from X, Y and Z" (FOOT_NAMES names, then "and n others"), linked to the contributors page; "" for none. */
export function creditsFootHtml(contributors, href) {
  if (!contributors.length) return ""
  const names = contributors.map((c) => escHtml(c.name))
  const shown =
    names.length > FOOT_NAMES
      ? `${names.slice(0, FOOT_NAMES).join(", ")} and ${names.length - FOOT_NAMES} other${names.length - FOOT_NAMES === 1 ? "" : "s"}`
      : joinNames(names)
  const text = `With contributions from ${shown}.`
  return `<p class="tb-credits-foot">${href ? `<a href="${escHtml(href)}">${text}</a>` : text}</p>`
}

/** The front page's credits: its authors and editors, and how many contributors, linked to the contributors page. */
export function creditsBlockHtml(meta, contributorCount, href) {
  const line = (role, people) =>
    people.length
      ? `<p>${roleBadgeHtml(role)} ${escHtml(joinNames(people.map((p) => p.name)))}</p>`
      : ""
  const count = contributorCount
    ? `${roleBadgeHtml("contributor")} ${contributorCount} ${contributorCount === 1 ? "person has" : "people have"} contributed`
    : ""
  const more = href
    ? `<a href="${escHtml(href)}">${count ? `${count}: see who, and how credit works` : "Contributors and how credit works"}</a>`
    : count
  const body = [
    line("author", meta.creators ?? []),
    line("editor", meta.editors ?? []),
    more ? `<p>${more}</p>` : "",
  ].join("")
  // The book's version history (batch 2a, Part B), from the same block.
  const history = `<p><a href="/${HISTORY_PAGE}">Book history: what has changed, and what is being edited</a></p>`
  return `<div class="tb-credits-block" role="note" aria-label="Credits">${body}${history}</div>`
}

/** `extra` after the page's title heading (Quartz's h1.article-title); unchanged when there is none or nothing to add. */
export function addAfterTitle(html, extra) {
  if (!extra) return html
  const m = /<h1 class="article-title"[^>]*>[\s\S]*?<\/h1>/.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + extra + html.slice(m.index + m[0].length) : html
}

/** `extra` after the page's <article>: outside the text annotations anchor on. */
export function addAfterArticle(html, extra) {
  if (!extra) return html
  const i = html.indexOf("</article>")
  return i === -1
    ? html
    : html.slice(0, i + "</article>".length) + extra + html.slice(i + "</article>".length)
}

/** The exports' back matter: a "Contributors" page naming them (names only), or nothing. */
export function contributorsBackMatter(contributors) {
  if (!contributors?.length) return []
  return [
    { t: "RawBlock", c: ["typst", "#pagebreak(weak: true)"] },
    { t: "Header", c: [1, ["contributors", ["unnumbered"], []], pandocWords("Contributors")] },
    para(
      pandocWords(
        `With thanks to ${joinNames(contributors.map((c) => c.name))}, whose contributions the authors accepted.`,
      ),
    ),
  ]
}

// ---------------------------------------------------------------------------
// Version history (batch 2a, Part B): what readers see as three plain states,
// Published (on the live branch), Being edited (on drafts, not yet published)
// and Proposed (open proposals and notes, asked for at view time from the
// function's /api/history), with the book's releases (its v* tags) as
// milestones. prepare.mjs reads git; these functions shape it. Deterministic: no
// timestamp of the build's own, no build head.

export const HISTORY_PATH = ".well-known/history.json"
/** The builder's book history page, /history, beside /how-to-comment. */
export const HISTORY_PAGE = "history"
export const HISTORY_VERSION = 1

const STOCK = [
  [/^Edit ¶(\d+) of \S+$/, (m) => `Paragraph ${m[1]} changed`],
  [/^(?:Update|Edit) \S+\.md$/i, () => "Text changed"],
  [/^(?:Create|Add) \S+\.md$/i, () => "First published"],
]
const CONVENTIONAL =
  /^(?:chore|fix|docs|feat|refactor|style|test|build|ci|perf)(?:\([^)]*\))?!?:\s+/i

/**
 * A commit's summary as readers see it, and the pull request it came through:
 * batch 1's edit summary where there is one (propose-edit's subject, in full from
 * the message when it was cut at 72), a PR title's "Update file: " head and a
 * "(#n)" tail taken off, conventional-commit prefixes dropped, the platform's
 * stock messages said in words.
 */
export function historySummary(subject = "", body = "") {
  let s = String(subject).trim()
  let pr = null
  const tail = /\s*\(#(\d+)\)\s*$/.exec(s)
  if (tail) {
    pr = Number(tail[1])
    s = s.slice(0, tail.index)
  }
  if (s.endsWith("…")) {
    const full = String(body)
      .split(/\n\s*\n/)[1]
      ?.replace(/\s+/g, " ")
      .trim()
    if (full && full.startsWith(s.slice(0, -1))) s = full
  }
  s = s
    .replace(/^(?:Update|Edit ¶\d+ of) [^:\s]+: /, "")
    .replace(CONVENTIONAL, "")
    .trim()
  for (const [re, say] of STOCK) {
    const m = re.exec(s)
    if (m) return { summary: say(m), pr }
  }
  return { summary: s || "Changed", pr }
}

/** A history entry's person in their role on the page: author, editor, contributor, or null (automation). */
export function roleOf(rev, { creators = [], editors = [] } = {}) {
  if (rev.automation) return null
  const who = String(rev.who ?? "").toLowerCase()
  const is = (p) => p.name.toLowerCase() === who || p.github?.toLowerCase() === who
  if (creators.some(is)) return "author"
  if (editors.some(is)) return "editor"
  return "contributor"
}

/**
 * /.well-known/history.json. `files`: { path: { published, drafts, releases } }
 * from prepare.mjs (revisions, newest first, with their message bodies; releases
 * { tag: the page's version sha at that tag, or null }). `pages`: { path: { url,
 * title, people: { creators, editors } } }. `releases`: [{ tag, date, commit }].
 */
export function historyData({ files, pages, releases }) {
  const entry = (people, source) => (r) => {
    const { summary, pr } = historySummary(r.message, r.body)
    return {
      sha: r.sha,
      date: dateOnly(r.date),
      who: r.automation ? "the platform" : r.who,
      role: roleOf(r, people),
      summary,
      ...(pr ? { pr } : {}),
      // The page's path in that commit, where it has moved since (page-revision needs it).
      ...(r.path && r.path !== source ? { path: r.path } : {}),
    }
  }
  return {
    version: HISTORY_VERSION,
    releases: [...releases]
      .sort((a, b) => a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag))
      .map(({ tag, date }) => ({ tag, date: dateOnly(date) })),
    pages: Object.keys(files)
      .filter((path) => pages[path])
      .sort()
      .map((path) => {
        const f = files[path]
        const p = pages[path]
        return {
          path: p.url,
          source: path,
          title: p.title,
          published: f.published.map(entry(p.people, path)),
          drafts: f.drafts.map(entry(p.people, path)),
          releases: f.releases,
        }
      }),
  }
}

const RELEASE_LABEL = (tag) => tag.replace(/^v/i, "")

/**
 * The book's history as a small SVG that works without scripts (the /history
 * page): three lanes, Proposed, Being edited and Published, a dot per change
 * along the time axis (its <title> the summary, which a browser shows on hover),
 * the releases as vertical rules. Proposed is drawn empty here: what is proposed
 * changes between builds, and the page's script adds it.
 */
export function swimlaneSvg(history, { width = 760 } = {}) {
  const changes = history.pages.flatMap((p) => [
    ...p.drafts.map((e) => ({ ...e, lane: 1, title: p.title })),
    ...p.published.map((e) => ({ ...e, lane: 2, title: p.title })),
  ])
  const dates = [...changes.map((c) => c.date), ...history.releases.map((r) => r.date)]
    .filter(Boolean)
    .sort()
  const left = 118
  const right = 16
  const top = 22
  const lane = 34
  const height = top + lane * 3 + 26
  const t0 = Date.parse(dates[0] ?? "2026-01-01")
  const t1 = Math.max(Date.parse(dates.at(-1) ?? "2026-01-01"), t0 + 86400000)
  const x = (d) => (left + ((Date.parse(d) - t0) / (t1 - t0)) * (width - left - right)).toFixed(1)
  const y = (l) => top + lane * l + lane / 2
  const names = ["Proposed", "Being edited", "Published"]
  const out = [
    `<svg class="tb-swimlane" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tb-swim-t" xmlns="http://www.w3.org/2000/svg">`,
    `<title id="tb-swim-t">The book's changes over time: ${changes.filter((c) => c.lane === 2).length} published, ${changes.filter((c) => c.lane === 1).length} being edited${history.releases.length ? `, and ${history.releases.length} release${history.releases.length === 1 ? "" : "s"}` : ""}.</title>`,
  ]
  names.forEach((n, l) => {
    out.push(
      `<rect class="tb-swim-lane" x="0" y="${top + lane * l}" width="${width}" height="${lane}" data-lane="${l}"/>`,
    )
    out.push(`<text class="tb-swim-name" x="8" y="${y(l) + 4}">${n}</text>`)
  })
  for (const r of history.releases) {
    const rx = x(r.date)
    out.push(
      `<line class="tb-swim-release" x1="${rx}" x2="${rx}" y1="${top - 6}" y2="${top + lane * 3}"/>`,
    )
    out.push(
      `<text class="tb-swim-release-label" x="${rx}" y="${top - 9}" text-anchor="middle">${escHtml(RELEASE_LABEL(r.tag))}</text>`,
    )
  }
  for (const c of [...changes].sort(
    (a, b) => a.date.localeCompare(b.date) || a.sha.localeCompare(b.sha),
  )) {
    out.push(
      `<circle class="tb-swim-dot" data-lane="${c.lane}" cx="${x(c.date)}" cy="${y(c.lane)}" r="5" tabindex="0"><title>${escHtml(`${c.date} · ${c.title}: ${c.summary} (${c.who})`)}</title></circle>`,
    )
  }
  if (dates.length) {
    out.push(`<text class="tb-swim-axis" x="${left}" y="${height - 8}">${dates[0]}</text>`)
    out.push(
      `<text class="tb-swim-axis" x="${width - right}" y="${height - 8}" text-anchor="end">${dates.at(-1)}</text>`,
    )
  }
  out.push("</svg>")
  return out.join("")
}

/** The /history page's markdown: the swimlane, the place the script fills, and a plain list for no script. */
export function historyPageMarkdown(history, { repo }) {
  const recent = history.pages
    .flatMap((p) => p.published.map((e) => ({ ...e, title: p.title, url: p.path })))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
    .slice(0, 30)
  const releases = [...history.releases].reverse()
  return [
    "---",
    "title: Book history",
    "tbBuilderPage: true",
    "paragraphNumbers: false",
    "---",
    "",
    "Every change to this book, in three states: **Proposed** (sent by a reader, waiting for the authors), **Being edited** (accepted, not yet published) and **Published** (what you read). Releases are marked as milestones.",
    "",
    `<figure class="tb-swim">${swimlaneSvg(history)}</figure>`,
    "",
    "<div data-tb-book-history></div>",
    "",
    ...(releases.length
      ? [
          "## Releases",
          "",
          ...releases.map(
            (r) =>
              `- **${escHtml(RELEASE_LABEL(r.tag))}**, ${r.date}: [the book as it was](https://github.com/${repo}/tree/${encodeURIComponent(r.tag)})`,
          ),
          "",
        ]
      : []),
    '<div class="tb-history-static">',
    "",
    "## Recently published",
    "",
    ...(recent.length
      ? recent.map(
          (e) =>
            `- ${e.date}, [${escHtml(e.title)}](${e.url}): ${escHtml(e.summary)} (${escHtml(e.who)})`,
        )
      : ["Nothing published yet."]),
    "",
    "</div>",
    "",
  ].join("\n")
}
