#!/usr/bin/env node
// automation/scripts/lychee-ignore.mjs (quartz-book)
//
// Prints the .lycheeignore a book's link check runs with: the platform's
// automation/.lycheeignore with __SITE_DOMAIN__ filled in from the book's
// registry entry, then the book's own .lycheeignore, if it has one, for
// anything particular to that book.
//
// The book's own address is skipped: the site is not up when the first links to
// it are written, and a checker cannot tell "not built yet" from "broken".
//
// If the address can't be found (the template itself, whose slug is blank, or the
// registry unreachable) the line is left out with a warning, never failing the
// check: a link to the book's own site that doesn't answer is only ever reported
// as a dead outside link, which doesn't fail the check either.
//
// Run:  node <quartz-book>/automation/scripts/lychee-ignore.mjs > .lycheeignore   (in the book's clone)
// Env:  BOOK_ROOT (default: the working directory), TEXTBOOK_REGISTRY as in lib/registry.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBook, field, isString } from './lib/registry.mjs';

const PLATFORM_IGNORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.lycheeignore');

/** The merged file: the platform's lines with the domain filled in (or that line dropped), then the book's. */
export function mergeIgnore(platform, own, domain) {
  const filled = domain
    ? platform.replaceAll('__SITE_DOMAIN__', domain)
    : platform.split('\n').filter((l) => !l.includes('__SITE_DOMAIN__')).join('\n');
  if (/__[A-Z0-9_]+__/.test(filled)) throw new Error(`automation/.lycheeignore has a token this script doesn't fill: ${filled.match(/__[A-Z0-9_]+__/)[0]}`);
  const parts = [filled.trimEnd()];
  if (own?.trim()) parts.push(`# From the book's own .lycheeignore\n${own.trimEnd()}`);
  return `${parts.join('\n')}\n`;
}

async function main() {
  const root = path.resolve(process.env.BOOK_ROOT || '.');
  let domain = null;
  try {
    const { book } = await loadBook(root);
    domain = field(book, 'site.domain', isString, 'a hostname');
  } catch (err) {
    console.error(`::warning::The book's own address isn't skipped by this link check: ${err.message}`);
  }
  const platform = await fs.readFile(PLATFORM_IGNORE, 'utf8');
  let own = null;
  try { own = await fs.readFile(path.join(root, '.lycheeignore'), 'utf8'); } catch { /* the book has none */ }
  process.stdout.write(mergeIgnore(platform, own, domain));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
