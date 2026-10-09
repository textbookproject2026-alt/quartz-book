# quartz-book

The shared builder for the platform's books. Every book is built by this one copy of
Quartz, with one configuration, from the book's own repository, which holds only the
book (BOOK-ONE-TO-QUARTZ §0, decision D1, in `textbook-registry/design/`).

**Every platform book is built by this repository.** If it is deleted, renamed or made
private, no book rebuilds, and the last deployment of each keeps serving. Treat it as
production infrastructure.

- **The plan:** `design/BOOK-ONE-TO-QUARTZ.md` in `textbookproject2026-alt/textbook-registry`.
  This repo is §8 steps 8 (the build), 9 (`reconcile`) and 11 (the design preview gate).
- **The registry:** `registry.json` in the same repo. The builder reads it from `main` at
  every build.
- **The platform's plugins:** `textbookproject2026-alt/quartz-edition-extras`, pinned in
  `quartz.lock.json`.
- **Service inventory:** `docs/INFRASTRUCTURE.md` in `textbook-registry`.

**What starts it.** The `build-nudge` Worker (§8 step 10) starts `reconcile` on a
book's push and every 15 minutes. `reconcile` also runs by hand, below.

---

## Building a book

```
npm ci
npx quartz plugin install
./build-book.sh <book checkout> --branch <branch> [--out <dir>] [--registry <registry.json>]
```

`<book checkout>` is a git checkout of the book's repository at the commit to build. The
builder only reads it. `--branch` says which branch the build is for. `--out` defaults
to `public/`. Without `--registry`, the registry is fetched from its `main`.

For example, a request-made book:

```
git clone https://github.com/textbookproject2026-alt/ontology-for-social-research-a-criti.git ../book
./build-book.sh ../book --branch main --out public
```

A retired book (book one, `social-research-methods`, since 27 Sep 2026) is refused.

Exit status: `0` built, `2` refused (below), anything else a failed build.

### What a build does

1. **Reads the book's slug** from its `textbook.config.json`, and everything else from
   the book's registry entry: the title, `site.domain`, `content.repo`, the live branch,
   the Plausible script, the licence and whether suggest-edit is on. This replaces the
   book repo's `configure.mjs` and `templates/publish.js` for the site. A registry change
   reaches the book at its next build.
2. **Refuses** a `retired` book, a slug the registry doesn't have, a checkout with
   uncommitted changes to published files (the marker would name the wrong commit), and
   a book with its own file at `/how-to-comment`.
3. **Renders this book's Quartz config** from the shared `quartz.config.yaml`, filling in
   the lines marked `SET PER BOOK`:
   - `edit-on-github`: `repo`, `branch` (the branch being built), **`contentDir: ""`**
     (a book is built from its repo root, so its Edit links must not gain the plugin's
     default `content/` prefix), and **`suggestEndpoint`**: the registry's
     `platform.suggest_edit_endpoint` when the book has `suggest_edit.enabled`, and `""`
     otherwise, which hides the button; and **`revisionEndpoint`**, the same function's
     `/api/page-revision?book=<slug>`, for every book (the History panel).
   - `edition-integrations`: `plausibleScriptSrc`, the platform's one Plausible site
     (`platform.analytics.plausible`, D19) for a `live` book and `""` for any other, and
     `siteDomain`, so Plausible counts only on the book's own domain, never on `pages.dev`
     or `localhost`. A registry without `platform.analytics` is refused (`null` means no
     analytics anywhere); a book's own `analytics` field is never read.
   - `baseUrl`, `pageTitle`, the footer's licence link, and `ignorePatterns`.
4. **Builds with an allowlist** (D3). Only `index.md`, `chapters/`, `assets/`,
   `glossary.md` and `community/` are published. Everything else at the top of the book
   repo goes into `ignorePatterns`, because Quartz copies every non-Markdown file it
   finds. Quartz builds from a copy of the checkout, with the builder's
   **`/how-to-comment`** page added (D5).
