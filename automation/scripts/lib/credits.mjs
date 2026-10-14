// automation/scripts/lib/credits.mjs (quartz-book)
//
// The credit ledger (batch 2a): who has contributed to a book, and what, as pure
// functions. gen-contributors.mjs feeds it the book's commits and its accepted
// proposals and notes, writes community/credits.json and renders the
// contributors page from it; the builder reads credits.json and applies the
// book's community/credit-overrides.yml again at every build.
//
// The policy (Alec, 9 Oct 2026). Three roles: authors and editors (named in the
// frontmatter, cited) and contributors (acknowledged, never cited). A
// contributor is anyone with an accepted contribution:
//   edit        a proposed edit (pull request labelled proposed-edit) merged, or
//               closed labelled accepted-in-part (Review all in chapter took some of it)
//   note        a note on a paragraph (issue labelled section-note) closed as completed
//   suggestion  a suggested edit (issue labelled suggested-edit) closed as completed
//   commit      an edit a member of the book made through the author site
// Declined items earn nothing. Anonymous suggesters are credited by the name they
// gave. Listed authors and editors aren't also listed as contributors. A
// `no-credit` label, or the overrides file's no-credit list, takes an item out.
//
// Who is credited (Alec, 9 Oct 2026, batch 2b): credit comes from an
// allowlist of sources, never from raw git authorship. A commit's author,
// committer or Co-authored-by trailer earns nothing on its own: a commit counts
// only when the author site made it for a member (its "Sent by @login via the
// author site." line, or a member's platform noreply address), or when it
// carries the name a reader gave (Proposed-by). After that, isAutomation() drops
// anyone on the registry's automation-accounts list (automation_logins and
// automation_identities), any [bot] login and any GitHub account of type Bot:
// Claude, the platform's Apps and its own account are never credited.
//
// Also (Alec, 13 Oct 2026): a change only to a page's frontmatter (credits, title,
// tags, summary) earns nothing (gen-contributors passes only the pages whose text
// changed); one person is one row, joined by GitHub login, author-site member id,
// noreply address or normalised name; items labelled platform-test and the
// platform's test identities (in automation_identities) are never credited; the
// page says "edit" for both an accepted proposal and an author-site edit.
//
// Deterministic: contributors sorted by name, each one's contributions by
// reference (numbered items first, then commits by date and sha), no dates of
// generation.

import { attributionOf, filesOf } from './attribution.mjs';

export const LEDGER_VERSION = 1;
export const KINDS = ['edit', 'note', 'suggestion', 'commit'];

