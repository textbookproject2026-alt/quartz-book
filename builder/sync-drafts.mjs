// Keeps every book's drafts branch current with its live branch (06 Oct;
// builder/lib.mjs syncDrafts). The first job of each reconcile run, before the
// plan reads the branch heads, so the run that moves drafts also builds it. The
// build-nudge Worker ignores the push this makes (its actor is one of the two
// Apps below, on a drafts branch), so a sync never starts another run, and a
// drafts branch that is already current gets no write at all.
//
//   node builder/sync-drafts.mjs
//
// Environment: SLUG (one book; empty for all), BOOKS_OWNER + BOOKS_TOKEN (the
// books App, Contents write, for the books org), PLATFORM_OWNER + PLATFORM_TOKEN
// (the quartz-book bot App, for books in the platform's own account),
// REGISTRY_FILE (a local registry.json, for testing). Never fails the run: what it
// can't do is a warning and a line in the run summary.
import { appendFileSync, readFileSync } from "node:fs"
import { REGISTRY_URL, appGap, ownerTokens, reconcileTargets, syncDrafts } from "./lib.mjs"

const summary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  else process.stdout.write(text)
}
const warn = (slug, text) => console.log(`::warning title=${slug}::${text.replaceAll("`", "")}`)

const client = (token) => async (path, { method = "GET", body } = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

const SAID = {
  current: () => "drafts already has everything on the live branch; nothing written.",
  "fast-forwarded": (r) => `drafts fast-forwarded to the live branch (${r.sha.slice(0, 7)}).`,
  merged: (r) => `the live branch merged into drafts (${r.sha.slice(0, 7)}).`,
  conflict: () =>
    "the live branch and drafts conflict, so nothing was merged. The branch check's issue on the book asks for it by hand.",
  error: (r) => `GitHub answered ${r.status} at the ${r.step}, so drafts was left as it is.`,
}

try {
  const registry = process.env.REGISTRY_FILE
    ? JSON.parse(readFileSync(process.env.REGISTRY_FILE, "utf8"))
    : await (await fetch(REGISTRY_URL)).json()
  const slugs = new Set(reconcileTargets(registry, { slug: process.env.SLUG ?? "" }).map((t) => t.slug))
  const books = registry.books.filter(
    (b) => slugs.has(b.slug) && b.content.drafts_branch && b.content.drafts_branch !== b.content.live_branch,
  )
  const tokens = ownerTokens(process.env)
  const installed = new Map()
  for (const [owner, t] of tokens) {
    if (!t.token) continue
    const r = await client(t.token)("/installation/repositories?per_page=100")
    installed.set(owner, new Set((r.data?.repositories ?? []).map((x) => x.full_name.toLowerCase())))
  }
  summary("### Drafts kept current\n\n")
  for (const book of books) {
    try {
      const gap = appGap(book.content.repo, tokens, installed)
      if (gap) {
        summary(`**${book.slug}**: ${gap.why}\n\n`)
        warn(book.slug, `drafts not synced: ${gap.why}`)
        continue
      }
      const owner = book.content.repo.split("/")[0].toLowerCase()
      const result = await syncDrafts(book.content, client(tokens.get(owner).token))
      summary(`**${book.slug}**: ${SAID[result.outcome](result)}\n\n`)
      if (result.outcome === "conflict" || result.outcome === "error")
        warn(book.slug, SAID[result.outcome](result))
    } catch (err) {
      warn(book.slug, `the drafts sync couldn't finish: ${err.message}`)
    }
  }
} catch (err) {
  console.log(`::warning title=sync-drafts::${err.message}`)
}
