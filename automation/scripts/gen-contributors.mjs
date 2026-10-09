#!/usr/bin/env node
// automation/scripts/gen-contributors.mjs (quartz-book)
//
// Regenerates a book's credit ledger, community/credits.json, and its
// contributors page, community/contributors.md, and writes both into the book's
// checkout. It runs from the platform's reusable workflow
// (.github/workflows/book-community-page.yml), with the book checked out as the
// working directory (or BOOK_ROOT).
//
// Who is credited, and for what (lib/credits.mjs has the policy):
//   - authors and editors, from the frontmatter (index.md for the book, a
//     chapter's own for that chapter);
//   - contributors, from three sources merged per person: the commits (git log,
//     mailmap-aware, bots and the registry's automation accounts left out), the
//     merged proposed-edit pull requests, and the section-note / suggested-edit
//     issues closed as completed, each read from suggest-edit-function's
//     attribution line (lib/attribution.mjs). The pull requests and issues come
//     from the GitHub API with GITHUB_TOKEN (or GH_TOKEN): the workflow's token in
//     Actions.
//   - community/credit-overrides.yml (hide, rename, merge, no-credit) and the
//     no-credit label take people or items out.
//
// Run:  node <quartz-book>/automation/scripts/gen-contributors.mjs   (in the book's clone)
// Flags:
//   --out <path>   write the page somewhere other than community/contributors.md
//                  (the ledger goes beside it, as credits.json)
//   --stdout       print the page instead of writing anything
//   --check        write nothing; exit 1 if either file on disk is out of date
//
// Node 22; one dependency, yaml (automation/package.json).
//
// ---------------------------------------------------------------------------
// TWO THINGS TO KNOW BEFORE CHANGING THIS FILE
//
//  1. The output must be a pure function of the history (commits, and the
//     pull requests and issues as GitHub has them). The weekly
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
import YAML from 'yaml';
import { loadBook, field, isString, isStringArray, exitOnRegistryError, RegistryError } from './lib/registry.mjs';
import { buildLedger, contributions, isAutomation, KINDS, pageAnchor, peopleOf } from './lib/credits.mjs';

// The book's clone. These scripts live in the platform repo, not in the book.
const REPO_ROOT = path.resolve(process.env.BOOK_ROOT || '.');

// --- Configuration ---------------------------------------------------------

// Only these paths count as "the book". Tooling, workflows, docs and the
// annotation backups are real work, but they are not pages, and a table of
// most-edited files that led with .github/workflows/ would tell a reader
// nothing about the textbook.
const CONTENT_DIR = 'chapters';
// The pages a contribution can touch: the chapters, the front page, the glossary.
const PAGE_PATHS = [CONTENT_DIR, 'index.md', 'glossary.md'];

// Named identities that are automation rather than people. The `[bot]` suffix
// catches GitHub's own actors (github-actions[bot], dependabot[bot], any App);
// the registry's platform.automation_logins lists bots that commit under an
// ordinary-looking account (aldogobot, the account the suggest-edit function
// has acted as: its commits carry a human's suggestion, but the authorship is
// the bot's). Filled in by main() before any commit is read.
let automationLogins = new Set();


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
  opts.ledger = () => path.join(path.dirname(opts.out), 'credits.json');
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

/** The name an anonymous in-site proposal gave: its commit's last `Proposed-by:`
 *  trailer (suggest-edit-function's propose-edit writes it). As builder/lib.mjs's
 *  proposedBy, kept here because this runs from a sparse checkout of automation/. */
const proposedBy = (body) =>
  [...body.matchAll(/^Proposed-by:[ \t]*(.+?)[ \t]*$/gm)].pop()?.[1].slice(0, 80) || null;

/** A name as the page prints it: characters Markdown, wikilinks or HTML would act on
 *  become character references, so a name a reader typed stays plain text. */
