#!/usr/bin/env node
// automation/scripts/gen-contributors.mjs (quartz-book)
//
// Regenerates a book's community/contributors.md from the book repository's own
// commit history and writes it back into the book's checkout. It runs from the
// platform's reusable workflow (.github/workflows/book-community-page.yml), with
// the book checked out as the working directory (or BOOK_ROOT).
//
// Everything on the page is derived from `git log` in the local clone, and the
// book's title, maintainer, licence and the platform's automation accounts from
// the registry (lib/registry.mjs). No GitHub API call is made: the API needs a token, rate-limits, and reports
// *account* activity (which counts merges and web-UI commits nobody wrote),
// whereas the commit history is the record of who actually put words in the
// book. It also means this runs identically on a laptop and in Actions.
//
// Run:  node <quartz-book>/automation/scripts/gen-contributors.mjs   (in the book's clone)
// Flags:
//   --out <path>   write somewhere other than community/contributors.md
//   --stdout       print the page instead of writing it
//   --check        write nothing; exit 1 if the file on disk is out of date
//
// Node 22, no dependencies.
//
// ---------------------------------------------------------------------------
// TWO THINGS TO KNOW BEFORE CHANGING THIS FILE
//
//  1. The output must be a pure function of the commit history. The weekly
//     workflow opens a pull request only when the regenerated page differs
//     byte-for-byte from the committed one, so anything that changes on its
//     own — a `new Date()` stamp, a HEAD sha, a Set iteration order — turns a
//     quiet job into a pull request every Sunday for the rest of time. That is
//     why the "last updated" date is the date of the most recent counted
//     commit and not today's date.
//
//  2. Identities come from %aN/%aE, which respect .mailmap. If one person ends
//     up listed twice (personal address on one commit, GitHub noreply on the
//     next), the fix is a .mailmap file in the repository root, not more
//     guessing in here. The one bit of guessing this file does do is merge
//     groups whose display name is identical.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadBook, field, isString, isStringArray, exitOnRegistryError, RegistryError } from './lib/registry.mjs';

// The book's clone. These scripts live in the platform repo, not in the book.
const REPO_ROOT = path.resolve(process.env.BOOK_ROOT || '.');

// --- Configuration ---------------------------------------------------------

// Only these paths count as "the book". Tooling, workflows, docs and the
// annotation backups are real work, but they are not pages, and a table of
// most-edited files that led with .github/workflows/ would tell a reader
// nothing about the textbook.
const CONTENT_DIR = 'chapters';

// Named identities that are automation rather than people. The `[bot]` suffix
// catches GitHub's own actors (github-actions[bot], dependabot[bot], any App);
// the registry's platform.automation_logins lists bots that commit under an
// ordinary-looking account (aldogobot, the account the suggest-edit function
// has acted as: its commits carry a human's suggestion, but the authorship is
// the bot's). Filled in by main() before any commit is read.
let automationLogins = new Set();

const MAX_PAGES_PER_CONTRIBUTOR = 3; // per row in the table
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// --- Small helpers ---------------------------------------------------------

const US = '\x1f'; // field separator inside a git --format line
const RS = '\x01'; // marks the start of a commit record in the numstat stream

