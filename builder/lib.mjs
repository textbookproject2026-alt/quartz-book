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
export function bookOptions(registry, book, branch) {
  if (!branch) refuse("no branch given. Say which branch this build is for.")
  const suggestEnabled = book.suggest_edit?.enabled === true
  const endpoint = registry.platform?.suggest_edit_endpoint ?? ""
  if (suggestEnabled && !endpoint)
    refuse(
      `book "${book.slug}" has suggest_edit enabled, but the registry has no platform.suggest_edit_endpoint.`,
    )
  return {
    slug: book.slug,
    title: book.title,
    domain: book.site.domain,
    repo: book.content.repo,
    branch,
    liveBranch: book.content.live_branch,
    // D13: every branch but the live one is a preview: public, but noindex.
    noindex: branch !== book.content.live_branch,
    // Shown only for books with suggest-edit on. Elsewhere the function would
    // answer 403, so the button stays hidden (edit-on-github's "" default).
    suggestEndpoint: suggestEnabled ? endpoint : "",
    plausibleScriptSrc: book.analytics?.plausible?.script_src ?? "",
    licence: book.licence,
    editionTemplateRepo: book.editions?.template_repo ?? null,
  }
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
 * one platform value a build reads (the suggest-edit endpoint), so a change to
 * either rebuilds the book, and a change to another book's entry doesn't.
 */
export function registryDigest(registry, book) {
  const input = canonicalJson({
    book,
    platform: { suggest_edit_endpoint: registry.platform?.suggest_edit_endpoint ?? null },
  })
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
 */
export function renderConfig(config, opts, ignorePatterns) {
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
  })
  Object.assign(plugin("edit-on-github").options, {
    repo: opts.repo,
    branch: opts.branch,
    contentDir: "",
    suggestEndpoint: opts.suggestEndpoint,
  })
  return out
}

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
 */
export function addCanonical(html, domain, url) {
  if (/<link rel="canonical"/.test(html)) return html
  const href = `https://${domain}${url
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/")}`
  const tag = `<link rel="canonical" href="${href}">`
  if (!html.includes("</head>"))
    throw new Error(`no </head> to put the canonical link before (${url}).`)
  return html.replace("</head>", `${tag}</head>`)
}

/**
 * The builder's own page has no file in the book, so its Edit and History
 * links would 404. Drop the controls row; the annotation badge then sits under
 * the title, as it does on any page without a row.
 */
export function stripControls(html) {
  const out = html.replace(/<div class="tb-page-controls">[\s\S]*?<\/div>/, "")
  if (out === html) throw new Error(`/${HOW_TO_COMMENT} has no controls row to remove.`)
  return out
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
const BUILDER_GENERATED = [`${HOW_TO_COMMENT}.html`, "_redirects", "_headers", MARKER_PATH]

/**
 * Whether an output path may be published: it comes from an allowlisted
 * source, or Quartz or the builder generated it. `outPath` is relative to the
 * output directory, with "/" separators.
 */
export function outputAllowed(outPath) {
  if (BUILDER_GENERATED.includes(outPath)) return true
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