const plainName = (s) => s.replace(/[&<>[\]|*_`\\~#!]/g, (c) => `&#${c.charCodeAt(0)};`);

const isBot = (name, email) =>
  /\[bot\]/i.test(name) || /\[bot\]/i.test(email) || automationLogins.has(name.toLowerCase());



/** "a, b and c" — an Oxford-comma-free English list. */
function joinList(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


// --- Reading the history ---------------------------------------------------

/** Every non-merge commit, newest first, with the pages it touched, the name an
 *  in-site proposal gave (`proposer`) when the App committed it for an anonymous
 *  reader, and whether it is automation's.
 *
 *  --no-merges on purpose: a merge commit is a maintainer pressing a button,
 *  and counting it would credit the same work twice. */
function readCommits() {
  const out = git('log', '--no-merges', '-z', `--format=%H${US}%aN${US}%aE${US}%aI${US}%s${US}%B`);
  const touches = readPageTouches();
  return out.split('\0').filter((r) => r.trim()).map((record) => {
    const [sha, name, email, date, subject, body = ''] = record.replace(/^\n/, '').split(US);
    const bot = isBot(name, email);
    // An anonymous proposal with no name (older ones carry no trailer) is nobody to credit.
    const proposer = bot ? proposedBy(body) : null;
    return { sha, name, email, date, subject, body, proposer, bot, pages: touches.get(sha) ?? [] };
  });
}

/** sha -> [paths] of the pages it touched (chapters, the front page, the glossary). */
function readPageTouches() {
  const out = git('log', '--no-merges', '-M', '--name-only', `--format=${RS}%H`, '--', ...PAGE_PATHS);
  const touches = new Map();
  let sha = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith(RS)) { sha = line.slice(1); continue; }
    if (sha === null || !line.endsWith('.md')) continue;
    if (!touches.has(sha)) touches.set(sha, []);
    touches.get(sha).push(line);
  }
  return touches;
}

/** A page's frontmatter (as YAML) and body; {} when it has none or it doesn't parse. */
async function readPage(file) {
  let text = '';
  try { text = (await fs.readFile(path.join(REPO_ROOT, file), 'utf8')).replace(/\r\n/g, '\n'); } catch { return null; }
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.trimStart());
  let fm = {};
  if (m) {
    try {
      const parsed = YAML.parse(m[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed;
    } catch { /* unparseable frontmatter: none */ }
  }
  return { fm, body: m ? text.trimStart().slice(m[0].length) : text };
}

/** The book's pages that exist now: path -> { title, authors, editors } (frontmatter title, else H1, else the file name). */
async function readPages() {
  const tracked = git('ls-files', '--', ...PAGE_PATHS).split('\n').filter((f) => f.endsWith('.md'));
  const pages = new Map();
  for (const file of tracked.sort()) {
    const page = await readPage(file);
    if (!page) continue;
    const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(page.body)?.[1];
    const title = String(page.fm.title ?? '').trim() || h1 || path.basename(file, '.md');
    pages.set(file, {
      title,
      authors: peopleOf(page.fm.authors ?? page.fm.author),
      editors: peopleOf(page.fm.editors ?? page.fm.editor),
    });
  }
  return pages;
}

/** community/credit-overrides.yml, or {} (no file). A file that doesn't parse stops the run. */
async function readOverrides() {
  let text;
  try { text = await fs.readFile(path.join(REPO_ROOT, 'community', 'credit-overrides.yml'), 'utf8'); } catch { return {}; }
  const parsed = YAML.parse(text);
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('community/credit-overrides.yml must be a mapping (hide:, rename:, merge:, no-credit:).');
  return parsed;
}

const withoutOrcid = ({ orcid: _orcid, ...p }) => p;

/** Which of these GitHub logins are accounts of type Bot (users/<login>; unknown ones aren't). */
async function readBotLogins(logins) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const unique = [...new Set(logins.filter(Boolean).map((l) => l.toLowerCase()))].sort();
  const bots = [];
  for (const login of unique) {
    const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/users/${encodeURIComponent(login)}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/vnd.github+json', 'user-agent': 'textbook-actions (contributors)' },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (res?.ok && (await res.json())?.type === 'Bot') bots.push(login);
  }
  return bots;
}

/** Every closed pull request and issue, from GitHub (paged), as the API gives them. */
async function readGitHub(repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is needed to read the book\'s accepted proposals and notes. In Actions it is the workflow\'s token.');
  const get = async (what) => {
    const all = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repo}/${what}${what.includes('?') ? '&' : '?'}state=closed&per_page=100&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'textbook-actions (contributors)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`GET ${what}: HTTP ${res.status}`);
      const batch = await res.json();
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  };
  const [pulls, issues] = await Promise.all([get('pulls?sort=created&direction=asc'), get('issues?sort=created&direction=asc')]);
  return { pulls, issues: issues.filter((i) => !i.pull_request) };
}