5. **Adds**:
   - `_redirects` (D14): a 301 from each page's Obsidian Publish address to its Quartz
     address wherever they differ, in both the `+` and `%20` spellings of a space, plus
     `/docs/how-to-comment` and `/docs/for-course-coordinators`.
   - `_headers` with `X-Robots-Tag: noindex` on every path, for any branch but the live
     one (D13).
   - `<link rel="canonical">` on `site.domain` in every page, marked
     `data-builder="quartz-book"` so Quartz's popovers don't read it as an alias redirect.
   - The build marker, `/.well-known/textbook.json`: the slug, the branch, the book
     commit, a digest of the book's registry entry (and the one platform value a build
     reads, the suggest-edit endpoint), and the builder commit. It has no timestamp, so
     the same inputs give the same marker.
   - The catalog, `/.well-known/textbook-catalog.json`, which the portal reads at its
     own build: every page with its title, tags, authors, whether it is a concept page,
     and its links to the book's other pages; the book's authors; and its recent
     changes. See _The catalog_ below.
   - Each page's revision list, `/.well-known/history/<slug>.json`, for the History
     panel in the page's controls row: `git log --follow` on the branch being built,
     newest first (sha, date, who, message, the path then). "Who" is a person's GitHub
     login when the commit carries their noreply address, else git's name (as the
     Contributors page); an App or bot commit is its human `Co-authored-by` people, an
     anonymous in-site proposal is "a reader" (the function's `/api/page-revision`
     gives the name the proposal used when the revision is opened), and anything else
     is "automation". The book must be checked out **in full**: a shallow checkout is
     refused, since every list would stop short. Every book gets the panel: the
     `edit-on-github` option `revisionEndpoint` is set from
     `platform.suggest_edit_endpoint`, whatever `suggest_edit.enabled` says.
   - **`/.well-known/history.json`** (batch 2a): the book's version history, per page its
     commits on the live branch (Published) and on drafts but not yet live (Being
     edited), each with date, person, role, summary and pull request, and the releases
     (`v*` tags) with the page's version at each. Built from the live and drafts
     branches and the tags, which the workflows fetch beside the commit; the marker's
     `other_commit` (the other branch's head) makes a build stale when either moves.
   - **`/history`**, the book's history page beside `/how-to-comment`: a static SVG
     swimlane (Proposed, Being edited, Published, releases as rules) that works without
     scripts, the releases, and a list of recent changes; edit-on-github fills in the
     filterable timeline and what is proposed.
6. **Checks the output against the allowlist.** Any file that is neither from an
   allowlisted path nor generated by Quartz or the builder fails the build.
   `node builder/check-output.mjs <dir>` runs the same check on its own.

Quartz reads `quartz.config.yaml` only from its working directory, so the build runs in
a scratch directory that holds the rendered config and links everything else back here.

## Deploying: `reconcile`

`.github/workflows/reconcile.yml` (§0a, §8 step 9) builds and deploys every book whose
served build marker is behind. For each book on the builder (registry
`site.host.builder: "quartz-book"`) and each of its two branches, it compares
`/.well-known/textbook.json` on Pages with what a build would give now: the branch
head, the digest of the book's registry entry, and this repo's commit. Where they
differ it builds, in a job with no secrets, then deploys with `wrangler pages deploy`
in a separate job that holds the Cloudflare token, and checks that Pages serves the
new marker. A run with nothing to do deploys nothing.

- **Run it by hand:** Actions → **reconcile** → **Run workflow**, branch `main`.
  Leave `slug` empty for every book. It is always safe to run again.
- **Where it deploys:** the book's Pages project, `site.host.project`, in the
  platform's Cloudflare account. The live branch is the project's production branch,
  on `<project>.pages.dev`; `drafts` is on `drafts.<project>.pages.dev`, with
  `X-Robots-Tag: noindex`.
- **Only a run from `main` deploys**, and it builds with the builder at the **`stable`
  tag**, not at `main`'s head (below). From any other branch it builds with that
  branch's own commit, checks, and stops there.
- **Concurrency:** one build per book and branch at a time, never cancelled.
- **A failed build** deploys nothing: the previous deployment keeps serving, and the
  run is red.
- **Secrets:** `CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit, the platform's account
  only) and `CLOUDFLARE_ACCOUNT_ID`. Only the deploy job reads them.
- **Drafts kept current** (`builder/sync-drafts.mjs`, 06 Oct): the run's first job
  brings each book's `drafts` up to its live branch, so the in-site editor and the
  author site never edit text older than the published page. Already current: no
  write at all. Behind: a fast-forward. Both moved: a merge commit by the App. A
  conflict writes nothing and shows up in the book's *Changes outside drafts* issue.
  It pushes as the books App in the books org and as the `quartz-book bot` App in
  `textbookproject2026-alt` (both with Contents write), and `build-nudge` ignores
  those Apps' pushes to a drafts branch, so a sync never starts another run; the
  plan, after it, builds the new head. A book neither App can reach is a warning.
- **Which books:** every entry with `site.host.builder: "quartz-book"`, whatever its
  host kind. On an `obsidian-publish` host (book one until its cutover), the Pages
  project is a preview only: readers are still served by Publish at `site.domain`.

## The design preview gate and `stable`

A change to the builder, or to the extras pin, reaches every book at once (§4b). So
it is previewed on every book before it reaches any.

- **The bot pull request.** On the Worker's 15-minute tick, `reconcile` asks whether
  `quartz-edition-extras`' `main` is ahead of the pin in `quartz.lock.json`. If it is,
  and no pull request for that extras commit was ever opened, it starts
  `bump-extras.yml`. That moves every extras plugin to the one commit on the branch
  `bot/extras-<commit>` and opens a pull request, whose preview and CI start on their
  own. It closes any older `bot/extras-*` pull request still open, so an older pin
  can't be merged after a newer one. Closing the pull request unmerged keeps the old
  pin; the bot won't reopen it. By hand:
  Actions → **bump-extras** → Run workflow, branch `main`, `commit` empty for extras'
  `main`.
- **The preview.** `design-preview.yml` runs on every pull request into `main` (and is
  started by the bot for its own if it had to fall back to `GITHUB_TOKEN`). It builds
  each book on the builder, from the book's
  live branch, with the pull request's builder commit, as a `noindex` preview
  (`build-book.sh --preview`), and uploads it to the book's Pages project on the
  branch **`design-<pr>`**: `https://design-<pr>.<project>.pages.dev/`. Then it posts
  one comment on the pull request with a link per book, and updates it on each push.
  It never deploys any other branch name, so no book's production changes. A pull
  request from a fork builds but isn't deployed or commented on.
- **`stable`.** The tag `reconcile` builds from. When `ci` passes on a push to `main`,
  `stable.yml` moves `stable` to that commit and starts `reconcile` (run name
  `reconcile: stable, every book`), so every book's marker names the new builder
  commit within that one run. It only moves forward on its own. If the tag push fails
  four times, the run fails and opens (or comments on) the issue **stable did not
  move**, which closes itself the next time `stable` moves.
- **Rollback.** Actions → **stable** → Run workflow, branch `main`, `commit` the commit
  to go back to. `reconcile` rebuilds every book with it. It holds until the next merge
  to `main` passes CI, so revert or fix the bad change on `main` first.
- **If `stable` is missing,** every `reconcile` run from `main` stops at its first step
  and says so. Run **stable** by hand with `main`'s head.
- **Needs** the repository setting _Allow GitHub Actions to create and approve pull
  requests_ (Settings → Actions → General), and the **`quartz-book bot`** GitHub App:
  - Why: `main` requires the `build` check. A pull request opened with
    `GITHUB_TOKEN` gets its `pull_request` runs held until a person approves them,
    and a `build` from a dispatched run doesn't count on the pull request. Opened by
    an App, its `ci` and `design-preview` run at once and `build` counts.
  - The App: owned by `textbookproject2026-alt`, no webhook, repository permissions
    _Contents: Read and write_ and _Pull requests: Read and write_ (Metadata: read
    comes with them), installed on `quartz-book`, and on any book repo in
    `textbookproject2026-alt` (the books App can't be installed outside the books
    org): there it keeps `drafts` current. Give it _Issues: Read and write_ too and
    those books also get the branch check's issue. Not the suggest-edit App.
  - In `quartz-book` (Settings → Secrets and variables → Actions): the variable
    `BOT_APP_CLIENT_ID` (the App's Client ID) and the secret `BOT_APP_PRIVATE_KEY`
    (a private key generated on the App's page). `bump-extras` reads them, and
    `reconcile`'s drafts and branches jobs.
  - Without them, the bot falls back to `GITHUB_TOKEN`: it still opens the pull
    request and dispatches the preview and CI, warns, and the pull request waits for
    someone to approve its held runs (the pull request's Checks, **Approve and
    run**).

## Book automation

A book's weekly jobs and checks are reusable workflows here (BOOK-ONE-TO-QUARTZ §8
step 14, D6), with their scripts in `automation/`. GitHub runs a workflow only from the
repo it lives in, and the pull requests and pushes need the book's own
`GITHUB_TOKEN`, so each book keeps a caller of about ten lines with its own triggers.
The header of each workflow shows its caller.

| Workflow                      | Does                                                                                                  | Book one's caller                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `book-backup-annotations.yml` | Hypothes.is backup to the book's `backups` branch                                                     | `backup-annotations.yml`                               |
| `book-weekly-snapshot.yml`    | The `snapshot-YYYY-MM-DD` tag, when the live branch changed                                           | `weekly-snapshot.yml`                                  |
| `book-community-page.yml`     | `community/<page>.md` as an auto-merging pull request; `page:` contributors, dashboard or derivatives. Contributors also writes the credit ledger, `community/credits.json` | `contributors.yml`, `dashboard.yml`, `derivatives.yml` |
| `book-lint.yml`               | markdownlint, with `automation/.markdownlint-cli2.yaml` unless the book has its own                   | `lint.yml`                                             |
| `book-link-check.yml`         | lychee, ignoring `automation/.lycheeignore` (the book's address) plus the book's own list             | `link-check.yml`                                       |
| `book-decision-notice.yml`    | When a `proposed-edit` pull request or a `section-note` issue closes, one comment @mentioning the signed-in contributor: accepted or declined, the maintainer's last comment, the page | `decision-notice.yml` (textbook-template) |

- **Callers name `@stable`,** the same builder commit `reconcile` builds with, so a
  change here reaches the books' jobs when `stable` moves, after its pull request's CI.
  Each workflow fetches `automation/` at its `platform_ref` input, `stable` by default.
  A caller pointed at another ref for a trial must pass the same ref as `platform_ref`.
- **What they read:** the book's registry entry, found from `textbook.config.json`'s
  `slug` and checked against the repo the job runs in (`automation/scripts/lib/registry.mjs`).
  An unknown book, or a field missing, stops the job before anything is written.
- **Secrets:** `HYPOTHESIS_API_TOKEN`, in the book repo, for the backup and the
  dashboard. The caller passes it by name, because `secrets: inherit` doesn't cross
  organisations.
- **The weekly jobs work on the live branch** (`branch`, `main` by default) whichever
  ref started them, so a run by hand from another branch does what Sunday's run does.
- **Links on the generated pages** are full paths (`[[chapters/chapter-03|Chapter 3]]`,
  §2 #5), and the guides outside the book (`docs/for-trusted-contributors.md`, the
  edition template's `docs/department-edition-setup.md`) are GitHub links.
- **The backup's fallback** (used only when Hypothes.is refuses the wildcard query)
  asks for each page at its builder URL and, where different, its Publish-era URL
  (§3c). `test/automation.test.mjs` holds the first to Quartz's own slug function.

## What's here

| Path                                                                    | What                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quartz/`, `package.json`, `package-lock.json`, `tsconfig.json`, …      | Quartz v5, upstream `jackyzha0/quartz` at `9cf87ff` (the `v5` branch). The same Quartz as `textbook-edition-template`, unmodified                                                      |
| `quartz.config.yaml`                                                    | The one shared config. Graph on (D11), SPA off, dark mode off (D12), the home link to the portal first in the left sidebar on every page type                                          |
| `quartz.lock.json`                                                      | Every plugin's pinned commit, including the four extras plugins, all at one extras commit (§4b)                                                                                        |
| `build-book.sh`                                                         | The build, above                                                                                                                                                                       |
| `builder/lib.mjs`                                                       | Every decision the build makes, as pure functions                                                                                                                                      |
| `builder/citations.mjs`, `builder/csl/`                                 | The Cite dialog's citations, formatted at build time (citation-js, four vendored CSL styles)                                                                                          |
| `builder/export.mjs`, `.github/actions/export-tools/`                   | The downloads (PDF, EPUB, ODT) and their pinned pandoc and Typst                                                                                                                       |
| `builder/prepare.mjs`, `builder/finish.mjs`                             | The steps before and after Quartz                                                                                                                                                      |
| `builder/check-output.mjs`                                              | The allowlist check on its own                                                                                                                                                         |
| `builder/reconcile.mjs`                                                 | `reconcile`'s comparison: which books and branches are behind their served marker                                                                                                      |
| `builder/extras.mjs`, `builder/preview.mjs`                             | The extras pin bot's decisions, and the design preview's books and comment                                                                                                             |
| `builder/pages/how-to-comment.md`                                       | The reader page every book gets, from book one's `docs/how-to-comment.md`                                                                                                              |
| `fixtures/book/`                                                        | A small book used by the tests. `chapters/QA.md` is the design fixture, moved from book one (§4c)                                                                                      |
| `fixtures/registry.json`                                                | Three fixture books: suggest on, suggest off, and retired                                                                                                                              |
| `test/`                                                                 | `lib.test.mjs`, `catalog.test.mjs`, `export.test.mjs`, `preview.test.mjs` and `automation.test.mjs` (no Quartz), `citations.test.mjs` (citation-js), `build.test.mjs` (builds the fixture), `check-live-book.mjs` (picks a live book, checks its build) |
| `.github/workflows/ci.yml`                                              | Runs the tests, then builds the first `live` book on the builder (from the registry) and checks it. Deploys nothing                                                                    |
| `.github/workflows/reconcile.yml`, `reconcile-book.yml`                 | Builds and deploys the books that are behind (above)                                                                                                                                   |
| `.github/workflows/bump-extras.yml`, `design-preview.yml`, `stable.yml` | The design preview gate (above)                                                                                                                                                        |
| `.github/workflows/book-*.yml`, `automation/`                           | Book automation (above)                                                                                                                                                                |

## The catalog

`/.well-known/textbook-catalog.json` is what the portal knows about a book beyond its
registry entry. `builder/lib.mjs` (`buildCatalog`) shapes it; `catalog.test.mjs` pins it.

- **Tags** are Obsidian's: `tags:` (or `tag:`) in the frontmatter, and inline `#tags`,
  which Quartz finds. Compared without the `#`, in lower case. Nested tags (`a/b`) stay
  as written.
- **Concept pages**: `type: concept` in the frontmatter, the tag `concept`, or a page in
  a `Definitions/` or `Concepts/` folder (book one's `chapters/Definitions/` needs no
  change). `concept: false` overrides all three.
- **Authors**: `authors:` (a list, or `"A, B"`) or `author:` in a page's frontmatter.
  The book's authors are its `index.md`'s; failing that, every page's. With none, the
  portal shows the registry's maintainer.
- **Recent changes**: the last 60 commits touching published files, one entry per page
  at its latest change, `added` or `updated`, newest first, at most 25. Deleted pages
  are left out. `reconcile-book.yml` fetches the book 60 commits deep for this; a
  shallow clone's boundary commit is ignored, because it shows every file as added.

Like the marker, it has no timestamp of its own: the same inputs give the same file.
After a run that deployed a live branch, `reconcile` fires the portal's deploy hook
(`PORTAL_DEPLOY_HOOK`, optional) so the portal picks the change up.

## Metadata and citations

Every page of a book carries citation metadata, built from one model in
`builder/lib.mjs` (`bookMetadata`, `pageMetadata`; `catalog.test.mjs` pins it) and
added to the catalog as `metadata` (per page and for the book). Each field comes from
the most specific place that has it:

| Field | From |
| --- | --- |
| creators | `authors:`/`author:` (page, else index.md, else the registry's maintainer); each a name or `{ name, orcid }` |
| title | `title:`, else the first H1, else the file name; the book's from index.md, else the registry |
| publisher | registry `publisher`, else Confused for Now |
| created / published | `created:` / `published:`, else the file's first commit / the commit being built |
| summary | `summary:` or `description:`, else (front page) the registry's summary, else the first paragraph; under 300 characters |
| keywords | `keywords:` and the tags, without `concept` |
| type | `resource_type:` (book, chapter, paper, report, article, concept), else registry `type` on the front page, `concept` on concept pages, `chapter` elsewhere |
| lang, doi | `lang:` / `doi:`, else registry `lang` (else `en`) / `doi` (emitted only when set) |
| licence | registry `licence` (else CC-BY-SA-4.0), with its URL; always open access |

`finish.mjs` puts it in each page's head: Highwire Press tags (what Zotero and Google
Scholar read: a chapter saves as a book section, the front page as a book), Dublin
Core, and schema.org JSON-LD (`Book` on the front page, `Chapter` in the `Book`,
`DefinedTerm` on a concept page). Beside it, `<script id="tb-cite">` holds the page's
and the book's CSL-JSON and their citations in APA 7, Chicago author-date, MLA and
Harvard (Cite Them Right), formatted at build time by `builder/citations.mjs` with
citation-js and the styles in `builder/csl/`, for edit-on-github's Cite dialog.
The downloads (below) use the site's fonts: the families design.yaml names, fetched
by `.github/actions/export-tools` (`fetch-fonts.sh`) from their OFL upstream releases,
pinned and sha256-checked, each with its licence; a family the builder doesn't fetch
(`EXPORT_FONTS` in `lib.mjs`) falls back to the default font with a warning. An
author writes, for example:

```yaml
---
authors:
  - name: Brandon Sommer
    orcid: 0000-0002-1825-0097
  - Caroline Laschkolnig
summary: How ontology situates research methods.
keywords: [critical realism, methods]
resource_type: chapter
---
```

## Downloads

After the site, `builder/export.mjs` makes a PDF and an EPUB of each chapter (concept
pages aside) and a PDF, an EPUB and an ODT of the whole book, in `/downloads/`:
`<book>[-<chapter>]-<YYYY-MM-DD>.<ext>`, dated by the commit built, each with a
dateless alias (a 302 in `_redirects`) for linking. The page's ⋯ → Download menu
(edit-on-github) reads which exist from `<script id="tb-downloads">`, and the PDF is
the page's `citation_pdf_url`.

- **How:** markdown → `preprocessMarkdown` (wikilinks and concept links to their text,
  linked to the live page; embeds; images from the book's root, the converter's
  `<img>` widths kept; callouts as titled quotes; `%%comments%%` dropped) → pandoc
  (`commonmark_x`) → Typst for the PDF, pandoc itself for EPUB and ODT. Each starts
  with a front page: title, authors, publisher, published date, version (the short
  commit), address, licence and the APA citation. Fonts are design.yaml's (above):
  embedded in the PDF (Typst sees only them, `--ignore-system-fonts`) and the EPUB
  (only the faces its CSS uses), named in the ODT, which can't carry them.
- **Paragraph numbers** are in the PDF's margin, by the site's rule, only where the
  export numbers exactly as many paragraphs as the built page; a page that differs
  gets none, with a warning.
- **Never fails the build.** A file that can't be made, or is over 20 MiB, is left
  out with a `::warning::`, and the site publishes without it.
- **Tools:** pandoc 3.11 (the platform's pin), Typst 0.15.1 and the fonts, with
  checksums, in `.github/actions/export-tools`. Locally: `PANDOC=… TYPST=…`, or on the
  PATH, and `TB_FONTS=<dir>` filled by `fetch-fonts.sh <dir>`; without them a build
  has no downloads, or the default fonts, and says so.
- **Design previews** make downloads only when the pull request touches
  `builder/export.mjs` or the tools' pins; otherwise `TB_EXPORTS=off`.

## Credit

`community/credits.json` (generated, in the book repo) is the credit ledger: every
contributor and each accepted contribution (kind `edit`, `note`, `suggestion` or `commit`,
its reference, date of acceptance and the pages it touched), written with
`community/contributors.md` by `automation/scripts/gen-contributors.mjs` from the commits,
the merged `proposed-edit` pull requests and the `section-note` / `suggested-edit` issues
closed as completed (`automation/scripts/lib/credits.mjs` has the policy;
`lib/attribution.mjs` reads suggest-edit-function's attribution lines, for the decision
notice too). `community/credit-overrides.yml` (hide, rename, merge, no-credit) and the
`no-credit` label take people or items out.

At every build `finish.mjs` applies the overrides again (so a change shows at the next
build) and writes the credit onto the pages, outside `<article>` so annotations don't
move: a byline under each chapter's title ("By … · Edited by …"), "With contributions
from …" after the chapter, linked to its anchor on the contributors page, and a credits
block on the front page. The catalog gains `credits` and each page's `contributors`;
the head gains `DC.contributor` and JSON-LD `contributor`; the exports end with a
Contributors page. `community/credit-overrides.yml` is never published.

## Tests

```
node --test test/lib.test.mjs test/catalog.test.mjs test/citations.test.mjs test/credits.test.mjs test/export.test.mjs test/preview.test.mjs test/automation.test.mjs test/build.test.mjs
read -r slug repo branch < <(node test/check-live-book.mjs --pick)
git clone --depth 1 --branch "$branch" "https://github.com/$repo.git" ../live-book
./build-book.sh ../live-book --branch "$branch" --out /tmp/live-book-site
node test/check-live-book.mjs /tmp/live-book-site ../live-book "$slug"
```

## Changing things

- **Design values** (colours, fonts, sizes, print): not here. Edit `design.yaml` in
  `quartz-edition-extras` (BOOK-ONE-TO-QUARTZ §4c). The theme block in
  `quartz.config.yaml` is overridden by it.
- **The extras pin:** the bot does it (above), and every book rebuilds once its pull
  request merges and `stable` moves. To pin a particular extras commit, run
  **bump-extras** by hand with that commit. Locally, after a pin change, delete
  `.quartz/plugins` before `npx quartz plugin install`: it keeps a populated directory
  without checking the lock.
- **Anything else here** goes through a pull request too: its preview shows every book
  before `stable` moves.
- **Quartz itself:** merge from `upstream` (`jackyzha0/quartz`, branch `v5`), as the
  edition template does.

Quartz is © jackyzha0 and contributors, MIT licence (`LICENSE.txt`).
