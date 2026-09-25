#!/usr/bin/env node
// automation/scripts/gen-dashboard.mjs (quartz-book)
//
// Regenerates community/dashboard.md — one page of project health — from the
// Hypothes.is API and the GitHub API, and writes it back into the checkout.
//
// Run:  HYPOTHESIS_API_TOKEN=... node <quartz-book>/automation/scripts/gen-dashboard.mjs
// Env:   TEXTBOOK_REGISTRY=<url or path> to read a registry other than main's
// Flags:
//   --out <path>   write somewhere other than community/dashboard.md
//   --stdout       print the page instead of writing it
//   --check        write nothing; exit 1 if the file on disk is out of date
//
// Node 22, no dependencies. Uses global fetch.
//
// ---------------------------------------------------------------------------
// FIVE THINGS TO KNOW BEFORE CHANGING THIS FILE
//
//  1. NO NAMES, EVER, FROM THE ANNOTATION LAYER. This page reports aggregate
//     counts and nothing else: how many annotations, on how many pages, by how
//     many accounts. It never lists an annotator, never ranks them, and never
//     writes an annotation's text. A margin is a place people think out loud
//     in; turning it into a leaderboard changes what they are willing to say
//     there. The Set of userids in collectAnnotations() exists to be measured
//     with .size and must never be iterated into the page.
//
//  2. The output must be a pure function of what the APIs return. The weekly
//     workflow opens a pull request only when the regenerated page differs
//     byte-for-byte from the committed one, so anything that moves on its own
//     — a `new Date()` stamp, an unsorted list — turns a quiet job into a pull
//     request every Sunday for the rest of time. Hence note 3.
//
//  3. THE PAGE'S DATE IS THE NEWEST THING IT COUNTS, AND ONLY THINGS IT
//     COUNTS. This is subtler here than on the derivatives page, because this
//     page reports on the very repository it is committed to, and several
//     obvious timestamps feed back into themselves:
//       * repo.pushed_at moves when THIS JOB pushes chore/dashboard-update.
//       * the newest commit on main becomes this page's own merge commit.
//       * an issue's updated_at moves when someone comments, which changes no
//         number on this page.
//       * an annotation's `updated` moves when its author edits it, which
//         changes no number on this page.
//     Every one of those would date the page forward with nothing to show for
//     it, and produce a pull request every Sunday whose only diff is the date.
//     So the stamp is the maximum over exactly four timestamps, each chosen
//     because it moves if and only if a number on this page moves:
//       * the newest NON-BOT commit (bot commits are excluded from the counts
//         too, exactly as gen-contributors.mjs does, so merging this page's
//         own pull request cannot move the date)
//       * the newest annotation's `created` (not `updated` — see above)
//       * the newest edition fork's `created_at` (a new fork changes the count)
//       * the newest counted issue or pull request's `created_at`
//     A number can still change without the date moving — an issue being
//     closed, say. That direction is harmless: the page differs, a pull
//     request opens, and it contains a real change.
//
//  4. Never write a page from a failed or partial fetch. A rate-limited or
//     unauthenticated run that "found no annotations" would publish a
//     confident, plausible-looking zero, and Brandon would read it as the book
//     being ignored rather than as the job being broken. Every API failure
//     throws before anything is written. Two silent-zero traps in particular:
//       * Hypothes.is returns HTTP 200 with {"total": 0, "rows": []} for a bad
//         token rather than 401, so /api/profile is checked first (this is the
//         same pre-flight backup-annotations.mjs does, and for the same
//         reason).
//       * A group the token's account is not a member of also returns 200 and
//         zero rows. That is checked against profile.groups and throws.
//     The same goes for the registry this page is configured from (below): if
//     it cannot be fetched, or this book or any value the page needs cannot be
//     resolved from it, the script exits 1 before any API is queried.
//
//  5. Readership is a LINK, not a number. The Plausible Stats API needs a paid
//     plan and a second expiring secret; the site's dashboard is already
//     public, so the page points at it. The link is derived from the registry's
//     analytics.plausible (https://plausible.io/<site> when dashboard_public is
//     true), never stored. If the book has no Plausible site, or its dashboard
//     is not public, the page says so in as many words rather than quietly
//     dropping the section — an empty spot on a health dashboard is
//     indistinguishable from a healthy one.
//
// Every per-book value — the repo, the site, the annotation groups, the
// edition template and the fork owners to skip, the title, the analytics — is
// read from this book's entry in the platform registry, fetched at the start
// of each run (lib/registry.mjs). textbook.config.json supplies only
// the slug.
//
// The annotation queries mirror backup-annotations.mjs, which is the
// source of truth for how this API behaves (its header documents the limits
// that were verified against the live API). What is NOT mirrored is that
// script's per-URI fallback: a backup would rather over-collect than miss
// anything, whereas this page would rather fail loudly than publish a number
// it is not sure of.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadBook, field, isString, isStringArray, exitOnRegistryError, RegistryError } from './lib/registry.mjs';