// --- Rendering -------------------------------------------------------------


const wikilink = (file, label) => `[[${file.replace(/\.md$/, '')}\\|${label}]]`;
const escapeCell = (s) => s.replaceAll('|', '\\|');
const KIND_WORDS = { edit: ['edit', 'edits'], note: ['note', 'notes'], suggestion: ['suggestion', 'suggestions'], commit: ['commit', 'commits'] };

/** A person's name, linked to their GitHub profile and ORCID record where known. */
function personLine(p) {
  const name = plainName(p.name);
  const links = [];
  if (p.github) links.push(`[GitHub](https://github.com/${p.github})`);
  if (p.orcid) links.push(`[ORCID](https://orcid.org/${p.orcid})`);
  return links.length ? `${name} (${links.join(', ')})` : name;
}

/** The book's people in one role: book-level first, then chapter-level, each once, with the chapters they're on. */
function roleList(role, book, pages) {
  const seen = new Map();
  for (const p of book) seen.set(p.name.toLowerCase(), { person: p, pages: [] });
  for (const [file, page] of pages) {
    if (file === 'index.md') continue;
    for (const p of page[role]) {
      const key = p.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, { person: p, pages: [] });
      if (!book.some((b) => b.name.toLowerCase() === key)) seen.get(key).pages.push(wikilink(file, page.title));
    }
  }
  return [...seen.values()].map(({ person, pages: on }) => `- ${personLine(person)}${on.length ? ` — ${joinList(on)}` : ''}`);
}

