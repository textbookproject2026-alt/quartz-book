// The credit ledger (automation/scripts/lib/credits.mjs) and the shared
// attribution parser, against the shapes GitHub gives for the test book's real
// items (fixtures/credits/: #12 an accepted note, #14 a declined proposal, #15 a
// note closed as not planned). No network.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { attributionOf, contributorOf, filesOf } from "../automation/scripts/lib/attribution.mjs"
import {
  applyOverrides,
  buildLedger,
  contributions,
  isAutomation,
  issueKind,
  normaliseOverrides,
  pageContributors,
  peopleOf,
} from "../automation/scripts/lib/credits.mjs"

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/credits/${name}`, import.meta.url), "utf8"))
const note12 = fixture("issue-12.json")
const note15 = fixture("issue-15.json")
const pr14 = fixture("pull-14.json")

test("attribution: signed in, a name in a code span, or nobody", () => {
  assert.deepEqual(attributionOf(note12.body), { login: "gobi10k" })
  assert.deepEqual(attributionOf(note15.body), { name: "Platform test" })
  assert.deepEqual(attributionOf("**Proposed by:** `A Reader` (`r***@example.org`)"), {
    name: "A Reader",
  })
  assert.deepEqual(attributionOf("**Proposed by:** `` `ticked` `` (`r***@example.org`)"), {
    name: "`ticked`",
  })
  assert.equal(attributionOf("**Proposed by:** a reader (`r***@example.org`)"), null)
  assert.equal(attributionOf("no line"), null)
  assert.equal(contributorOf(note12.body), "gobi10k")
  assert.equal(contributorOf(note15.body), null)
  assert.deepEqual(filesOf(note12.body), ["chapters/chapter-01.md"])
})

test("what counts: an accepted note, not a declined proposal or a note closed as not planned", () => {
  const items = contributions({ pulls: [pr14], issues: [note12, note15] })
  assert.deepEqual(items, [
    {
      who: { name: "gobi10k", github: "gobi10k" },
      kind: "note",
      ref: "#12",
      url: note12.html_url,
      date: note12.closed_at.slice(0, 10),
      pages: ["chapters/chapter-01.md"],
    },
  ])
  assert.equal(issueKind([{ name: "suggested-edit" }, { name: "section-note" }]), "note")
  assert.equal(issueKind(["suggested-edit"]), "suggestion")
  assert.equal(issueKind(["proposed-edit"]), "edit")
  assert.equal(issueKind(["bug"]), null)
})

const PR_BODY = (who) =>
  `**File:** [\`chapters/chapter-02.md\`](x)\n\n---\n\n**Proposed by:** ${who}\n`
const merged = (number, who, extra = {}) => ({
  number,
  merged_at: `2026-10-0${number % 9}T10:00:00Z`,
  body: PR_BODY(who),
  labels: [{ name: "proposed-edit" }],
  html_url: `https://github.com/o/b/pull/${number}`,
  head: { sha: `${number}`.padStart(40, "a") },
  ...extra,
})
const commit = (sha, name, email, extra = {}) => ({
  sha: sha.padEnd(40, "0"),
  name,
  email,
  date: "2026-10-01T09:00:00+02:00",
  subject: "Fix a typo",
  body: "",
  proposer: null,
  bot: false,
  pages: ["chapters/chapter-01.md"],
  ...extra,
})
/** A commit the author site made for a member: the member as author, the App as committer. */
const viaSite = (sha, name, login, extra = {}) =>
  commit(sha, name, `1+${login}@users.noreply.github.com`, {
    body: `Edit chapter one\n\nSent by @${login} via the author site.\n`,
    ...extra,
  })
// The registry's automation-accounts list, as of batch 2b.
const AUTOMATION = isAutomation({
  logins: ["aldogobot"],
  identities: [
    "textbookproject2026-alt",
    "github-actions",
    "quartz-book-bot",
    "textbook-suggest-edit",
    "confused4now-books",
    "aldogo-bot",
    "Claude",
    "Claude Code",
    "noreply@anthropic.com",
    "@anthropic.com",
  ],
})

test("commits: only author-site edits by members, and readers' names; raw git authorship never counts", () => {
  const pulls = [merged(7, "@ada-l (signed in with GitHub)"), merged(8, "`Bea Reader` (`b***@x`)")]
  const commits = [
    // Direct commits, whoever made them: nothing.
    commit("a", "Dee Direct", "dee@example.org"),
    commit("b", "Ann", "77+ann-gh@users.noreply.github.com"),
    // Made through the author site for a member: credited to the member.
    viaSite("c", "Ann Author", "ann-gh"),
    // A member without GitHub (batch 2b), by their platform noreply address.
    commit("d", "Mo Member", "m-0f3a@users.noreply.confused4now.org"),
    // How a counted pull request landed: not again.
    { ...viaSite("e", "Ada", "ada-l"), sha: "7".padStart(40, "a") },
    commit("f", "Bea", "app@x", {
      subject: "Update chapter-02: tidy (#8)",
      bot: true,
      proposer: "Bea Reader",
    }),
    // A reader's name on an in-site proposal the App committed.
    commit("g", "textbook-suggest-edit[bot]", "app@x", { bot: true, proposer: "Gil Reader" }),
  ]
  const items = contributions({
    pulls,
    commits,
    repoUrl: "https://github.com/o/b",
    automation: AUTOMATION,
  })
  assert.deepEqual(
    items.map((c) => [c.kind, c.ref, c.who.name, c.who.github ?? null]),
    [
      ["edit", "#7", "ada-l", "ada-l"],
      ["edit", "#8", "Bea Reader", null],
      ["commit", "c000000", "Ann Author", "ann-gh"],
      ["commit", "d000000", "Mo Member", null],
      ["commit", "g000000", "Gil Reader", null],
    ],
  )
  for (const c of items) assert.equal("email" in c.who, false, "no email in the ledger")
})

test("only people: Claude, bots, the platform's Apps and its own account are never credited", () => {
  const claudeCommit = commit("1", "Claude", "noreply@anthropic.com")
  const claudeViaSite = viaSite("2", "Claude", "claude-helper", { email: "noreply@anthropic.com" })
  const coAuthored = viaSite("3", "Ann Author", "ann-gh", {
    body: "Edit\n\nSent by @ann-gh via the author site.\n\nCo-authored-by: Claude <noreply@anthropic.com>\n",
  })
  const platform = viaSite("4", "textbookproject2026-alt", "textbookproject2026-alt")
  const aiProposer = commit("5", "textbook-suggest-edit[bot]", "app@x", {
    bot: true,
    proposer: "Claude Code",
  })
  const anthropicDomain = viaSite("6", "Someone", "some-one", { email: "someone@anthropic.com" })
  const botPr = merged(9, "@github-actions (signed in with GitHub)")
  const appPr = merged(10, "@quartz-book-bot (signed in with GitHub)")
  const botLoginPr = merged(11, "@renovate[bot] (signed in with GitHub)")
  const unattributed = { ...merged(12, "x"), body: "Weekly contributors refresh" }
  const items = contributions({
    pulls: [botPr, appPr, botLoginPr, unattributed],
    issues: [note12],
    commits: [claudeCommit, claudeViaSite, coAuthored, platform, aiProposer, anthropicDomain],
    automation: AUTOMATION,
  })
  assert.deepEqual(
    items.map((c) => [c.ref, c.who.name]),
    [
      ["#12", "gobi10k"], // a real reader's accepted note still counts
      ["3000000", "Ann Author"], // the member, not the Co-authored-by trailer
    ],
  )
  // A GitHub account of type Bot, found by lookup.
  const typed = isAutomation({ botLogins: ["some-ci"] })
  assert.equal(typed({ name: "CI", github: "some-ci" }), true)
  assert.equal(typed({ name: "Some Person", github: "someone" }), false)
  assert.equal(AUTOMATION({ name: "Claude Code" }), true)
  assert.equal(
    AUTOMATION({ name: "x", email: "49699333+dependabot[bot]@users.noreply.github.com" }),
    true,
  )
})

test("the ledger: one row per person across sources, sorted; listed authors and editors left out", () => {
  const items = contributions({
    pulls: [
      merged(7, "@ada-l (signed in with GitHub)"),
      merged(3, "@ada-l (signed in with GitHub)"),
    ],
    issues: [note12],
    commits: [
      viaSite("1", "Ada Lovelace", "ada-l"),
      commit("2", "Brandon Sommer", "m-b5@users.noreply.confused4now.org"),
      viaSite("3", "BrandonAndCaroline", "BrandonAndCaroline"),
    ],
  })
  const listed = peopleOf([
    "Brandon Sommer",
    { name: "Caroline Laschkolnig", github: "BrandonAndCaroline" },
  ])
  const ledger = buildLedger({ contributions: items, listed })
  assert.deepEqual(
    ledger.contributors.map((p) => [
      p.name,
      p.github ?? null,
      p.counts,
      p.contributions.map((c) => c.ref),
    ]),
    [
      [
        "Ada Lovelace",
        "ada-l",
        { edit: 2, note: 0, suggestion: 0, commit: 1 },
        ["#3", "#7", "1000000"],
      ],
      ["gobi10k", "gobi10k", { edit: 0, note: 1, suggestion: 0, commit: 0 }, ["#12"]],
    ],
  )
  assert.equal(ledger.version, 1)
  assert.deepEqual(buildLedger({ contributions: items, listed }), ledger, "deterministic")
  assert.deepEqual(
    pageContributors(ledger, "chapters/chapter-01.md").map((p) => p.name),
    ["Ada Lovelace", "gobi10k"],
  )
  assert.deepEqual(
    pageContributors(ledger, "chapters/chapter-02.md").map((p) => p.name),
    ["Ada Lovelace"],
  )
})

test("overrides: hide, rename, merge, no-credit (and the no-credit label)", () => {
  const items = contributions({
    pulls: [
      merged(7, "@ada-l (signed in with GitHub)"),
      merged(5, "`Ada L.` (`a***@x`)"),
      merged(6, "`Zed` (`z***@x`)", { labels: [{ name: "proposed-edit" }, { name: "no-credit" }] }),
    ],
    issues: [note12],
    commits: [commit("9", "Cy Writer", "m-c9@users.noreply.confused4now.org")],
  })
  const ledger = buildLedger({
    contributions: items,
    overrides: {
      hide: ["@gobi10k"],
      rename: { "Cy Writer": "Cyrus Writer" },
      merge: [["Ada Lovelace", "@ada-l", "Ada L."]],
      "no-credit": ["9000000"],
    },
  })
  assert.deepEqual(
    ledger.contributors.map((p) => [p.name, p.contributions.map((c) => c.ref)]),
    [["Ada Lovelace", ["#5", "#7"]]],
  )
  // The builder applies them again to a ledger written earlier: hiding someone needs no new ledger.
  const later = applyOverrides(buildLedger({ contributions: items }), {
    hide: ["Ada L.", "@ada-l"],
  })
  assert.deepEqual(
    later.contributors.map((p) => p.name),
    ["Cy Writer", "gobi10k"],
  )
  assert.deepEqual(applyOverrides(later, {}), later, "idempotent")
  assert.deepEqual(
    normaliseOverrides({ "no-credit": [12, "#14"] }).noCredit,
    new Set(["#12", "#14"]),
  )
})

test("people: names or { name, orcid, github }, as the builder reads them", () => {
  assert.deepEqual(
    peopleOf([
      "A",
      { name: "B", orcid: "https://orcid.org/0000-0002-1825-009x", github: "@bee" },
      { name: "" },
    ]),
    [{ name: "A" }, { name: "B", orcid: "0000-0002-1825-009X", github: "bee" }],
  )
  assert.deepEqual(peopleOf("A, B"), [{ name: "A" }, { name: "B" }])
})