// The book's clone (the working directory, or BOOK_ROOT). These scripts live in
// the platform repo, quartz-book, and run from its reusable workflows.
const REPO_ROOT = path.resolve(process.env.BOOK_ROOT || '.');

// --- Configuration ---------------------------------------------------------

// Per-book values are read from the registry in readBook(), below.

// The label the "Suggest an edit" route puts on an issue. This is the Tier-1
// pipeline: everything a reader files without a GitHub account arrives here.
// A platform convention (DESIGN §0c), so not a registry field.
const SUGGESTED_EDIT_LABEL = 'suggested-edit';

const HYPOTHESIS_API = 'https://api.hypothes.is/api';
const PUBLIC_GROUP = '__world__'; // Hypothes.is' id for the public layer
const PAGE_SIZE = 200;            // API maximum, verified — see backup-annotations.mjs
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;           // per request, for 429 / 5xx / network blips

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// --- Small helpers ---------------------------------------------------------

const warn = (...a) => console.warn('WARNING:', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { out: path.join(REPO_ROOT, 'community', 'dashboard.md'), stdout: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

/** "2026-07-24T12:18:59Z" -> "24 July 2026". */
function longDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c" — an Oxford-comma-free English list, as gen-contributors uses. */
function joinList(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Later of two ISO timestamps, either of which may be null. */
const laterOf = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

/** Whole days between two ISO timestamps, floored. */
function daysBetween(fromIso, toIso) {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/** Automation rather than a person — the same test gen-contributors.mjs uses:
 *  a `[bot]` suffix, or one of the registry's platform.automation_logins. */
const isBotName = (name = '', automationLogins) =>
  /\[bot\]$/i.test(name.trim()) || automationLogins.has(name.trim().toLowerCase());

// --- Hypothes.is -----------------------------------------------------------

/** GET against the Hypothes.is API, retrying 429 / 5xx / network errors. */
async function hypothesisGet(token, endpoint, searchParams) {
  const url = new URL(HYPOTHESIS_API + endpoint);
  if (searchParams) url.search = new URLSearchParams(searchParams).toString();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'gen-dashboard (textbook)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Hypothes.is ${endpoint}: ${err.message}`);
      const waitMs = 1000 * 2 ** (attempt - 1);
      warn(`Hypothes.is ${endpoint} -> ${err.message}; retrying in ${waitMs}ms (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      continue;
    }

    if (res.ok) return res.json();

    const body = (await res.text().catch(() => '')).slice(0, 300);
    const failure = new Error(`Hypothes.is ${endpoint}: HTTP ${res.status} ${body}`);
    if (!(res.status === 429 || res.status >= 500) || attempt === MAX_ATTEMPTS) throw failure;

    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
    warn(`Hypothes.is ${endpoint} -> HTTP ${res.status}; retrying in ${waitMs}ms (${attempt}/${MAX_ATTEMPTS})`);
    await sleep(waitMs);
  }
  throw new Error(`Hypothes.is ${endpoint}: exhausted ${MAX_ATTEMPTS} attempts`);
}

/**
 * Page through /api/search, folding each row into `tally` and keeping none.
 *
 * Rows are counted, not collected: this page needs totals, and annotation
 * bodies have no business being held in a process that writes a public file.
 *
 * Paging is search_after over sort=updated, which is the combination verified
 * against the live API in backup-annotations.mjs (offset is capped at 9800 and
 * cannot page a real corpus).
 */
async function searchTally(token, baseParams, tally) {
  let cursor = null;
  let counted = 0;

  for (;;) {
    const params = { ...baseParams, limit: String(PAGE_SIZE), sort: 'updated', order: 'asc' };
    if (cursor !== null) params.search_after = cursor;

    const body = await hypothesisGet(token, '/search', params);
    const rows = Array.isArray(body.rows) ? body.rows : [];

    for (const row of rows) {
      if (typeof row?.id === 'string') {
        if (tally.ids.has(row.id)) continue; // dedupe across merged queries
        tally.ids.add(row.id);
      }
      counted++;
      tally.total++;
      if (Array.isArray(row?.references) && row.references.length > 0) tally.replies++;
      if (row?.uri) tally.uris.add(String(row.uri).split(/[?#]/)[0]);
      if (row?.user) tally.users.add(row.user); // counted only — never printed, see note 1
      if (row?.created) {
        tally.newestCreated = laterOf(tally.newestCreated, row.created);
        tally.oldestCreated = !tally.oldestCreated || row.created < tally.oldestCreated
          ? row.created : tally.oldestCreated;
      }
    }

    if (rows.length < PAGE_SIZE) break; // short page == last page

    const next = rows[rows.length - 1]?.updated;
    // Either of these means the cursor cannot advance and the scope would be
    // silently truncated. A partial count is a wrong count — see note 4.
    if (!next) throw new Error('Hypothes.is paging stopped: last row had no "updated" field to page on.');
    if (next === cursor) throw new Error(`Hypothes.is paging stalled at cursor "${cursor}"; the count would be incomplete.`);
    cursor = next;
  }

  return counted;
}

const emptyTally = () => ({
  total: 0, replies: 0, ids: new Set(), uris: new Set(), users: new Set(),
  newestCreated: null, oldestCreated: null,
});

async function collectAnnotations(site, annotationGroups) {
  const token = (process.env.HYPOTHESIS_API_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      'HYPOTHESIS_API_TOKEN is not set. Without it the private course groups come\n' +
      'back empty and this page would report a margin quieter than it is.\n' +
      '  Locally:  export HYPOTHESIS_API_TOKEN=<token from https://hypothes.is/account/developer>\n' +
      '  In CI:    the repository secret HYPOTHESIS_API_TOKEN (already used by backup-annotations.yml)',
    );
  }

  // A rejected token does not 401 — searches just come back empty with HTTP
  // 200. profile.userid is the only reliable liveness signal. See note 4.
  const profile = await hypothesisGet(token, '/profile');
  if (!profile.userid) {
    throw new Error(
      'The Hypothes.is API rejected HYPOTHESIS_API_TOKEN (/api/profile returned userid: null).\n' +
      'Searches with this token return zero rows and HTTP 200, so this page would have\n' +
      'reported an empty margin as if it were true. Mint a fresh token at\n' +
      'https://hypothes.is/account/developer and update the repository secret.',
    );
  }

  // Same trap one level down: a group the account has left returns 200 and no
  // rows. Refuse rather than publish a zero we cannot see behind.
  const memberOf = new Set((profile.groups ?? []).map((g) => g.id));
  for (const group of annotationGroups) {
    if (!memberOf.has(group.id)) {
      throw new Error(
        `${profile.userid} is not a member of group ${group.id} (${group.label}), so that group\n` +
        'returns zero annotations rather than an error. Rejoin the group, or remove it from\n' +
        'annotations.hypothesis_groups in this book\'s registry entry.',
      );
    }
  }

  const overall = emptyTally();

  // Public layer. wildcard_uri covers every path under the origin; the bare
  // origin is queried separately because "/*" does not match it, and the two
  // are deduped by id. group=__world__ is pinned so an authenticated run
  // cannot fold the token owner's private groups into what we call "public".
  const publicTally = emptyTally();
  publicTally.ids = overall.ids; // one id namespace across every scope
  publicTally.uris = overall.uris;
  publicTally.users = overall.users;
  await searchTally(token, { wildcard_uri: `${site}/*`, group: PUBLIC_GROUP }, publicTally);
  await searchTally(token, { uri: site, group: PUBLIC_GROUP }, publicTally);
  overall.total += publicTally.total;
  overall.replies += publicTally.replies;
  overall.newestCreated = laterOf(overall.newestCreated, publicTally.newestCreated);
  overall.oldestCreated = !overall.oldestCreated || (publicTally.oldestCreated && publicTally.oldestCreated < overall.oldestCreated)
    ? (publicTally.oldestCreated ?? overall.oldestCreated) : overall.oldestCreated;

  const groups = [];
  for (const group of annotationGroups) {
    const tally = emptyTally();
    tally.ids = overall.ids;
    tally.uris = overall.uris;
    tally.users = overall.users;
    await searchTally(token, { group: group.id }, tally);
    groups.push({ ...group, count: tally.total, replies: tally.replies });
    overall.total += tally.total;
    overall.replies += tally.replies;
    overall.newestCreated = laterOf(overall.newestCreated, tally.newestCreated);
    overall.oldestCreated = !overall.oldestCreated || (tally.oldestCreated && tally.oldestCreated < overall.oldestCreated)
      ? (tally.oldestCreated ?? overall.oldestCreated) : overall.oldestCreated;
  }

  return {
    total: overall.total,
    replies: overall.replies,
    pages: overall.uris.size,
    participants: overall.users.size, // a count. Never a list. See note 1.
    newestCreated: overall.newestCreated,
    oldestCreated: overall.oldestCreated,
    publicCount: publicTally.total,
    groups,
  };
}

// --- GitHub ----------------------------------------------------------------

const githubHeaders = () => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'gen-dashboard (textbook)',
  'x-github-api-version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
});

async function githubGet(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const hint = res.status === 403 && remaining === '0'
      ? ' — rate limited; set GITHUB_TOKEN and retry'
      : '';
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}${hint}`);
  }
  return { body: await res.json(), link: res.headers.get('link') ?? '' };
}

/** Every page of a list endpoint, following the Link: rel="next" cursor. */
async function githubList(url) {
  const items = [];
  let next = url;
  while (next) {
    const { body, link } = await githubGet(next);
    items.push(...(Array.isArray(body) ? body : []));
    next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
  }
  return items;
}

/** True for an issue carrying the suggest-edit route's label. */
const isSuggestion = (i) => (i.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === SUGGESTED_EDIT_LABEL);

async function collectGitHub({ repo, templateRepo, skipForkOwners, automationLogins, suggestionsCountedFrom }) {
  const isBot = (name) => isBotName(name, automationLogins);

  // Contributors, with their commit counts. Bots are dropped for the same
  // reason gen-contributors.mjs drops them: github-actions[bot] commits are
  // this page and its siblings landing on main, not work on the book.
  const contributors = (await githubList(
    `https://api.github.com/repos/${repo}/contributors?per_page=100&anon=0`,
  )).filter((c) => c.type !== 'Bot' && !isBot(c.login ?? ''));

  // The newest commit by a person, for the date stamp — see note 3. One page of
  // 100 is plenty; if a run of automation ever fills it, the stamp simply falls
  // back to the other three sources rather than reporting a bot's date.
  const recentCommits = (await githubGet(
    `https://api.github.com/repos/${repo}/commits?per_page=100`,
  )).body;
  const newestHumanCommit = (Array.isArray(recentCommits) ? recentCommits : [])
    .filter((c) => !isBot(c.author?.login ?? '') && !isBot(c.commit?.author?.name ?? ''))
    .map((c) => c.commit?.author?.date ?? c.commit?.committer?.date)
    .filter(Boolean)
    .reduce((acc, d) => laterOf(acc, d), null);

  // Department editions: forks of the TEMPLATE, filtered exactly as
  // gen-derivatives.mjs filters them so the two pages cannot disagree. A book
  // whose registry entry has `editions: null` has no template, so nothing to
  // count; that is recorded as null, not as a zero, and the page says nothing.
  const editions = templateRepo === null ? [] : (await githubList(
    `https://api.github.com/repos/${templateRepo}/forks?per_page=100&sort=oldest`,
  )).filter((f) => !f.archived && !f.disabled && !skipForkOwners.has(f.owner.login.toLowerCase()));

  // Open issues and pull requests. /issues returns both — a pull request is an
  // issue with a `pull_request` key — so one paged call answers both counts.
  // The machine's own housekeeping branches are excluded: chore/dashboard-update
  // is open while this very page waits to be merged, and counting it would make
  // the book look busier every Sunday morning than it is.
  //
  // Reader suggestions are the exception, and they are recognised by LABEL, not
  // by author. The suggest-edit route files them under whatever credential it
  // holds — a machine user once, now a GitHub App that shows as <app>[bot] — so
  // an author test would drop them or keep them depending on which credential
  // was live. The label is the route's own contract and survives both.
  //
  // Suggestions filed before the registry's suggest_edit.counted_from were tests
  // of the route, filed under the same credentials real ones use, so a date is
  // the only thing that tells them apart. They are left out of every count, and
  // out of the date stamp; the page says how many there were.
  const isCounted = (i) => !suggestionsCountedFrom || (i.created_at ?? '') >= suggestionsCountedFrom;
  const openItems = await githubList(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
  );
  const openCounted = openItems.filter((i) => (!i.pull_request && isSuggestion(i) ? isCounted(i) : !isBot(i.user?.login ?? '')));
  const openIssues = openCounted.filter((i) => !i.pull_request);
  const openPulls = openCounted.filter((i) => i.pull_request);

  // The Tier-1 pipeline: everything filed through the "Suggest an edit" link.
  // state=all so the page can say how many have been dealt with, not just how
  // many are waiting. Selected by label alone, whoever filed them — see above.
  const allSuggestions = (await githubList(
    `https://api.github.com/repos/${repo}/issues?state=all&labels=${encodeURIComponent(SUGGESTED_EDIT_LABEL)}&per_page=100`,
  )).filter((i) => !i.pull_request);
  const suggestions = allSuggestions.filter(isCounted);
  const suggestionsOpen = suggestions.filter((i) => i.state === 'open');
  const suggestionsClosed = suggestions.filter((i) => i.state === 'closed');

  const newestCreated = [...openCounted, ...suggestions, ...editions]
    .map((i) => i.created_at)
    .filter(Boolean)
    .reduce((acc, d) => laterOf(acc, d), null);

  return {
    contributors: contributors.length,
    newestHumanCommit,
    editions: templateRepo === null ? null : editions.length,
    openIssues: openIssues.length,
    openPulls: openPulls.length,
    suggestions: {
      countedFrom: suggestionsCountedFrom,
      beforeCutoff: allSuggestions.length - suggestions.length,
      open: suggestionsOpen.length,
      closed: suggestionsClosed.length,
      unanswered: suggestionsOpen.filter((i) => (i.comments ?? 0) === 0).length,
      oldestOpen: suggestionsOpen
        .map((i) => i.created_at)
        .filter(Boolean)
        .reduce((acc, d) => (!acc || d < acc ? d : acc), null),
    },
    newestCreated,
  };
}

// --- Rendering -------------------------------------------------------------

function renderIntro(book) {
  return [
    '# Project health',
    '',
    `This page is *${book.title}* in numbers: how many people are reading it, how much conversation is happening in its margins, and how much of it is being written or corrected. It exists so that none of that has to be guessed at, or asked for, or assembled by hand.`,
    '',
    'It rebuilds itself every Sunday from the systems that already hold the data — Hypothes.is for the annotations, GitHub for the repository — and proposes the new version as a pull request. A week in which nothing moved produces no pull request at all, so this page changing is itself a signal.',
    '',
    'Nothing on this page names a reader. The margin is a place where people think out loud, and it stays usable because nobody is being scored in it, so the annotation figures below are totals — how many notes, on how many pages, from how many accounts — and never a list of who wrote them.',
    '',
  ];
}

function renderReadership(book) {
  const out = ['## Readership', ''];

  if (!book.plausibleUrl) {
    out.push(
      book.plausibleSite
        ? `The site's visitor numbers are recorded by Plausible, under ${book.plausibleSite}, but that dashboard is not public, so there is nothing here to link to. **Visitor numbers are not visible from this page.**`
        : '**No analytics are configured for this book**, so there are no visitor numbers to link to.',
      '',
      'Readership is linked from here once the book\'s entry in the platform registry has a Plausible site with `dashboard_public` set to `true`; this section picks it up at the next rebuild.',
      '',
      'It is deliberate that the numbers themselves are not copied onto this page: reading them from Plausible directly would need a paid plan and a second password to keep alive, and the dashboard already says it better than a summary would.',
    );
    return out;
  }

  out.push(
    `Visitor numbers are not repeated here — they live in the site's own analytics dashboard, which is public. Anyone can open it, with no login and no account: **[the readership dashboard for ${book.domain}](${book.plausibleUrl})**.`,
    '',
    'It shows how many people have visited the book, which pages they spent time on, and where they arrived from, over whatever period you select. It counts visits rather than identities — no cookies, nothing that follows a reader from one site to another — which is why it is a fair measure of interest and a poor one of anything else.',
  );
  return out;
}

function renderDiscussion(a, book) {
  const site = book.domain;
  const out = ['## Discussion in the margins', ''];

  out.push(
    'Every page of the book can be annotated: a reader selects a passage, writes a note, and the note stays attached to that exact sentence for everyone who comes after. Those notes are held by Hypothes.is rather than in the book\'s own files, which is why they are counted here rather than being visible in the repository.',
    '',
  );

  if (a.total === 0) {
    // No course groups is the normal state — per-cohort margins were decided
    // against — so nothing is said about them. A group that IS in the registry
    // was put there on purpose, so its emptiness is stated as a plain fact, with
    // no guess at why.
    const groupsNote = a.groups.length === 0
      ? ''
      : a.groups.length === 1
        ? ` The course group registered for this book, ${a.groups[0].label}, is empty too.`
        : ` The course groups registered for this book — ${joinList(a.groups.map((g) => g.label))} — are empty too.`;
    out.push(
      `There are no annotations yet in the public layer at ${site}, which is where the book's discussion currently lives. That is the ordinary reading for a book that has not yet been set as coursework: a margin fills during a teaching term, not before one, and the first cohort pointed at the book is what will change this number.${groupsNote}`,
    );
    return out;
  }

  const groupsWithAny = a.groups.filter((g) => g.count > 0);

  const publicClause = a.publicCount === a.total
    ? `All of them are in the public layer at ${site}, where anyone can read them without an account.`
    : a.publicCount === 0
      ? `None of them are in the public layer at ${site}; every one is in a course group.`
      : `${a.publicCount} of them are in the public layer at ${site}, where anyone can read them without an account.`;

  const groupsNamed = a.groups.length === 1
    ? `The one course group, ${a.groups[0].label}, is empty`
    : `The course groups — ${joinList(a.groups.map((g) => g.label))} — are empty`;

  const groupClause = a.groups.length === 0
    ? '' // no course groups, so the public clause above is the whole story
    : groupsWithAny.length > 0
    ? `${joinList(groupsWithAny.map((g) => `${plural(g.count, 'annotation')} in ${g.label}`))} ${groupsWithAny.length === 1 && groupsWithAny[0].count === 1 ? 'sits' : 'sit'} in the course groups, which are private to their cohorts and readable only by their members.`
    : `${groupsNamed}.`;

  out.push(
    `There ${a.total === 1 ? 'is' : 'are'} **${plural(a.total, 'annotation')}** in total. ${[publicClause, groupClause].filter(Boolean).join(' ')}`,
    '',
  );

  const spread = a.pages === 1
    ? 'They all sit on a single page'
    : `They are spread across ${plural(a.pages, 'page')} of the book`;

  const who = a.participants === 1
    ? 'and all come from a single account'
    : `and come from ${plural(a.participants, 'account')}`;

  const conversation = a.replies === 0
    ? 'None of them are replies, so what exists is a set of notes rather than a conversation — the margin has been written in but not yet talked in.'
    // Spelled out rather than a digit: this one starts its sentence.
    : `${a.replies === 1 ? 'One of them is a reply' : `${a.replies} of them are replies`} to somebody else's note, which is the part that matters: a margin that only accumulates notes is a comment box, and a margin that accumulates replies is a seminar.`;

  out.push(
    `${spread}, ${who}. ${conversation}`,
    '',
  );

  if (a.oldestCreated && a.newestCreated) {
    const span = a.oldestCreated.slice(0, 10) === a.newestCreated.slice(0, 10)
      ? `All of it arrived on ${longDate(a.newestCreated)}.`
      : `The first arrived on ${longDate(a.oldestCreated)} and the most recent on ${longDate(a.newestCreated)}.`;
    out.push(span, '');
  }

  if (a.total < 25) {
    out.push('These are small numbers and, at this stage, unalarming ones. What is worth watching is not the total but its shape during a term: annotations arriving in the weeks a chapter is being taught, and replies arriving after them.');
  }

  return out;
}

function renderContribution(g, book) {
  const out = ['## Contribution', ''];

  out.push(
    'The book is a public Git repository, so every change to it — a rewritten section, a corrected apostrophe, a workflow like the one that builds this page — is a recorded commit by a named author. That makes the writing of the book countable in a way a document circulated by email is not.',
    '',
  );

  const people = g.contributors === 0
    ? 'No authorship has been recorded against a person yet.'
    : g.contributors === 1
      ? `**One person** has written the book so far. That is what an early book looks like — it is written before it is contributed to — and the [[contributors|contributors page]], which is the standing record of who has changed what, is where a second name would appear.`
      : `**${plural(g.contributors, 'person', 'people')}** have written the book between them. Who they are, what each has changed and when they last did it is on the [[contributors|contributors page]] — that page, not this one, is the record of authorship.`;

  // null: this book has no department editions at all, and no derivatives page to link.
  const editions = g.editions === null
    ? null
    : g.editions === 0
      ? 'No department has published its own edition yet. The template and the walkthrough exist and are waiting for the first one; see [[derivatives|department editions]].'
      : g.editions === 1
        ? 'One department is running its own edition of the book — the same chapters with its own margin. It is listed on the [[derivatives|department editions page]].'
        : `**${plural(g.editions, 'department')}** are running their own editions of the book — the same chapters with their own margins — and are listed on the [[derivatives|department editions page]].`;

  out.push(people, '');
  if (editions) out.push(editions, '');

  const openWork = g.openIssues === 0 && g.openPulls === 0
    ? 'Nothing is currently open against the repository: no issues waiting, no proposed changes unreviewed. On a project this size that means the queue is clear rather than that nobody is looking.'
    : `${joinList([
        g.openIssues > 0 ? `**${plural(g.openIssues, 'open issue')}**` : null,
        g.openPulls > 0 ? `**${plural(g.openPulls, 'open pull request')}**` : null,
      ].filter(Boolean))} ${g.openIssues + g.openPulls === 1 ? 'is' : 'are'} waiting on the repository. Pull requests opened by the project's own automation — the weekly rebuilds of this page and its siblings — are left out of that count; they are housekeeping, not contributions.`;

  out.push(openWork, '');
  out.push(...renderSuggestions(g.suggestions, g.openIssues, book));
  return out;
}

function renderSuggestions(s, openIssues, book) {
  const out = ['### Suggested edits', ''];

  out.push(
    'Every page of the book carries a **Suggest an edit** link. It needs no GitHub account and no knowledge of Git: a reader describes what is wrong and what it should say, and the suggestion is filed as an issue labelled `suggested-edit`. It is the lightest route into the book, and the one most readers will ever use, so it is worth watching on its own.',
    '',
  );

  const total = s.open + s.closed;

  // Said whenever something was left out, so a reader comparing this page with
  // the repository's issue list is not left to find the difference alone.
  const cutoffNote = s.countedFrom && s.beforeCutoff > 0
    ? ` The count starts on ${longDate(s.countedFrom)}: the ${plural(s.beforeCutoff, 'suggestion')} filed before then ${s.beforeCutoff === 1 ? 'was a test' : 'were tests'} of the route itself, made while it was being set up, and ${s.beforeCutoff === 1 ? 'is' : 'are'} not counted here.`
    : '';

  if (total === 0) {
    out.push(
      `No suggestions have come in from readers yet.${cutoffNote} The route is live, but a reader only uses it once they have read enough to disagree with something — so this figure moving is a better sign of the book being *read* than any visitor count is.`,
    );
    return out;
  }

  const waiting = s.open === 0
    ? 'None are waiting now: every one filed so far has been dealt with.'
    : s.open === total
      ? `${total === 1 ? 'It is' : 'All of them are'} still open and waiting for a decision${s.open === openIssues ? ', and between them they are every open issue on the repository' : ''}.`
      : `${s.open} of them ${s.open === 1 ? 'is' : 'are'} still open and waiting for a decision${s.open === openIssues ? ', and between them they are every open issue on the repository' : ''}.`;

  const unanswered = s.open === 0
    ? ''
    : s.unanswered === 0
      ? ' Each has had at least a reply.'
      : s.unanswered === s.open
        ? (s.open === 1 ? ' Nobody has replied to it yet.' : ' None of them has had a reply yet.')
        : ` ${plural(s.unanswered, 'of them has', 'of them have')} had no reply yet.`;

  // "0 days before the figures were taken" is a true sentence and a silly one.
  const age = s.oldestOpen && book.stampDate ? daysBetween(s.oldestOpen, book.stampDate) : null;
  const filedWhen = s.oldestOpen
    ? (s.open === 1
        ? ` It was filed on ${longDate(s.oldestOpen)}.`
        : ` The one that has been waiting longest was filed on ${longDate(s.oldestOpen)}${age !== null && age >= 2 ? `, ${plural(age, 'day')} before these figures were taken` : ''}.`)
    : '';
  const oldest = filedWhen;

  const handled = s.closed === 0 || s.open === 0
    ? ''
    : ` ${plural(s.closed, 'suggestion has', 'suggestions have')} been closed since — accepted into the text, folded into another change, or answered and declined.`;

  out.push(
    `${plural(total, 'suggestion has', 'suggestions have')} been filed. ${waiting}${unanswered}${handled}${oldest}${cutoffNote}`,
    '',
    'A suggestion left open is not lost, but it is unanswered, and an unanswered suggestion is the one thing on this page that costs the project something: it teaches a reader that the link does nothing.',
  );
  return out;
}

function renderPage({ annotations, github, book, stampDate }) {
  const out = [];
  out.push(...renderIntro(book));
  out.push(...renderReadership(book), '');
  out.push(...renderDiscussion(annotations, book), '');
  out.push(...renderContribution(github, { ...book, stampDate }), '');

  const covering = annotations.groups.length === 0
    ? 'the public layer for the site'
    : 'the public layer for the site and each course group';
  out.push('---', '');
  out.push(
    `Where these figures come from: annotation counts from the Hypothes.is API, covering ${covering}; everything else from the GitHub API. Visitor numbers are not read programmatically and are linked instead. If any of those calls fails, the rebuild stops and this page is left exactly as it was — it will never quietly report a zero that means "the job broke".`,
    '',
  );
  out.push(
    stampDate
      ? `*This page is rebuilt weekly, and is dated by the most recent thing it counts rather than by the day it ran: ${longDate(stampDate)}.*`
      : '*This page is rebuilt weekly. There is nothing counted here yet to date it by.*',
    '',
  );

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// --- Main ------------------------------------------------------------------

/**
 * Everything this page needs about the book, from its registry entry. Any value
 * missing or malformed exits 1 here, before a single API call (note 4).
 */
async function readBook() {
  try {
    const { book, registry, source } = await loadBook(REPO_ROOT);
    const plausible = field(book, 'analytics.plausible', (v) => v === null || (typeof v === 'object' && !Array.isArray(v)), 'an object or null');
    const plausibleSite = plausible && field(book, 'analytics.plausible.site', isString, 'a hostname');
    const plausiblePublic = plausible && field(book, 'analytics.plausible.dashboard_public', (v) => typeof v === 'boolean', 'true or false');
    const domain = field(book, 'site.domain', isString, 'a hostname');
    // null means the book has no department editions. Missing is still an error:
    // the registry always states it, and a typo must not read as "no editions".
    const editions = field(book, 'editions', (v) => v === null || (typeof v === 'object' && !Array.isArray(v)), 'an object or null');
    // The one field here that may be absent, and absent means null: count every
    // suggestion. Unlike a missing group list, that errs toward reporting too much,
    // never toward a quiet zero, and it lets this script land before the registry
    // adds the field. A value of the wrong shape is still an error.
    const countedFrom = field(book, 'suggest_edit.counted_from', (v) => v == null || (isString(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)), 'YYYY-MM-DD or null') ?? null;
    const automationLogins = registry.platform?.automation_logins;
    if (!isStringArray(automationLogins)) {
      throw new RegistryError(`the registry has no valid platform.automation_logins (expected a list of logins, got ${JSON.stringify(automationLogins)}).`);
    }
    return {
      slug: book.slug,
      source,
      title: field(book, 'title', isString, 'a string'),
      domain,
      site: `https://${domain}`,
      repo: book.content.repo,
      templateRepo: editions ? field(book, 'editions.template_repo', isString, 'owner/name') : null,
      skipForkOwners: new Set(editions ? field(book, 'editions.skip_fork_owners', isStringArray, 'a list of logins').map((o) => o.toLowerCase()) : []),
      annotationGroups: field(
        book, 'annotations.hypothesis_groups',
        (v) => Array.isArray(v) && v.every((g) => isString(g?.id) && isString(g?.label)),
        'a list of { id, label }',
      ),
      automationLogins: new Set(automationLogins.map((l) => l.toLowerCase())),
      suggestionsCountedFrom: countedFrom && `${countedFrom}T00:00:00Z`,
      plausibleSite: plausibleSite || null,
      // DESIGN §0b: derived from the site name, never stored.
      plausibleUrl: plausiblePublic ? `https://plausible.io/${plausibleSite}` : null,
    };
  } catch (err) {
    exitOnRegistryError(err);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: HYPOTHESIS_API_TOKEN=<token> node <quartz-book>/automation/scripts/gen-dashboard.mjs [--out <path>] [--stdout] [--check]');
    return 0;
  }

  const book = await readBook();
  console.log(`Book: ${book.slug} (registry: ${book.source})`);

  console.log(`Reading Hypothes.is (${book.site} + ${plural(book.annotationGroups.length, 'group')}) ...`);
  const annotations = await collectAnnotations(book.site, book.annotationGroups);
  console.log(`  ${annotations.total} annotation(s): ${[`${annotations.publicCount} public`, ...annotations.groups.map((g) => `${g.count} in ${g.label}`)].join(', ')}`);

  console.log(`Reading GitHub (${book.repo}${book.templateRepo ? `, forks of ${book.templateRepo}` : ', no edition template'}) ...`);
  const github = await collectGitHub(book);
  console.log(`  ${github.contributors} contributor(s), ${github.editions ?? 'no'} edition(s), ${github.openIssues} open issue(s), ${github.openPulls} open PR(s), ${github.suggestions.open + github.suggestions.closed} suggested edit(s)`);

  // The stamp: newest of exactly the four timestamps that move when a number
  // on this page moves. See note 3 — getting this wrong produces a pull
  // request every Sunday whose only diff is a date.
  const stampDate = [
    github.newestHumanCommit,
    annotations.newestCreated,
    github.newestCreated,
  ].filter(Boolean).reduce((acc, d) => laterOf(acc, d), null);

  const page = renderPage({ annotations, github, book, stampDate });

  if (opts.stdout) {
    process.stdout.write(page);
    return 0;
  }

  let current = null;
  try { current = await fs.readFile(opts.out, 'utf8'); } catch { /* not written yet */ }

  if (opts.check) {
    if (current === page) {
      console.log(`${path.relative(REPO_ROOT, opts.out)} is up to date.`);
      return 0;
    }
    console.error(`${path.relative(REPO_ROOT, opts.out)} is out of date — run: node <quartz-book>/automation/scripts/gen-dashboard.mjs`);
    return 1;
  }

  if (current === page) {
    console.log(`${path.relative(REPO_ROOT, opts.out)} unchanged.`);
    return 0;
  }

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, page);
  console.log(`wrote ${path.relative(REPO_ROOT, opts.out)}`);
  return 0;
}

process.exitCode = await main();
