// The reconcile tick's branch check (05 Oct): for every book on the builder, the
// work its builds never see (builder/lib.mjs branchFindings). Each finding is a
// warning and a line in the run summary. With ISSUES_TOKEN (the books App), one
// issue per book is kept up to date, and closed once nothing is flagged.
//
//   node builder/branches.mjs
//
// Environment: GH_TOKEN (reads; the book repos are public), ISSUES_TOKEN
// (optional), REGISTRY_FILE (a local registry.json, for testing).
import { appendFileSync, readFileSync } from "node:fs"
import { REGISTRY_URL, booksAppGap, branchFindings, reconcileTargets } from "./lib.mjs"

const TITLE = "Changes outside drafts"
const FOOT =
  "\n\n_Kept up to date every 15 minutes by the platform's reconcile run, and closed once nothing is flagged._\n"

const summary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  else process.stdout.write(text)
}

async function gh(path, { token = process.env.GH_TOKEN, method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok)
    throw new Error(`${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.status === 204 ? null : res.json()
}

async function findings(content) {
  const { repo, drafts_branch: drafts } = content
  const changed = {}
  for (const b of await gh(`/repos/${repo}/branches?per_page=100`)) {
    if (b.name === drafts) continue
    const cmp = await gh(
      `/repos/${repo}/compare/${encodeURIComponent(drafts)}...${encodeURIComponent(b.name)}`,
    )
    changed[b.name] = cmp.ahead_by ? (cmp.files ?? []).length : 0
  }
  const pulls = (
    await gh(
      `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(content.live_branch)}&per_page=100`,
    )
  ).map((p) => ({ number: p.number, head: p.head.ref }))
  return branchFindings(content, { changed, pulls })
}

/** Open, update or close the book's one issue. */
async function keepIssue(repo, found, token) {
  const open = (await gh(`/repos/${repo}/issues?state=open&per_page=100`, { token })).find(
    (i) => i.title === TITLE && !i.pull_request && i.user?.type === "Bot",
  )
  const body = `Work that the reading site and the drafts preview don't build, or that skipped \`drafts\`:\n\n${found.map((f) => `- ${f}`).join("\n")}${FOOT}`
  if (!found.length) {
    if (open)
      await gh(`/repos/${repo}/issues/${open.number}`, {
        token,
        method: "PATCH",
        body: { state: "closed", body: `Nothing is flagged any more.${FOOT}` },
      })
  } else if (!open)
    await gh(`/repos/${repo}/issues`, { token, method: "POST", body: { title: TITLE, body } })
  else if (open.body !== body)
    await gh(`/repos/${repo}/issues/${open.number}`, { token, method: "PATCH", body: { body } })
}

const registry = process.env.REGISTRY_FILE
  ? JSON.parse(readFileSync(process.env.REGISTRY_FILE, "utf8"))
  : await (await fetch(REGISTRY_URL)).json()
const books = registry.books.filter((b) =>
  reconcileTargets(registry).some((t) => t.slug === b.slug),
)
// The books App's token reaches only the repos in its installation: the books org
// (registry platform.books_owner), all repositories. A book there that the token
// can't see is reported; one outside the org can't be, and is skipped quietly.
const OWNER = registry.platform.books_owner
const installed = process.env.ISSUES_TOKEN
  ? new Set(
      (
        await gh("/installation/repositories?per_page=100", { token: process.env.ISSUES_TOKEN })
      ).repositories.map((r) => r.full_name),
    )
  : null
summary("### Changes outside drafts\n\n")
for (const book of books.filter((b) => b.content.drafts_branch)) {
  try {
    const found = await findings(book.content)
    summary(
      found.length
        ? `**${book.slug}**\n\n${found.map((f) => `- ${f}`).join("\n")}\n\n`
        : `**${book.slug}**: nothing flagged.\n\n`,
    )
    for (const f of found) console.log(`::warning title=${book.slug}::${f.replaceAll("`", "")}`)
    if (!installed) continue
    const gap = booksAppGap(book.content.repo, installed, OWNER)
    if (!gap) await keepIssue(book.content.repo, found, process.env.ISSUES_TOKEN)
    else {
      summary(`_${gap.why}_\n\n`)
      if (gap.fix) console.log(`::warning title=${book.slug}::${gap.why}`)
    }
  } catch (err) {
    console.log(`::warning title=${book.slug}::the branch check couldn't finish: ${err.message}`)
  }
}
if (!process.env.ISSUES_TOKEN)
  summary("_No books App here (BOOKS_APP_CLIENT_ID), so no issues were opened or updated._\n")
