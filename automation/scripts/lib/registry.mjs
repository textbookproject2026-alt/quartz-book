// automation/scripts/lib/registry.mjs (quartz-book)
//
// Finds a book's entry in the platform registry (textbook-registry/registry.json)
// for the book automation scripts, which run in the book's own repo from
// quartz-book's reusable workflows (DESIGN §2b, §3e; BOOK-ONE-TO-QUARTZ §8 step 14).
//
// The registry is FETCHED on every run, from the registry repo's main branch, rather
// than baked into the book: these jobs act only with the book repo's own GITHUB_TOKEN, so
// the worst a bad entry can do is a wrong generated page, which still goes through a
// pull request. A registry change reaches them at their next run.
//
// TEXTBOOK_REGISTRY overrides where it is read from: an https:// URL, or a path to a
// registry.json (e.g. ../textbook-registry/registry.json, to try an unmerged registry
// change locally).
//
// Resolution (§3e). Two independent keys must name the same book:
//   - textbook.config.json's "slug";
//   - in Actions, GITHUB_REPOSITORY, which must equal that book's content.repo
//     (case-insensitively). A config file copied into another book's repo, or a fork
//     running the workflow by hand, is refused instead of quietly reporting on this book.
// Local runs (no GITHUB_REPOSITORY) use the slug alone.
//
// NEVER A DEFAULT. There is no fallback book, site or group list. An unreachable
// registry, an unparseable one, an unknown slug, a retired book, or a field that is
// missing or the wrong type all throw RegistryError before the caller has queried an
// API or written a file. A missing `hypothesis_groups`, for instance, must not read as
// "no groups": that would back up and count nothing and look fine doing it.

import fs from 'node:fs/promises';
import path from 'node:path';

export const REGISTRY_URL =
  'https://raw.githubusercontent.com/textbookproject2026-alt/textbook-registry/main/registry.json';

const SCHEMA_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3; // network errors and 5xx only; a 404 is not going to fix itself

export class RegistryError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': 'textbook-actions (registry)' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new RegistryError(`cannot fetch the registry from ${url}: ${err.message}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res.text();
    if (res.status < 500 || attempt === MAX_ATTEMPTS)
      throw new RegistryError(`cannot fetch the registry from ${url}: HTTP ${res.status} ${res.statusText}`);
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

async function readRegistry(source) {
  let text;
  if (/^https:\/\//.test(source)) {
    text = await fetchText(source);
  } else {
    try {
      text = await fs.readFile(source, 'utf8');
    } catch (err) {
      throw new RegistryError(`cannot read the registry at ${source}: ${err.code ?? err.message}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new RegistryError(`the registry at ${source} is not valid JSON: ${err.message}`);
  }
}

/** The value at a dotted path, or a RegistryError naming the field and what was wrong. */
export function field(book, dotted, check, expected) {
  const value = dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), book);
  if (!check(value)) {
    throw new RegistryError(
      `registry entry "${book.slug}" has no valid ${dotted} (expected ${expected}, got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

export const isString = (v) => typeof v === 'string' && v !== '';
export const isStringArray = (v) => Array.isArray(v) && v.every(isString);

/**
 * Load the registry and resolve this repo's book.
 * @returns {Promise<{ book: object, registry: object, source: string }>}
 */
export async function loadBook(repoRoot) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(path.join(repoRoot, 'textbook.config.json'), 'utf8'));
  } catch (err) {
    throw new RegistryError(`cannot read textbook.config.json: ${err.code ?? err.message}`);
  }
  const slug = config.slug;
  if (!isString(slug)) throw new RegistryError('textbook.config.json has no "slug", so the book cannot be found in the registry.');

  const override = process.env.TEXTBOOK_REGISTRY?.trim();
  const source = !override ? REGISTRY_URL : /^https:\/\//.test(override) ? override : path.resolve(override);
  const registry = await readRegistry(source);

  if (registry?.schema_version !== SCHEMA_VERSION) {
    throw new RegistryError(
      `the registry at ${source} has schema_version ${JSON.stringify(registry?.schema_version)}; these scripts understand ${SCHEMA_VERSION} only.`,
    );
  }
  if (!Array.isArray(registry.books)) throw new RegistryError(`the registry at ${source} has no "books" list.`);

  // The registry's CI rejects duplicates; check again, because picking the first of two
  // entries is exactly the silent mix-up the array format exists to prevent.
  const bySlug = registry.books.filter((b) => b?.slug === slug);
  if (bySlug.length === 0) throw new RegistryError(`no book with slug "${slug}" in the registry at ${source}.`);
  if (bySlug.length > 1) throw new RegistryError(`slug "${slug}" appears ${bySlug.length} times in the registry at ${source}.`);
  const [book] = bySlug;

  if (book.status === 'retired') throw new RegistryError(`book "${slug}" is retired in the registry.`);
  const repo = field(book, 'content.repo', isString, 'owner/name');

  const running = process.env.GITHUB_REPOSITORY?.trim();
  if (running) {
    const lc = running.toLowerCase();
    const byRepo = registry.books.filter((b) => typeof b?.content?.repo === 'string' && b.content.repo.toLowerCase() === lc);
    if (byRepo.length === 0) {
      throw new RegistryError(`this workflow is running in ${running}, which is not a registered textbook repository.`);
    }
    if (byRepo.length > 1 || byRepo[0] !== book) {
      throw new RegistryError(
        `textbook.config.json names "${slug}", which is kept in ${repo}, but this workflow is running in ${running}. ` +
          'Refusing to report one book from another book\'s repository.',
      );
    }
  }

  return { book, registry, source };
}

/** Print a RegistryError the way Actions surfaces it, and exit 1. Anything else is rethrown. */
export function exitOnRegistryError(err) {
  if (!(err instanceof RegistryError)) throw err;
  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'ERROR: ';
  console.error(`${prefix}${err.message.replace(/([^.])$/, '$1.')} Nothing was written.`);
  process.exit(1);
}
