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
  // book, so a preview book on *.pages.dev never counts. Until the registry has
  // platform.analytics, the book's own analytics.plausible is read instead.
  const counted = book.status === "live"
  const platformSrc = registry.platform?.analytics?.plausible?.script_src
  const plausibleSrc = platformSrc ?? book.analytics?.plausible?.script_src ?? ""
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
    plausibleScriptSrc: counted ? plausibleSrc : "",
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
 * platform values a build reads (the suggest-edit endpoint and the Plausible
 * site), so a change to either rebuilds the book, and a change to another
 * book's entry doesn't. `analytics` joins the input only once the registry has
 * it, so no digest moves until then.
 */
export function registryDigest(registry, book) {
  const platform = { suggest_edit_endpoint: registry.platform?.suggest_edit_endpoint ?? null }
  if (registry.platform?.analytics) platform.analytics = registry.platform.analytics
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
const BUILDER_GENERATED = [
  `${HOW_TO_COMMENT}.html`,
  "_redirects",
  "_headers",
  MARKER_PATH,
  ".well-known/textbook-catalog.json",
]

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
