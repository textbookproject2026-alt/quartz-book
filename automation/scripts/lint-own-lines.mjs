#!/usr/bin/env node
// automation/scripts/lint-own-lines.mjs (quartz-book)
//
// A reader's proposal is judged on its own lines only (book-lint.yml, on a
// proposed-edits/* pull request). markdownlint-cli2 runs over the files the
// proposal changes; this keeps the problems on lines the proposal added or
// changed, and fails on those. A problem elsewhere in the file was already on
// drafts: it's shown as a notice, and it's the authors' to fix, not the reader's.
//
// Run:  node lint-own-lines.mjs <git diff -U0 output> <markdownlint-cli2 output>
// Exit: 1 if the proposal's own lines have a problem, else 0.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** { file: Set(new line numbers) } from a `git diff -U0` patch. */
export function changedLines(diff) {
  const out = {};
  let file = null;
  for (const line of diff.split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      file = f[1];
      out[file] ??= new Set();
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let n = start; n < start + count; n++) out[file].add(n);
    }
  }
  return out;
}

/** markdownlint-cli2's default output lines: "file:line[:col] MD000/name text". */
export function problems(output) {
  return output
    .split('\n')
    .map((l) => /^(.+?):(\d+)(?::\d+)? (MD\d{3}\S*) (.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map(([, file, line, rule, text]) => ({ file, line: Number(line), rule, text }));
}

/** The problems on the proposal's own lines, and the rest. */
export function split(diff, output) {
  const own = changedLines(diff);
  const mine = [];
  const others = [];
  for (const p of problems(output)) (own[p.file]?.has(p.line) ? mine : others).push(p);
  return { mine, others };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mine, others } = split(readFileSync(process.argv[2], 'utf8'), readFileSync(process.argv[3], 'utf8'));
  const msg = (p) => `${p.rule} ${p.text}`.replace(/\r?\n/g, ' ');
  for (const p of others)
    console.log(`::notice file=${p.file},line=${p.line}::Already on drafts, not from this proposal: ${msg(p)}`);
  for (const p of mine) console.log(`::error file=${p.file},line=${p.line}::${msg(p)}`);
  console.log(
    `${mine.length} formatting problem(s) on the lines this proposal changes; ${others.length} elsewhere in those files, not counted.`,
  );
  process.exit(mine.length ? 1 : 0);
}