const LOGIN = /^@?([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/;
const ORCID = /^(?:https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i;
const NOREPLY = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i;
/** The member id in the author site's line for an email member: "Sent by Name (member m-…) via the author site." */
export const MEMBER_LINE = /^Sent by .+ \(member (m-[a-z0-9][a-z0-9-]{0,39})\) via the author site\.$/m;
/** The line the author site writes in every commit it makes for a member. */
export const AUTHOR_SITE = /^Sent by @([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}) via the author site\.$/m;
/** A member's platform noreply address (batch 2b: members without GitHub). */
export const MEMBER_EMAIL = /^m-([a-z0-9][a-z0-9-]{0,39})@users\.noreply\.confused4now\.org$/i;

/**
 * Who is never credited. `logins` and `identities` are the registry's
 * platform.automation_logins and platform.automation_identities; `botLogins` the
 * GitHub accounts found to be of type Bot. An identity "@example.com" matches an
 * email domain; any other matches a whole name, login or email. Case-insensitive.
 * -> (who: { name, github?, email? }) => boolean
 */
export function isAutomation({ logins = [], identities = [], botLogins = [] } = {}) {
  const whole = new Set([...logins, ...botLogins, ...identities.filter((i) => !i.startsWith('@'))].map((x) => x.toLowerCase()));
  const domains = identities.filter((i) => i.startsWith('@')).map((d) => d.toLowerCase());
  return (who) => {
    const keys = [who?.name, who?.github, who?.email].filter(Boolean).map((x) => String(x).trim().toLowerCase());
    if (keys.some((k) => k.includes('[bot]') || whole.has(k))) return true;
    const githubFromEmail = NOREPLY.exec(who?.email ?? '')?.[1]?.toLowerCase();
    if (githubFromEmail && (githubFromEmail.endsWith('[bot]') || whole.has(githubFromEmail))) return true;
    return keys.some((k) => k.includes('@') && domains.some((d) => k.endsWith(d)));
  };
}

/** A name as compared: Unicode-normalised, spaces collapsed, case-folded. */
export const nameKey = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v == null ? [] : [v]);
const day = (iso) => String(iso ?? '').slice(0, 10);

/** People from a frontmatter value (authors:, editors:): names, "A, B", or { name, orcid, github }. */
export function peopleOf(raw) {
  return list(raw).flatMap((item) => {
    if (item && typeof item === 'object') {
      const name = String(item.name ?? '').trim();
      if (!name) return [];
      const orcid = ORCID.exec(String(item.orcid ?? '').trim())?.[1]?.toUpperCase();
      const github = LOGIN.exec(String(item.github ?? '').trim())?.[1];
      return [{ name, ...(orcid ? { orcid } : {}), ...(github ? { github } : {}) }];
    }
    const name = String(item ?? '').trim();
    return name ? [{ name }] : [];
  });
}

/** "@login" matches a person's GitHub login; anything else their name or login, case-insensitively. */
export function matches(person, who) {
  const w = String(who ?? '').trim();
  if (!w) return false;
  const login = person.github?.toLowerCase();
  if (w.startsWith('@')) return login === w.slice(1).toLowerCase();
  const l = nameKey(w);
  return nameKey(person.name) === l || login === l;
}

/** An issue's kind from its labels; null for one the ledger doesn't count. */
export function issueKind(labels) {
  const names = labels.map((l) => (typeof l === 'string' ? l : l?.name)).map((n) => String(n ?? '').toLowerCase());
  if (names.includes('section-note')) return 'note';
  if (names.includes('suggested-edit')) return 'suggestion';
  // proposed-edit's fallback issue: an edit that couldn't apply, done by hand.
  if (names.includes('proposed-edit')) return 'edit';
  return null;
}

const labelled = (item, name) =>
  (item.labels ?? []).some((l) => String(typeof l === 'string' ? l : l?.name).toLowerCase() === name);

/**
 * Every accepted contribution, one per item, with who it is from:
 * { who: { name, github? }, kind, ref, url, date, pages }.
 *
 * `pulls`: closed pull requests (GitHub's shape: number, merged_at, closed_at, state,
 *   body, labels, html_url, head.sha). Merged ones labelled proposed-edit count, and
 *   closed ones labelled accepted-in-part (some of it accepted, the rest not).
 * `issues`: closed issues (number, state_reason, closed_at, body, labels, html_url).
 *   Closed as completed, of a kind issueKind knows, count.
 * `commits`: [{ sha, name, email, date, subject, body, proposer, pages }], newest
 *   first, merges left out. A commit counts only if the author site made it for a
 *   member (AUTHOR_SITE in its body, or a MEMBER_EMAIL author) or it carries a
 *   reader's Proposed-by name, and it touches the book's pages and isn't how a
 *   counted pull request landed (its head commit, or a squash ending "(#n)").
 *   A commit's `pages` are the pages whose text it changed: gen-contributors leaves
 *   out a page whose change was only to its frontmatter (credits, title, tags).
 * `automation`: isAutomation()'s test; whoever it matches is never credited.
 * `members`: the registry's book members, id -> name: a member's edits carry their
 *   member id and are shown under the name the member has now.
 * Items labelled platform-test (the platform's own tests) never count.
 */
export function contributions({ pulls = [], issues = [], commits = [], repoUrl = '', automation = isAutomation(), members = new Map() }) {
  const out = [];
  const prNumbers = new Set();
  const prHeads = new Set();
  for (const pr of pulls) {
    // Accepted in part (the author site's Review all in chapter): closed unmerged, but
    // some of it went into the drafts, so the reader is credited as for a merge.
    const part = !pr.merged_at && pr.state === 'closed' && labelled(pr, 'accepted-in-part');
    if ((!pr.merged_at && !part) || !labelled(pr, 'proposed-edit') || labelled(pr, 'no-credit') || labelled(pr, 'platform-test')) continue;
    const who = personFrom(attributionOf(pr.body));
    prNumbers.add(pr.number);
    if (pr.head?.sha) prHeads.add(pr.head.sha);
    if (!who) continue;
    out.push({ who, kind: 'edit', ref: `#${pr.number}`, url: pr.html_url, date: day(pr.merged_at ?? pr.closed_at), pages: filesOf(pr.body) });
  }
  for (const issue of issues) {
    if (issue.pull_request || issue.state_reason !== 'completed' || labelled(issue, 'no-credit') || labelled(issue, 'platform-test')) continue;
    const kind = issueKind(issue.labels ?? []);
    const who = kind && personFrom(attributionOf(issue.body));
    if (!who) continue;
    out.push({ who, kind, ref: `#${issue.number}`, url: issue.html_url, date: day(issue.closed_at), pages: filesOf(issue.body) });
  }
  for (const c of commits) {
    if (prHeads.has(c.sha)) continue;
    const squashed = /\(#(\d+)\)\s*$/.exec(c.subject ?? '');
    if (squashed && prNumbers.has(Number(squashed[1]))) continue;
    // Work on the repository (workflows, settings) isn't work on the book's pages.
    if (!c.pages?.length) continue;
    const viaSite = AUTHOR_SITE.exec(c.body ?? '')?.[1];
    const fromEmail = MEMBER_EMAIL.exec(c.email ?? '')?.[1];
    const memberId = fromEmail ? `m-${fromEmail}` : MEMBER_LINE.exec(c.body ?? '')?.[1];
    let who;
    if (c.proposer) who = { name: c.proposer };
    else if (viaSite) who = { name: c.name || viaSite, github: viaSite, email: c.email };
    else if (memberId) who = { name: members.get(memberId) || c.name, member: memberId, email: c.email };
    else continue; // raw git authorship never earns credit
    const noreplyLogin = NOREPLY.exec(c.email ?? '')?.[1];
    if (noreplyLogin && !who.github) who.github = noreplyLogin;
    out.push({
      who,
      kind: 'commit',
      ref: c.sha.slice(0, 7),
      url: repoUrl ? `${repoUrl}/commit/${c.sha}` : '',
      date: day(c.date),
      pages: c.pages ?? [],
    });
  }
  // Belt and braces, on every source: no machine, AI tool or platform account.
  return out.filter((c) => !automation(c.who)).map(({ who: { email: _email, ...who }, ...c }) => ({ who, ...c }));
}

const personFrom = (a) => (a?.login ? { name: a.login, github: a.login } : a?.name ? { name: a.name } : null);

/** credit-overrides.yml, normalised: { hide: [], rename: { from: to }, merge: [[...]], noCredit: Set }. */
export function normaliseOverrides(raw = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const rename = o.rename && typeof o.rename === 'object' && !Array.isArray(o.rename) ? o.rename : {};
  return {
    hide: list(o.hide).map(String),
    rename: Object.fromEntries(Object.entries(rename).map(([k, v]) => [String(k), String(v)])),
    merge: (Array.isArray(o.merge) ? o.merge : []).filter(Array.isArray).map((g) => g.map(String)),
    // "#12" or 12 is an issue or pull request; seven or more hex digits, a commit.
    noCredit: new Set(list(o['no-credit'] ?? o.noCredit).map((r) => String(r).trim().replace(/^(?=\d{1,6}$)/, '#').toLowerCase())),
  };
}

const refKey = (ref) => String(ref).toLowerCase();
const noCredited = (noCredit, c) =>
  noCredit.has(refKey(c.ref)) || [...noCredit].some((n) => /^[0-9a-f]{7,40}$/.test(n) && c.kind === 'commit' && n.startsWith(refKey(c.ref)));

/**
 * The ledger: contributions folded per person, overrides applied, listed authors
 * and editors left out. `listed` are the book's authors and editors (peopleOf).
 * -> { version, contributors: [{ name, github?, counts, contributions }] }
 */
export function buildLedger({ contributions: items, overrides = {}, listed = [] }) {
  const o = overrides.noCredit instanceof Set ? overrides : normaliseOverrides(overrides);
  const groups = [];
  // One person, one row: the same GitHub login, member id (the author site's), or
  // display name (normalised) is the same person. A name a reader typed that shares
  // none of these with anyone ("alec" and "Alec Gordon") is told apart: the
  // overrides file's merge: joins them.
  const find = (who) =>
    groups.find((g) =>
      (who.github && g.github && g.github.toLowerCase() === who.github.toLowerCase()) ||
      (who.member && g.members.has(who.member)) ||
      g.names.has(nameKey(who.name)) ||
      (who.github && g.names.has(who.github.toLowerCase())) ||
      (g.github && g.github.toLowerCase() === nameKey(who.name)));
  for (const c of items) {
    if (noCredited(o.noCredit, c)) continue;
    let g = find(c.who);
    if (!g) {
      g = { name: c.who.name, github: c.who.github ?? null, names: new Set(), members: new Set(), items: [] };
      groups.push(g);
    }
    g.names.add(nameKey(c.who.name));
    if (c.who.member) {
      // A member is shown by the name the registry has for them now.
      if (!g.members.size) g.name = c.who.name;
      g.members.add(c.who.member);
    }
    if (c.who.github) {
      g.github ??= c.who.github;
      g.names.add(c.who.github.toLowerCase());
      // A signed-in person is shown by their login unless a commit gave a fuller name.
      if (g.name.toLowerCase() === c.who.github.toLowerCase() && c.who.name.toLowerCase() !== c.who.github.toLowerCase()) g.name = c.who.name;
    } else if (g.github && g.name.toLowerCase() === g.github.toLowerCase()) g.name = c.who.name;
    g.items.push(c);
  }
  // An item read later can link two rows made earlier (a typed name, then a commit by
  // the login that carries it): join them until nothing more links.
  const linked = (a, b) =>
    (a.github && b.github && a.github.toLowerCase() === b.github.toLowerCase()) ||
    [...a.members].some((id) => b.members.has(id)) ||
    [...a.names].some((n) => b.names.has(n));
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!linked(groups[i], groups[j])) continue;
      const [a, b] = [groups[i], groups.splice(j, 1)[0]];
      a.items.push(...b.items);
      for (const n of b.names) a.names.add(n);
      // Shown as the member, else the fuller name rather than a bare login.
      if (b.members.size && !a.members.size) a.name = b.name;
      else if (!a.members.size && a.github && a.name.toLowerCase() === a.github.toLowerCase()) a.name = b.name;
      for (const id of b.members) a.members.add(id);
      a.github ??= b.github;
      j = i; // a grew: look again from the start
    }
  }
  // merge: the groups named in one entry are one person, shown as the first.
  for (const set of o.merge) {
    const members = groups.filter((g) => set.some((w) => matches({ name: g.name, github: g.github ?? undefined }, w) || g.names.has(nameKey(w.replace(/^@/, '')))));
    // One group alone still takes the entry's name: its other names may have no credit left.
    if (!members.length) continue;
    const [first, ...rest] = members;
    for (const m of rest) {
      first.items.push(...m.items);
      for (const n of m.names) first.names.add(n);
      for (const id of m.members) first.members.add(id);
      first.github ??= m.github;
      groups.splice(groups.indexOf(m), 1);
    }
    const lead = set[0];
    if (!lead.startsWith('@')) first.name = lead;
  }
  const people = groups
    .map((g) => {
      const person = { name: g.name, ...(g.github ? { github: g.github } : {}) };
      for (const [from, to] of Object.entries(o.rename)) if (matches(person, from) || g.names.has(nameKey(from.replace(/^@/, '')))) person.name = to;
      return { person, names: g.names, items: g.items };
    })
    .filter(({ person, names }) => !o.hide.some((h) => matches(person, h) || names.has(nameKey(h.replace(/^@/, '')))))
    .filter(({ person, names }) => !listed.some((l) => (l.github && (person.github?.toLowerCase() === l.github.toLowerCase() || names.has(l.github.toLowerCase()))) || names.has(nameKey(l.name)) || nameKey(person.name) === nameKey(l.name)))
    // A shared account named for listed people only ("Brandon Sommer and Caroline
    // Laschkolnig", both authors) is those people, already credited above.
    .filter(({ names }) => ![...names].some((n) => {
      const parts = n.split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean);
      return parts.length > 1 && parts.every((p) => listed.some((l) => nameKey(l.name) === p));
    }));
  return {
    version: LEDGER_VERSION,
    contributors: people
      .map(({ person, items: its }) => {
        const contribs = its
          .map(({ kind, ref, url, date, pages }) => ({ kind, ref, url, date, pages: [...new Set(pages)].sort() }))
          .sort(byRef);
        // One item twice (two sources, say): once.
        const seen = new Set();
        const unique = contribs.filter((c) => (seen.has(c.ref) ? false : seen.add(c.ref)));
        const counts = Object.fromEntries(KINDS.map((k) => [k, unique.filter((c) => c.kind === k).length]));
        return { ...person, counts, contributions: unique };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name) || String(a.github ?? '').localeCompare(String(b.github ?? ''))),
  };
}

function byRef(a, b) {
  const na = /^#(\d+)$/.exec(a.ref)?.[1];
  const nb = /^#(\d+)$/.exec(b.ref)?.[1];
  if (na && nb) return Number(na) - Number(nb);
  if (na) return -1;
  if (nb) return 1;
  return a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref);
}

/** The ledger as overrides changed since it was written leave it (the builder, at every build). */
export function applyOverrides(ledger, overrides, listed = []) {
  const items = (ledger?.contributors ?? []).flatMap((p) =>
    p.contributions.map((c) => ({ who: { name: p.name, ...(p.github ? { github: p.github } : {}) }, ...c })));
  return buildLedger({ contributions: items, overrides, listed });
}

/** A page's contributors, from the ledger: [{ name, github? }] by name. */
export const pageContributors = (ledger, relPath) =>
  (ledger?.contributors ?? [])
    .filter((p) => p.contributions.some((c) => c.pages.includes(relPath)))
    .map((p) => ({ name: p.name, ...(p.github ? { github: p.github } : {}) }));

/** The anchor a page's credits have on the contributors page: "page-chapters-chapter-03". */
export const pageAnchor = (file) =>
  `page-${String(file).replace(/\.md$/i, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
