#!/usr/bin/env node
// automation/scripts/backup-annotations.mjs (quartz-book)
//
// Weekly lossless backup of this textbook's Hypothes.is annotations.
//
// Pulls the scopes below and writes ONE file per run:
//   backups/annotations-YYYY-MM-DD.json
//
//   1. public              — the public layer for the book's site
//   2. public-legacy:<host> — the public layer left on each former domain
//   3. group:<id>          — each private annotation group
//
// Which site, which former domains and which groups all come from this book's
// entry in the platform registry (site.domain, site.legacy_origins,
// annotations.hypothesis_groups), fetched at the start of every run. See
// lib/registry.mjs. If the registry cannot be fetched, or the book or
// any of those fields cannot be resolved, the script exits 1 before it asks
// Hypothes.is for anything: no file is written and no old backup is pruned.
//
// Raw annotation JSON is stored verbatim (no field selection, no reshaping) so
// a future restore or migration has everything the API returned.
//
// Run:  HYPOTHESIS_API_TOKEN=... node <quartz-book>/automation/scripts/backup-annotations.mjs
// Flags: --out-dir <path>  --keep <n>  --site <url>  --force-per-uri  --dry-run
// Env:   TEXTBOOK_REGISTRY=<url or path> to read a registry other than main's
//
// Node 20+ (global fetch, AbortSignal.timeout). No dependencies.
//
// ---------------------------------------------------------------------------
// API FACTS — verified against the LIVE api.hypothes.is on 2026-08-17, not
// assumed from documentation. Re-verify if any of this starts misbehaving.
//
//   * wildcard_uri works UNAUTHENTICATED for public annotations. Wildcards
//     (* and _) are permitted only within the PATH; a wildcard anywhere in the
//     domain is rejected 400. So `https://social-research-methods.confused4now.org/*` is legal and is
//     our primary route to "all public annotations under this domain".
//   * limit  max 200 (limit=1000 -> 400 "greater than maximum value 200").
//   * offset max 9800 (offset=9999 -> 400 "greater than maximum value 9800").
//     Offset therefore CANNOT page a corpus past ~9800 rows. We use
//     search_after instead, which has no such ceiling.
//   * search_after takes the value of the sort field from the last row of the
//     previous page. Verified paging with sort=updated&order=asc.
//   * A group search with a missing/invalid token returns HTTP 200 and
//     {"total": 0, "rows": []} — it does NOT 401. An expired token would
//     otherwise produce a clean-looking, silently EMPTY backup.
//   * /api/profile likewise returns 200 with "userid": null for a bad token.
//     That null is the only reliable liveness signal, so we check it up front
//     and refuse to write a backup with a token the API does not recognise.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBook, field, isString, exitOnRegistryError, REGISTRY_URL } from './lib/registry.mjs';

// --- Configuration ---------------------------------------------------------
//
// Per-book values come from the registry entry, resolved in main():
//
//   annotations.hypothesis_groups — private groups to back up, in output order.
//     There are no per-edition groups: the Publisher tier was not bought and
//     per-cohort isolation was decided against. A group a coordinator runs for
//     their own cohort is added to the registry, and nothing here changes.
//     An empty list is normal; a missing one is an error.
//
//   site.legacy_origins — origins the book used to be served from. Hypothes.is
//     anchors every annotation to the URL it was made on and never moves it, so
//     annotations made before a domain cutover stay under the old domain for
//     good — a wildcard on the new domain does not see them. Each is backed up
//     as its own scope, public-legacy:<host>, so they do not silently age out
//     of the retained backups. Drop one from the registry only once its
//     annotations have been migrated or deliberately abandoned.

const API_BASE = 'https://api.hypothes.is/api';
const PUBLIC_GROUP = '__world__'; // Hypothes.is' id for the public layer
const PAGE_SIZE = 200; // API maximum, verified
const KEEP_DEFAULT = 12; // ~3 months of weekly backups
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4; // per request, for 429 / 5xx / network blips

// The book's clone (the working directory, or BOOK_ROOT). These scripts live in
// the platform repo, quartz-book, and run from its reusable workflows.
const REPO_ROOT = path.resolve(process.env.BOOK_ROOT || '.');

// Directories that never contain published pages. Everything else is treated
// as publishable: the per-URI fallback over-includes on purpose, because a
// query for an unpublished page just returns zero rows, whereas MISSING a page
// silently loses annotations. Cheap to be wrong one way, costly the other.
const SKIP_DIRS = new Set([
  '.git', '.github', '.obsidian', 'node_modules', 'backups', 'scripts', 'assets',
]);