function git(...args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const opts = { out: path.join(REPO_ROOT, 'community', 'contributors.md'), stdout: false, check: false };
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

const isBot = (name, email) =>
  /\[bot\]/i.test(name) || /\[bot\]/i.test(email) || automationLogins.has(name.toLowerCase());

/** "2026-08-17T14:58:11+02:00" -> "17 August 2026" (the author's own date). */
function longDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Same date, narrowed for table cells: "17 Aug 2026". */
function shortDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1].slice(0, 3)} ${y}`;
}

/** "a, b and c" — an Oxford-comma-free English list. */
function joinList(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `git log --numstat -M` renders a rename as a path, not two. Take the destination.
 *  Forms: "old => new" and "pre/{old => new}/post" (either side possibly empty). */
function resolveRenamePath(p) {
  if (!p.includes(' => ')) return p;
  const braced = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, '/');
  return p.slice(p.indexOf(' => ') + 4);
}

// --- Reading the history ---------------------------------------------------

/** Every non-merge commit, newest first.
 *
 *  --no-merges on purpose: a merge commit is a maintainer pressing a button,
 *  and counting it would credit the same work twice — once to whoever wrote it
 *  and once to whoever merged it. */
function readCommits() {
  const out = git('log', '--no-merges', `--format=%H${US}%aN${US}%aE${US}%aI`);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, name, email, date] = line.split(US);
    return { sha, name, email, date };
  });
}

/** sha -> [{ path, lines }] for files under CONTENT_DIR only. */
function readContentTouches() {
  const out = git('log', '--no-merges', '-M', '--numstat', `--format=${RS}%H`, '--', CONTENT_DIR);
  const touches = new Map();
  let sha = null;

  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith(RS)) { sha = line.slice(1); continue; }

    const [added, deleted, rawPath] = line.split('\t');
    if (rawPath === undefined || sha === null) continue;

    const file = resolveRenamePath(rawPath);
    if (!file.startsWith(`${CONTENT_DIR}/`) || !file.endsWith('.md')) continue;

    // "-\t-" is git's marker for a binary file; count it as a touch, no lines.
    const lines = (Number(added) || 0) + (Number(deleted) || 0);
    if (!touches.has(sha)) touches.set(sha, []);
    touches.get(sha).push({ path: file, lines });
  }
  return touches;
}

/** Content pages that still exist, mapped to their display title (the H1). */
async function readPageTitles() {
  const tracked = git('ls-files', '--', CONTENT_DIR).split('\n').filter((f) => f.endsWith('.md'));
  const titles = new Map();

  for (const file of tracked) {
    let heading = null;
    try {
      const text = await fs.readFile(path.join(REPO_ROOT, file), 'utf8');
      heading = text.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim() ?? null;
    } catch { /* tracked but not in the working tree — fall back to the filename */ }

    const base = path.basename(file, '.md');
    // The link target is the full path: two files sharing a name (a chapter and a
    // copy in another folder) must never send a link to the wrong one quietly.
    const target = file.replace(/\.md$/, '');
    // "Chapter 3: Reality and the Problem of Unobservables" is a title, not a
    // link label. Keep what comes before the first colon or dash so the table
    // stays readable; the full title is one click away.
    const label = (heading ?? base).split(/\s*[:—–]\s*/)[0].trim();
    titles.set(file, { target, label: label || base });
  }
  return titles;
}

// --- Aggregating people ----------------------------------------------------

function buildContributors(commits, touches) {
  const groups = new Map(); // lowercased email -> group

  for (const commit of commits) {
    if (isBot(commit.name, commit.email)) continue;

    const key = commit.email.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { emails: new Set(), names: new Map(), commits: 0, first: commit.date, last: commit.date, pages: new Map() };
      groups.set(key, group);
    }

    group.emails.add(key);
    group.names.set(commit.name, (group.names.get(commit.name) ?? 0) + 1);
    group.commits++;
    if (commit.date < group.first) group.first = commit.date;
    if (commit.date > group.last) group.last = commit.date;

    for (const touch of touches.get(commit.sha) ?? []) {
      const page = group.pages.get(touch.path) ?? { commits: 0, lines: 0 };
      page.commits++;
      page.lines += touch.lines;
      group.pages.set(touch.path, page);
    }
  }

  return mergeByName([...groups.values()]);
}

/** Fold together groups that share a display name — the same person committing
 *  from a laptop and from github.com. A .mailmap is the proper fix; this covers
 *  the common case before anyone thinks to write one. */
function mergeByName(groups) {
  const dominantName = (g) => [...g.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const byName = new Map();

  for (const group of groups.sort((a, b) => a.first.localeCompare(b.first))) {
    const key = dominantName(group).toLowerCase();
    const target = byName.get(key);
    if (!target) { byName.set(key, group); continue; }

    target.commits += group.commits;
    for (const e of group.emails) target.emails.add(e);
    for (const [n, c] of group.names) target.names.set(n, (target.names.get(n) ?? 0) + c);
    if (group.first < target.first) target.first = group.first;
    if (group.last > target.last) target.last = group.last;
    for (const [p, stat] of group.pages) {
      const page = target.pages.get(p) ?? { commits: 0, lines: 0 };
      page.commits += stat.commits;
      page.lines += stat.lines;
      target.pages.set(p, page);
    }
  }

  return [...byName.values()]
    .map((g) => ({ ...g, name: dominantName(g) }))
    // Most commits first; ties go to whoever started earlier, then by name, so
    // the order never depends on Map insertion or on git's output order.
    .sort((a, b) => b.commits - a.commits || a.first.localeCompare(b.first) || a.name.localeCompare(b.name));
}

/** A contributor's most-worked-on pages, best first, existing pages only. */
function topPages(contributor, titles) {
  return [...contributor.pages.entries()]
    .filter(([file]) => titles.has(file)) // pages since deleted or renamed away
    .sort((a, b) => b[1].commits - a[1].commits || b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
    .slice(0, MAX_PAGES_PER_CONTRIBUTOR)
    .map(([file]) => titles.get(file));
}

// --- Rendering -------------------------------------------------------------

/** Obsidian wikilink by full path, always aliased with the page's label.
 *  The alias separator is escaped because every one of these lands in a table
 *  cell, where a bare | ends the cell: [[path\\|Alias]] is the form Obsidian
 *  documents for exactly this, and markdownlint's MD056 agrees. */
const wikilink = ({ target, label }) => `[[${target}\\|${label}]]`;

const escapeCell = (s) => s.replaceAll('|', '\\|');

function renderIntro(contributors, config) {
  const { title, maintainer } = config;
  const lines = [
    `*${title}* is maintained in the open. The chapters are plain text files in a public repository, every change to them is a commit signed by whoever made it, and this page is put together from that history — so anyone whose work has landed in the book turns up here without having to ask.`,
    '',
  ];

  if (contributors.length === 0) {
    lines.push('No contributions have been recorded yet. The table below fills itself in as soon as the first change lands.');
    return lines;
  }

  const [lead, ...rest] = contributors;
  const span = lead.first.slice(0, 10) === lead.last.slice(0, 10)
    ? `on ${longDate(lead.first)}`
    : `between ${longDate(lead.first)} and ${longDate(lead.last)}`;

  if (contributors.length === 1) {
    lines.push(`So far that history has one name in it. ${lead.name} has made ${plural(lead.commits, 'commit')} ${span}, which is every word of the book as it currently stands. The book is early, and the list is short for the same reason — there is room on it.`);
  } else if (contributors.length <= 4) {
    const restCommits = plural(rest.reduce((n, c) => n + c.commits, 0), 'commit');
    const restClause = rest.length === 1
      ? `${rest[0].name} has contributed ${restCommits}`
      : `the others have contributed ${restCommits} between them`;
    lines.push(`${joinList(contributors.map((c) => c.name))} have worked on the book so far. ${lead.name} has made the most changes — ${plural(lead.commits, 'commit')} ${span} — and ${restClause}.`);
  } else {
    const named = contributors.slice(0, 3).map((c) => c.name);
    lines.push(`${plural(contributors.length, 'person', 'people')} have worked on the book so far, between them making ${plural(contributors.reduce((n, c) => n + c.commits, 0), 'commit')}. The most frequent contributors are ${joinList(named)}; the full list is below, in order of how much each has changed.`);
  }

  lines.push('', `Maintenance and review stay with ${maintainer}: outside contributions arrive as pull requests and are read before they are merged. Being on this list means your work is in the book, not that you are responsible for the rest of it.`);
  return lines;
}

function renderTable(contributors, titles) {
  const rows = [
    '| Contributor | Changes | First | Most recent | Pages worked on most |',
    '| --- | ---: | --- | --- | --- |',
  ];

  for (const c of contributors) {
    const pages = topPages(c, titles);
    rows.push([
      '',
      escapeCell(c.name),
      String(c.commits),
      shortDate(c.first),
      shortDate(c.last),
      pages.length ? pages.map(wikilink).join(', ') : '—',
      '',
    ].join(' | ').trim());
  }

  return rows;
}

function renderPage({ contributors, titles, config, botCommits, generatedOn }) {
  const { licence } = config;
  const out = ['# Contributors', ''];

  out.push(...renderIntro(contributors, config), '');

  if (contributors.length > 0) {
    out.push('## Who has worked on the book', '');
    out.push(...renderTable(contributors, titles), '');
    out.push(`"Changes" counts commits, which is a rough measure and an honest one: a commit can be a rewritten section or a corrected apostrophe, and both are worth having. The pages column looks only at ${CONTENT_DIR}/ — the book itself — so work on the build, the workflows or the documentation is real but invisible here.`, '');
  }

  out.push('## Getting your name on this page', '');
  out.push('You do not need to be a maintainer, or know anything about Git, to end up in the table. There are three ways in, and the lightest one is a perfectly good way to start.', '');
  out.push('**Suggest an edit.** Every page on the site has a *Suggest an edit* link. Fill in what is wrong and what it should say, and the change is filed for review. No account is needed. This is the right route for a typo, a broken reference, or a sentence that does not say what it means to.', '');
  out.push('**Edit the source on GitHub.** Every page also carries an *Edit on GitHub* link, which opens that page\'s Markdown file in the browser. With a free GitHub account you can change the text and propose it as a pull request; a maintainer reviews it before anything moves. Small fixes are as welcome as large ones.', '');
  out.push(`**Use the browser editor.** Contributors given editing access work in a web editor that writes to the drafts branch, no Obsidian and no terminal involved. If you are teaching from the book and expect to make changes regularly, that is the route to ask for${docLinks(config)}.`, '');
  out.push('Margin comments count as contributions too, and are often the most useful thing a reader leaves behind — but they live in the annotation layer rather than in the repository, so they do not appear in the table above.', '');

  if (botCommits > 0) {
    out.push(`Routine housekeeping — annotation backups, link checks, and the rebuild of this page — is committed by \`github-actions[bot]\` and is left out of the counts above.`, '');
  }

  out.push('---', '');
  out.push(`*Contributions to ${config.title} are made available under ${licence}, the licence the book itself carries: share and adapt freely, with attribution, under the same terms.*`, '');
  out.push(`*This page is rebuilt from the repository's commit history. Last updated ${generatedOn}.*`, '');

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * The two guides the browser-editor paragraph points to. Neither is a page of the
 * book (docs/ is not published, and the coordinators' walkthrough lives with the
 * edition template), so both are GitHub links, and each is left out when the book
 * doesn't have it.
 */
