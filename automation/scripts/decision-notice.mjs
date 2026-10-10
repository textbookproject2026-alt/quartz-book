// automation/scripts/decision-notice.mjs (quartz-book)
//
// Tells a signed-in contributor what the authors decided, in one comment that
// @mentions them, so GitHub notifies and emails them: run by
// .github/workflows/book-decision-notice.yml when a pull request labelled
// proposed-edit, or an issue labelled section-note, is closed in a book repo.
//
// Who: the attribution line suggest-edit-function wrote,
//   **Proposed by:** @login (signed in with GitHub)     (a proposed edit)
//   **Submitted by:** @login (signed in with GitHub)    (a note to the authors)
// An anonymous one (a name in a code span) gets no comment: there is nobody to
// mention. What: a merged pull request, or an issue closed as completed, is
// accepted; closed otherwise, declined. Why: the reason the author gave when
// declining in the author site (batch 2c: the App's tb-declined comment, under
// the member's name), else the last comment (or review) by someone other than the
// contributor and the platform's bots, quoted. Where: the page on the book's
// site, when accepted.
//
// Reads the event (GITHUB_EVENT_PATH) and the book's registry entry; writes one
// comment with GITHUB_TOKEN, and none if one is already there (a re-run).

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RegistryError, exitOnRegistryError, loadBook } from './lib/registry.mjs';
import { quartzUrl } from './backup-annotations.mjs';
import { contributorOf, filesOf } from './lib/attribution.mjs';

export { contributorOf };

export const MARKER = '<!-- tb-decision-notice -->';
const QUOTE_MAX = 1200;

/** The file the proposal or note is about: its first **File:** line's path. */
export const fileOf = (body = '') => filesOf(body)[0] ?? null;

/** A note on one paragraph: its **Where:** link, the paragraph's address on the site. */
export function paragraphOf(body = '') {
  const m = /^\*\*Where:\*\* \[¶(\d+)\]\((https:\/\/[^)\s]+)\)/m.exec(body);
  return m ? { n: Number(m[1]), url: m[2] } : null;
}

/** Accepted, or declined: a merged pull request or an issue closed as completed is accepted. */
export const accepted = (event) =>
  event.pull_request ? event.pull_request.merged === true : event.issue?.state_reason === 'completed';

const isBot = (user) => !user || user.type === 'Bot' || /\[bot\]$/.test(user.login ?? '');

/**
 * The reason: the newest comment or review with text, by a person other than the
 * contributor. `items` are GitHub's issue comments and pull request reviews.
 */
export function reasonOf(items, contributor) {
  const given = items.map(declinedReason).filter(Boolean).at(-1);
  if (given) return given;
  const said = items
    .filter((c) => (c.body ?? '').trim() && !isBot(c.user) && c.user.login.toLowerCase() !== contributor.toLowerCase())
    .filter((c) => !(c.body ?? '').includes(MARKER))
    .map((c) => ({ at: c.submitted_at ?? c.created_at, body: c.body.trim(), who: c.user.login }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  return said.at(-1) ?? null;
}

const READER_APP_LOGIN = 'textbook-suggest-edit[bot]';
/** The author site's decline (batch 2c): { body, name } from the App's marker, or null. */
export function declinedReason(c) {
  if (c?.user?.login !== READER_APP_LOGIN) return null;
  const m = /^<!-- tb-declined (\{.*?\}) -->/.exec(String(c.body ?? ''));
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    return typeof d?.reason === 'string' && d.reason.trim() ? { at: c.created_at, body: d.reason.trim(), name: String(d.name ?? '').slice(0, 80) || 'The authors' } : null;
  } catch {
    return null;
  }
}

/** "> " before every line, so the reason reads as a quote; long ones cut. */
const quote = (text) => {
  const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;
  return cut.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
};

/**
 * The comment, or null when there is nobody to tell. `book` is the registry entry
 * (its domain, live and drafts branches).
 */
export function decisionComment({ event, book, items }) {
  const thing = event.pull_request ?? event.issue;
  const who = contributorOf(thing?.body ?? '');
  if (!who) return null;
  const pr = Boolean(event.pull_request);
  const ok = accepted(event);
  const site = `https://${book.site.domain}`;
  const file = fileOf(thing.body);
  const para = paragraphOf(thing.body);
  const page = para?.url ?? (file ? quartzUrl(file, site) : null);
  const what = pr ? 'your proposed edit' : para ? `your note on ¶${para.n}` : 'your note';
  const lines = [MARKER, `@${who}, the authors have ${ok ? 'accepted' : 'declined'} ${what}. Thank you for it.`];
  const reason = reasonOf(items, who);
  if (reason) lines.push('', reason.name ? `${reason.name} gave this reason:` : `@${reason.who} wrote:`, '', quote(reason.body.replace(/@/g, '@\u200b')));
  if (ok && page) {
    const live = !pr || event.pull_request.base?.ref === book.content.live_branch;
    lines.push(
      '',
      pr && !live
        ? `It is in the book's drafts now, and reaches the live page when the authors next publish: ${page}`
        : `The page: ${page}`,
    );
  }
  return lines.join('\n');
}

// --- the run --------------------------------------------------------------------------

async function gh(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'textbook-actions (decision notice)',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} ${pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const { book } = await loadBook(process.cwd());
  const repo = process.env.GITHUB_REPOSITORY;
  const number = (event.pull_request ?? event.issue)?.number;
  if (!number) throw new Error('the event is neither a pull request nor an issue.');
  const comments = await gh(`/repos/${repo}/issues/${number}/comments?per_page=100`);
  if (comments.some((c) => (c.body ?? '').includes(MARKER))) {
    console.log(`#${number} already has its decision notice.`);
    return;
  }
  const reviews = event.pull_request ? await gh(`/repos/${repo}/pulls/${number}/reviews?per_page=100`) : [];
  const text = decisionComment({ event, book, items: [...comments, ...reviews] });
  if (!text) {
    console.log(`#${number}: no signed-in contributor to tell (anonymous, or no attribution line).`);
    return;
  }
  await gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: text } });
  console.log(`#${number}: told @${contributorOf((event.pull_request ?? event.issue).body)} (${accepted(event) ? 'accepted' : 'declined'}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    if (err instanceof RegistryError) exitOnRegistryError(err);
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
