// automation/scripts/lib/attribution.mjs (quartz-book)
//
// Who a proposed edit or a note is from, read from the attribution line
// suggest-edit-function writes into its pull request or issue body:
//
//   **Proposed by:** @login (signed in with GitHub)        propose-edit, signed in
//   **Proposed by:** `Name` (`m***@example.org`)          propose-edit, anonymous
//   **Proposed by:** a reader (`m***@example.org`)        propose-edit, no name
//   **Submitted by:** @login (signed in with GitHub)       suggest-edit, signed in
//   **Submitted by:** `Name`                              suggest-edit
//
// The one parser for it: the decision notice (who to tell) and the credit ledger
// (who to credit) both use it.

const LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}';
const SIGNED_IN = new RegExp(`^\\*\\*(?:Proposed|Submitted) by:\\*\\* @(${LOGIN}) \\(signed in with GitHub\\)\\s*$`, 'm');
// inlineCode fences the name with enough backticks, and pads it with a space when
// it starts or ends with one.
const NAMED = /^\*\*(?:Proposed|Submitted) by:\*\* (`+) ?(.+?) ?\1(?: \(|\s*$)/m;
const MAX_NAME = 80;

/**
 * { login } for a signed-in contributor, { name } for one who gave a name, or null
 * (no attribution line, or "a reader" with no name: nobody to credit or tell).
 */
export function attributionOf(body = '') {
  const text = String(body ?? '');
  const signed = SIGNED_IN.exec(text);
  if (signed) return { login: signed[1] };
  const named = NAMED.exec(text);
  const name = named?.[2].replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name ? { name } : null;
}

/** The signed-in contributor's login, or null: the decision notice @mentions only them. */
export const contributorOf = (body = '') => attributionOf(body)?.login ?? null;

/** The file(s) a proposal or note is about: its **File:** lines. */
export const filesOf = (body = '') =>
  [...String(body ?? '').matchAll(/^\*\*File:\*\* \[`([^`]+)`\]/gm)].map((m) => m[1]);