function renderPage({ ledger, pages, config }) {
  const index = pages.get('index.md') ?? { authors: [], editors: [] };
  const authors = roleList('authors', index.authors, pages);
  const editors = roleList('editors', index.editors, pages);
  const out = ['# Contributors', ''];
  out.push(`*${config.title}* is written in the open. This page credits everyone whose work is in it: the authors and editors named on its pages, and every reader whose accepted edit, note or suggestion changed it. It is rebuilt from the book's history.`, '');

  out.push('## Authors', '', ...(authors.length ? authors : ['The book names no authors yet.']), '');
  out.push('## Editors', '', ...(editors.length ? editors : ['The book names no editors.']), '');

  out.push('## Contributors', '');
  if (!ledger.contributors.length) {
    out.push('No accepted contributions yet. The first accepted edit, note or suggestion puts its author here.', '');
  } else {
    out.push(`${plural(ledger.contributors.length, 'person', 'people')} ${ledger.contributors.length === 1 ? 'has' : 'have'} contributed so far.`, '');
    out.push('| Contributor | Contributions | Pages | References |', '| --- | --- | --- | --- |');
    for (const c of ledger.contributors) {
      const counts = KINDS.filter((k) => c.counts[k]).map((k) => `${c.counts[k]} ${KIND_WORDS[k][c.counts[k] === 1 ? 0 : 1]}`).join(', ');
      const on = [...new Set(c.contributions.flatMap((x) => x.pages))].filter((f) => pages.has(f)).sort();
      // The proposals and notes, linked; commits are in the count (and the page history).
      const refs = c.contributions.filter((x) => x.kind !== 'commit' && x.url).map((x) => `[${x.ref}](${x.url})`);
      rows(out, [escapeCell(personLine(c)), counts, on.map((f) => wikilink(f, pages.get(f).title)).join(', ') || '—', refs.join(' ') || '—']);
    }
    out.push('');
  }

  // Each page's contributors, under an anchor the page's own footer links to.
  const byPage = [...pages.keys()].filter((f) => ledger.contributors.some((c) => c.contributions.some((x) => x.pages.includes(f))));
  if (byPage.length) {
    out.push('## By page', '');
    for (const f of byPage) {
      const names = ledger.contributors.filter((c) => c.contributions.some((x) => x.pages.includes(f))).map((c) => plainName(c.name));
      out.push(`<a id="${pageAnchor(f)}"></a>`, '', `**${wikilink(f, pages.get(f).title)}**: ${joinList(names)}`, '');
    }
  }

  out.push('## How credit works', '');
  out.push('- **Authors** wrote the book or a chapter, and **editors** edited it. Both are named on the pages they worked on, and both are in every citation: a chapter is cited by its authors, with the book\'s editors as the book\'s; a book with editors and no authors of its own is cited by its editors.');
  out.push('- **Contributors** are readers whose work the authors accepted: an edit proposed with *Edit this page* and merged, a note to the authors or a suggested edit the authors acted on, or an edit by one of the book\'s team in the author site. Each is thanked at the foot of the pages they changed and listed here. Contributors are not part of the citation.');
  out.push('- Only people are credited. Software that helps make the book (the platform\'s own accounts, bots, AI tools such as Claude) is never named as an author, an editor or a contributor.');
  out.push('- Something the authors decline earns no credit. Someone who sent a suggestion without signing in is credited by the name they gave.');
  out.push('- To be left off this page, or to have two names counted as one person, ask the authors: they record it in `community/credit-overrides.yml`.', '');
  out.push('---', '');
  out.push(`*Contributions to ${config.title} are made available under ${config.licence}, the licence the book itself carries.*`, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

const rows = (out, cells) => out.push(`| ${cells.join(' | ')} |`);

// --- Main ------------------------------------------------------------------

/** What the page needs from the book's registry entry, and the platform's bot accounts. */
async function readConfig() {
  const { book, registry } = await loadBook(REPO_ROOT);
  const logins = registry.platform?.automation_logins;
  if (!isStringArray(logins)) throw new RegistryError(`the registry has no valid platform.automation_logins (expected a list of logins, got ${JSON.stringify(logins)}).`);
  automationLogins = new Set(logins.map((l) => l.toLowerCase()));
  const identities = registry.platform?.automation_identities ?? [];
  if (!isStringArray(identities)) throw new RegistryError(`platform.automation_identities must be a list of names and emails (got ${JSON.stringify(identities)}).`);
  return {
    logins,
    identities,
    // ORCID iDs shown and linked only while the platform's switch is on (default on).
    orcid: registry.platform?.features?.orcid !== false,
    repo: field(book, 'content.repo', isString, 'owner/name'),
    title: field(book, 'title', isString, 'a title'),
    licence: field(book, 'licence', isString, 'an SPDX id'),
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
  const pages = await readPages();
  // Everyone named as an author or editor anywhere in the book: credited as that, not as a contributor.
  // The registry's `authors` (who may use the author site) aren't the book's authors:
  // only the frontmatter names those.
  const { pulls, issues } = await readGitHub(config.repo);
  const commits = readCommits();
  // Only people: the registry's automation lists, plus any login GitHub says is a Bot.
  const firstPass = isAutomation({ logins: config.logins, identities: config.identities });
  const candidates = contributions({ pulls, issues, commits, automation: firstPass });
  const botLogins = await readBotLogins(candidates.map((c) => c.who.github));
  const automation = isAutomation({ logins: config.logins, identities: config.identities, botLogins });
  for (const page of pages.values()) {
    page.authors = page.authors.filter((p) => !automation(p)).map((p) => (config.orcid ? p : withoutOrcid(p)));
    page.editors = page.editors.filter((p) => !automation(p)).map((p) => (config.orcid ? p : withoutOrcid(p)));
  }
  const listed = [...pages.values()].flatMap((p) => [...p.authors, ...p.editors]);
  const items = contributions({ pulls, issues, commits, repoUrl: `https://github.com/${config.repo}`, automation });
  const ledger = buildLedger({ contributions: items, overrides: await readOverrides(), listed });
  const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
  const page = renderPage({ ledger, pages, config });

  if (opts.stdout) {
    process.stdout.write(page);
    return 0;
  }

  const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return null; } };
  const files = [[opts.out, page], [opts.ledger(), ledgerText]];
  const stale = [];
  for (const [p, text] of files) if ((await read(p)) !== text) stale.push(p);

  if (opts.check) {
    if (!stale.length) {
      console.log('community/contributors.md and community/credits.json are up to date.');
      return 0;
    }
    console.error(`${stale.map((p) => path.relative(REPO_ROOT, p)).join(' and ')} out of date — run gen-contributors.mjs from quartz-book in the book's clone`);
    return 1;
  }
  if (!stale.length) {
    console.log(`unchanged (${plural(ledger.contributors.length, 'contributor')}).`);
    return 0;
  }
  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  for (const [p, text] of files) await fs.writeFile(p, text);
  console.log(`wrote ${stale.map((p) => path.relative(REPO_ROOT, p)).join(' and ')} — ${plural(ledger.contributors.length, 'contributor')}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) process.exitCode = await main();
