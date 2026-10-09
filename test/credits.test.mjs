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
  proposer: null,
  bot: false,
  pages: ["chapters/chapter-01.md"],
  ...extra,
})

test("commits: a merged proposal isn't counted twice (its head commit, or a squash '(#n)'); bots don't count", () => {
  const pulls = [merged(7, "@ada-l (signed in with GitHub)"), merged(8, "`Bea Reader` (`b***@x`)")]
  const commits = [
    commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7".slice(0, 33), "x", "x"),
    { ...commit("b", "Ada", "42+ada-l@users.noreply.github.com"), sha: "7".padStart(40, "a") },
    commit("c", "Bea", "app@x", {
      subject: "Update chapter-02: tidy (#8)",
      bot: true,
      proposer: "Bea Reader",
    }),
    commit("d", "github-actions[bot]", "bot@x", { bot: true }),
    commit("e", "Dee Direct", "dee@example.org"),
    commit("f", "Ann", "77+ann-gh@users.noreply.github.com"),
  ]
  const items = contributions({ pulls, commits, repoUrl: "https://github.com/o/b" })
  assert.deepEqual(
    items.map((c) => [c.kind, c.ref, c.who.name, c.who.github ?? null]),
    [
      ["edit", "#7", "ada-l", "ada-l"],
      ["edit", "#8", "Bea Reader", null],
      ["commit", "aaaaaaa", "x", null],
      ["commit", "eeeeeee".slice(0, 1) + "000000", "Dee Direct", null],
      ["commit", "f000000", "Ann", "ann-gh"],
    ],
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
      commit("1", "Ada Lovelace", "42+ada-l@users.noreply.github.com"),
      commit("2", "Brandon Sommer", "brandon@example.org"),
      commit("3", "BrandonAndCaroline", "9+BrandonAndCaroline@users.noreply.github.com"),
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
    commits: [commit("9", "Cy Writer", "cy@example.org")],
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