const BACKUP_FILE_RE = /^annotations-\d{4}-\d{2}-\d{2}\.json$/;

// --- Small helpers ---------------------------------------------------------

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('WARNING:', ...a);

function parseArgs(argv) {
  const opts = {
    outDir: path.join(REPO_ROOT, 'backups'),
    keep: KEEP_DEFAULT,
    site: null, // the registry's site.domain, filled in by main()
    forcePerUri: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--out-dir': opts.outDir = path.resolve(next()); break;
      case '--keep': opts.keep = Number.parseInt(next(), 10); break;
      case '--site': opts.site = next().replace(/\/+$/, ''); break;
      case '--force-per-uri': opts.forcePerUri = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) {
    throw new Error(`--keep must be a positive integer (got ${opts.keep})`);
  }
  return opts;
}

function printHelp() {
  log(`Usage: HYPOTHESIS_API_TOKEN=<token> node <quartz-book>/automation/scripts/backup-annotations.mjs [options]

  --out-dir <path>   where annotations-YYYY-MM-DD.json is written
                     (default: <repo>/backups)
  --keep <n>         how many backup files to retain (default: ${KEEP_DEFAULT})
  --site <url>       site origin to back up (default: the book's site, from
                     the registry)
  --force-per-uri    skip the wildcard_uri query and use the per-page fallback
  --dry-run          fetch and report, write nothing

The book is resolved from textbook.config.json's "slug" in the registry at
${REGISTRY_URL} (override with TEXTBOOK_REGISTRY).
`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UTC date stamp — matches the workflow's UTC cron, so the filename is stable. */
function utcDateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// --- API access ------------------------------------------------------------

/**
 * GET against the API with retry on 429 / 5xx / network errors.
 * Throws with status + body on any non-retryable failure.
 */
async function apiGet(token, endpoint, searchParams) {
  const url = new URL(API_BASE + endpoint);
  if (searchParams) url.search = searchParams.toString();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'textbook-annotation-backup/1',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure (DNS, reset, timeout) — always worth a retry.
      if (attempt === MAX_ATTEMPTS) throw new Error(`${endpoint}: ${err.message}`);
      const waitMs = 1000 * 2 ** (attempt - 1);
      warn(`${endpoint} -> ${err.message}; retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      continue;
    }

    if (res.ok) return await res.json();

    const body = (await res.text().catch(() => '')).slice(0, 500);
    const failure = new Error(`HTTP ${res.status} from ${endpoint}: ${body}`);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw failure;

    // Honour Retry-After when the server sends a plain number of seconds.
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
    warn(`${endpoint} -> HTTP ${res.status}; retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await sleep(waitMs);
  }
  throw new Error(`${endpoint}: exhausted ${MAX_ATTEMPTS} attempts`);
}

/**
 * Page through /api/search until exhausted, using search_after.
 *
 * We deliberately do NOT use offset: it is capped at 9800 (verified), so it
 * cannot page a large corpus. search_after has no ceiling.
 *
 * Rows are collected in API order (updated ascending), which keeps same-day
 * re-runs byte-stable apart from genuinely new annotations.
 *
 * @returns {{rows: object[], pages: number, reportedTotal: number|null, warnings: string[]}}
 */
async function searchAll(token, baseParams, { seenIds = new Set() } = {}) {
  const rows = [];
  const warnings = [];
  let cursor = null;
  let pages = 0;
  let reportedTotal = null;

  for (;;) {
    const params = new URLSearchParams(baseParams);
    params.set('limit', String(PAGE_SIZE));
    params.set('sort', 'updated');
    params.set('order', 'asc');
    if (cursor !== null) params.set('search_after', cursor);

    const body = await apiGet(token, '/search', params);
    pages += 1;
    if (reportedTotal === null && Number.isFinite(body.total)) reportedTotal = body.total;

    const page = Array.isArray(body.rows) ? body.rows : [];
    for (const row of page) {
      // Dedupe by id across pages and across merged queries. Non-conforming
      // rows (no id) are kept unconditionally rather than dropped — lossless
      // beats tidy.
      if (row && typeof row.id === 'string') {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
      }
      rows.push(row);
    }

    if (page.length < PAGE_SIZE) break; // short page == last page

    const next = page[page.length - 1]?.updated;
    if (!next) {
      warnings.push(
        `Pagination stopped early after ${pages} page(s): last row had no "updated" field to use as a cursor.`,
      );
      break;
    }
    if (next === cursor) {
      // Only possible if a full page of ${PAGE_SIZE} rows shares one
      // microsecond-precision timestamp. Practically impossible, but if it
      // ever happens the cursor cannot advance and we would loop forever —
      // so we stop and say so loudly rather than truncate in silence.
      warnings.push(
        `Pagination stalled at cursor "${cursor}" after ${pages} page(s) — ` +
        `a full page shares one timestamp, so this scope may be INCOMPLETE.`,
      );
      break;
    }
    cursor = next;
  }

  return { rows, pages, reportedTotal, warnings };
}

// --- Repo page discovery (per-URI fallback) --------------------------------

/** Recursively collect vault-relative paths of every .md file. */
async function findMarkdownFiles(dir = REPO_ROOT, rel = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...await findMarkdownFiles(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
  return out;
}

/**
 * Repo-relative .md path -> the page's URL as the builder serves it (§3c).
 *
 * Quartz slugs every path segment: whitespace becomes "-", "&" becomes
 * "-and-", "%" becomes "-percent", "?" and "#" are dropped, and everything is
 * lowercased (slugifyFilePath in @quartz-community/utils, which the builder
 * runs; test/automation.test.mjs holds this copy to it). A folder's index.md,
 * or a file named after its folder, is the folder's page. Pages serves a slug
 * without ".html", and the browser sends each segment percent-encoded.
 */
export function quartzUrl(repoPath, site) {
  let slug = repoPath
    .replace(/\.md$/i, '')
    .split('/')
    .map((seg) => seg.replace(/\s/g, '-').replace(/&/g, '-and-').replace(/%/g, '-percent').replace(/\?/g, '').replace(/#/g, '').toLowerCase())
    .join('/');
  if (slug === '_index' || slug.endsWith('/_index')) slug = slug.replace(/_index$/, 'index');
  const segments = slug.split('/');
  if (segments.length >= 2 && segments.at(-1) === segments.at(-2)) segments[segments.length - 1] = 'index';
  if (segments.at(-1) === 'index') segments[segments.length - 1] = '';
  const url = segments.map((seg) => encodeURIComponent(seg)).join('/');
  return url === '' ? `${site}/` : `${site}/${url}`;
}

/**
 * Repo-relative .md path -> the URL Obsidian Publish served it at, the scheme
 * a book used before the builder (publish.js:48-73): case kept, spaces as "+",
 * every other reserved character percent-encoded per segment, root index.md at
 * "/". Hypothes.is never moves an annotation, so those made on Publish stay on
 * these URLs after the cutover, on the same domain.
 */
export function publishUrl(repoPath, site) {
  const withoutExt = repoPath.replace(/\.md$/, '');
  if (withoutExt === 'index') return `${site}/`;
  const encoded = withoutExt
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%20/g, '+'))
    .join('/');
  return `${site}/${encoded}`;
}

/** Every URL a page may carry annotations under: the builder's, then Publish's where it differs. */
export const pageUrls = (repoPath, site) => [...new Set([quartzUrl(repoPath, site), publishUrl(repoPath, site)])];

// --- Scope collection ------------------------------------------------------

/**
 * Public layer for the site.
 *
 * Primary route is wildcard_uri, which is verified to work unauthenticated and
 * needs exactly one paged query. group=__world__ is pinned so that an
 * authenticated run cannot quietly fold the token owner's private-group
 * annotations into what we label "public".
 *
 * If the wildcard query is ever rejected (policy change, restriction), we fall
 * back automatically to one query per published page and record that in meta.
 */
async function collectPublic(token, { site, forcePerUri }) {
  const seenIds = new Set();
  const warnings = [];

  if (!forcePerUri) {
    const wildcard = `${site}/*`;
    try {
      const params = { wildcard_uri: wildcard, group: PUBLIC_GROUP };
      log(`  public: wildcard_uri=${wildcard} group=${PUBLIC_GROUP}`);
      const main = await searchAll(token, params, { seenIds });

      // Belt and braces: "/*" covers every path under the origin, but not the
      // bare origin with no trailing slash, which URI normalisation could in
      // principle leave behind. One extra cheap exact query, merged + deduped.
      const bare = await searchAll(token, { uri: site, group: PUBLIC_GROUP }, { seenIds });
      if (bare.rows.length) {
        warnings.push(`${bare.rows.length} annotation(s) found on the bare origin "${site}" and merged in.`);
      }

      return {
        rows: [...main.rows, ...bare.rows],
        warnings: [...warnings, ...main.warnings, ...bare.warnings],
        detail: {
          method: 'wildcard_uri',
          pages: main.pages + bare.pages,
          params: [
            { wildcard_uri: wildcard, group: PUBLIC_GROUP, sort: 'updated', order: 'asc', limit: PAGE_SIZE },
            { uri: site, group: PUBLIC_GROUP, sort: 'updated', order: 'asc', limit: PAGE_SIZE },
          ],
        },
      };
    } catch (err) {
      warn(`wildcard_uri search failed (${err.message}) — falling back to per-URI queries.`);
      warnings.push(`wildcard_uri search failed and the per-URI fallback was used: ${err.message}`);
    }
  } else {
    warnings.push('Per-URI fallback was forced with --force-per-uri; wildcard_uri was not attempted.');
  }

  // Fallback: one query per published page, derived from the repo's .md files,
  // at its builder URL and at its Publish-era URL (pageUrls). A URL with no
  // annotations costs one empty query; a URL left out loses them.
  const files = await findMarkdownFiles();
  const urls = [...new Set(files.flatMap((f) => pageUrls(f, site)))].sort();
  log(`  public: per-URI fallback over ${urls.length} page URL(s) derived from repo .md files`);

  const rows = [];
  let pages = 0;
  for (const uri of urls) {
    const result = await searchAll(token, { uri, group: PUBLIC_GROUP }, { seenIds });
    rows.push(...result.rows);
    pages += result.pages;
    warnings.push(...result.warnings);
  }

  warnings.push(
    'Per-URI fallback only sees pages that exist as .md files in this repo at ' +
    'backup time. Annotations on deleted or renamed pages are NOT captured by ' +
    'this route (wildcard_uri would have caught them).',
  );

  return {
    rows,
    warnings,
    detail: {
      method: 'per-uri',
      pages,
      urlsQueried: urls.length,
      params: { uri: '<each published page URL>', group: PUBLIC_GROUP, sort: 'updated', order: 'asc', limit: PAGE_SIZE },
    },
  };
}

/** One private group, authenticated. */
async function collectGroup(token, group) {
  log(`  group ${group.id} (${group.label}): group=${group.id}`);
  const result = await searchAll(token, { group: group.id });
  return {
    rows: result.rows,
    warnings: result.warnings,
    detail: {
      method: 'group',
      groupLabel: group.label,
      pages: result.pages,
      params: { group: group.id, sort: 'updated', order: 'asc', limit: PAGE_SIZE },
    },
  };
}

// --- Retention -------------------------------------------------------------

/** Keep the newest `keep` backup files by filename date; delete the rest. */
async function pruneOldBackups(outDir, keep) {
  const entries = await fs.readdir(outDir);
  const backups = entries.filter((n) => BACKUP_FILE_RE.test(n)).sort().reverse();
  const doomed = backups.slice(keep);
  for (const name of doomed) {
    await fs.unlink(path.join(outDir, name));
    log(`  pruned ${name}`);
  }
  return { kept: backups.slice(0, keep), pruned: doomed };
}

// --- Main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // The registry first: nothing is fetched from Hypothes.is, written or pruned
  // until the book and every value taken from it are known.
  let book, source, legacySites, groups;
  try {
    ({ book, source } = await loadBook(REPO_ROOT));
    const domain = field(book, 'site.domain', isString, 'a hostname');
    legacySites = field(book, 'site.legacy_origins', (v) => Array.isArray(v) && v.every(isString), 'a list of origins');
    groups = field(
      book, 'annotations.hypothesis_groups',
      (v) => Array.isArray(v) && v.every((g) => isString(g?.id) && isString(g?.label)),
      'a list of { id, label }',
    );
    opts.site ??= `https://${domain}`;
  } catch (err) {
    exitOnRegistryError(err);
  }
  log(`Book: ${book.slug} (registry: ${source})`);

  const token = process.env.HYPOTHESIS_API_TOKEN;
  if (!token || !token.trim()) {
    console.error(
      '\nERROR: HYPOTHESIS_API_TOKEN is not set.\n\n' +
      'This script cannot back up the private groups without it, and a backup\n' +
      'missing those groups is worse than no backup because it looks complete.\n\n' +
      '  Locally:  export HYPOTHESIS_API_TOKEN=<token from https://hypothes.is/account/developer>\n' +
      '  In CI:    add it as the repository secret HYPOTHESIS_API_TOKEN\n' +
      '            (Settings -> Secrets and variables -> Actions)\n',
    );
    process.exit(1);
  }

  // A rejected token does NOT 401 — group searches just come back empty with
  // HTTP 200. Verify the token is actually recognised before we trust any zero.
  log('Verifying token against /api/profile ...');
  const profile = await apiGet(token.trim(), '/profile');
  if (!profile.userid) {
    console.error(
      '\nERROR: the Hypothes.is API rejected HYPOTHESIS_API_TOKEN.\n\n' +
      '/api/profile returned userid: null, which is how this API reports a bad\n' +
      'or expired token (it does not return 401). Group searches with this token\n' +
      'would silently return zero annotations and produce an empty backup that\n' +
      'looks successful.\n\n' +
      'Mint a fresh token at https://hypothes.is/account/developer and update\n' +
      'the HYPOTHESIS_API_TOKEN repository secret.\n',
    );
    process.exit(1);
  }
  log(`  authenticated as ${profile.userid}`);

  const profileGroupIds = new Set((profile.groups ?? []).map((g) => g.id));
  const globalWarnings = [];
  for (const group of groups) {
    if (!profileGroupIds.has(group.id)) {
      const msg =
        `The account ${profile.userid} is not a member of group ${group.id} ` +
        `(${group.label}). That scope will come back EMPTY rather than erroring.`;
      warn(msg);
      globalWarnings.push(msg);
    }
  }

  // Collect every scope. One scope failing must not cost us the others, so we
  // record the failure, keep going, and exit non-zero at the end.
  const scopes = {};
  const scopeMeta = {};
  let hadFailure = false;

  log(`\nCollecting scopes (site: ${opts.site}) ...`);

  const jobs = [
    { key: 'public', label: `public layer for ${opts.site}`, run: () => collectPublic(token.trim(), opts) },
    ...legacySites.filter((site) => site !== opts.site).map((site) => ({
      key: `public-legacy:${new URL(site).host}`,
      label: `public layer left on the former domain ${site}`,
      run: () => collectPublic(token.trim(), { ...opts, site }),
    })),
    ...groups.map((g) => ({
      key: `group:${g.id}`,
      label: `group ${g.id} (${g.label})`,
      run: () => collectGroup(token.trim(), g),
    })),
  ];

  for (const job of jobs) {
    try {
      const { rows, warnings, detail } = await job.run();
      scopes[job.key] = rows;
      scopeMeta[job.key] = {
        label: job.label,
        count: rows.length,
        ok: true,
        ...detail,
        warnings,
      };
      for (const w of warnings) warn(`${job.key}: ${w}`);
      if (rows.length === 0) {
        const msg = '0 annotations. Expected if genuinely empty; check group membership if not.';
        warn(`${job.key}: ${msg}`);
        scopeMeta[job.key].warnings.push(msg);
      }
      log(`  -> ${rows.length} annotation(s)`);
    } catch (err) {
      hadFailure = true;
      scopes[job.key] = [];
      scopeMeta[job.key] = {
        label: job.label,
        count: 0,
        ok: false,
        error: err.message,
        warnings: [],
      };
      console.error(`ERROR collecting ${job.key}: ${err.message}`);
    }
  }

  const runDate = utcDateStamp();
  const payload = {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runDate,
      generatedBy: 'quartz-book automation/scripts/backup-annotations.mjs',
      api: API_BASE,
      book: book.slug,
      site: opts.site,
      account: profile.userid,
      complete: !hadFailure,
      totalAnnotations: Object.values(scopes).reduce((n, rows) => n + rows.length, 0),
      scopes: scopeMeta,
      warnings: globalWarnings,
      github: process.env.GITHUB_RUN_ID
        ? {
            repository: process.env.GITHUB_REPOSITORY ?? null,
            runId: process.env.GITHUB_RUN_ID,
            runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
            workflow: process.env.GITHUB_WORKFLOW ?? null,
          }
        : null,
    },
    scopes,
  };

  log('\nSummary:');
  for (const [key, m] of Object.entries(scopeMeta)) {
    log(`  ${key.padEnd(30)} ${String(m.count).padStart(6)}  ${m.ok ? m.method : `FAILED: ${m.error}`}`);
  }
  log(`  ${'TOTAL'.padEnd(30)} ${String(payload.meta.totalAnnotations).padStart(6)}`);

  if (opts.dryRun) {
    log('\n--dry-run: nothing written.');
    process.exit(hadFailure ? 2 : 0);
  }

  // Same-day re-run overwrites that day's file.
  await fs.mkdir(opts.outDir, { recursive: true });
  const outFile = path.join(opts.outDir, `annotations-${runDate}.json`);
  await fs.writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`\nWrote ${outFile}`);

  const { kept, pruned } = await pruneOldBackups(opts.outDir, opts.keep);
  log(`Retention: keeping ${kept.length} file(s), pruned ${pruned.length}.`);

  if (hadFailure) {
    console.error(
      '\nOne or more scopes FAILED. The backup file was still written so the ' +
      'scopes that did succeed are not lost, but it is INCOMPLETE ' +
      '(meta.complete = false). Exiting non-zero.',
    );
    process.exit(2);
  }
}

// Run only as a script: the tests import the URL functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`\nFATAL: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