function docLinks({ trustedGuide, editionGuide }) {
  const links = [];
  if (trustedGuide) links.push(`see [Editing chapters in the browser](${trustedGuide})`);
  if (editionGuide) links.push(`${links.length ? '' : 'see '}[setting up a department edition](${editionGuide}) if your course wants its own copy`);
  return links.length ? ` — ${links.join(', and ')}` : '';
}

// --- Main ------------------------------------------------------------------

const TRUSTED_GUIDE = 'docs/for-trusted-contributors.md';
const EDITION_GUIDE = 'docs/department-edition-setup.md';

/** What the page needs from the book's registry entry, and the platform's bot accounts. */
async function readConfig() {
  const { book, registry } = await loadBook(REPO_ROOT);
  const logins = registry.platform?.automation_logins;
  if (!isStringArray(logins)) throw new RegistryError(`the registry has no valid platform.automation_logins (expected a list of logins, got ${JSON.stringify(logins)}).`);
  automationLogins = new Set(logins.map((l) => l.toLowerCase()));
  const repo = field(book, 'content.repo', isString, 'owner/name');
  const branch = field(book, 'content.live_branch', isString, 'a branch');
  const template = book.editions?.template_repo;
  let trustedGuide = null;
  try {
    await fs.access(path.join(REPO_ROOT, TRUSTED_GUIDE));
    trustedGuide = `https://github.com/${repo}/blob/${branch}/${TRUSTED_GUIDE}`;
  } catch { /* this book has no such guide */ }
  return {
    title: field(book, 'title', isString, 'a title'),
    maintainer: field(book, 'maintainer.name', isString, 'a name'),
    licence: field(book, 'licence', isString, 'an SPDX id'),
    trustedGuide,
    editionGuide: isString(template) ? `https://github.com/${template}/blob/main/${EDITION_GUIDE}` : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node automation/scripts/gen-contributors.mjs [--out <path>] [--stdout] [--check]');
    return 0;
  }

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    exitOnRegistryError(err);
  }
  const commits = readCommits();
  const touches = readContentTouches();
  const titles = await readPageTitles();
  const contributors = buildContributors(commits, touches);
  const botCommits = commits.filter((c) => isBot(c.name, c.email)).length;

  // The stamp is the date of the newest counted commit, never today's date:
  // see note 1 at the top of this file.
  const newest = contributors.reduce((acc, c) => (acc && acc > c.last ? acc : c.last), null);
  const generatedOn = newest ? longDate(newest) : longDate(commits[0]?.date ?? '1970-01-01T00:00:00Z');

  const page = renderPage({ contributors, titles, config, botCommits, generatedOn });

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
    console.error(`${path.relative(REPO_ROOT, opts.out)} is out of date — run gen-contributors.mjs from quartz-book in the book's clone`);
    return 1;
  }

  if (current === page) {
    console.log(`${path.relative(REPO_ROOT, opts.out)} unchanged (${plural(contributors.length, 'contributor')}).`);
    return 0;
  }

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, page);
  console.log(`wrote ${path.relative(REPO_ROOT, opts.out)} — ${plural(contributors.length, 'contributor')}, ${plural(commits.length - botCommits, 'commit')} counted, ${botCommits} from automation.`);
  return 0;
}

process.exitCode = await main();
