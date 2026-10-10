// Step 1 of build-book.sh: read the book and the registry, refuse what the
// builder won't build, stage the book's files for Quartz, and render the
// book's Quartz config.
//
//   node builder/prepare.mjs <book checkout> <branch> <work dir> [registry.json]
//
// PREVIEW=1 makes the build a noindex preview even on the live branch
// (build-book.sh --preview, §4b).
//
// Without a registry file it fetches the registry's main (§0), so a registry
// change reaches the book at its next build.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import YAML from "yaml"
import {
  ALLOWLIST,
  BuildRefused,
  COMMIT_INFO_FORMAT,
  GIT_LOG_FORMAT,
  HISTORY_COMMITS,
  HOW_TO_COMMENT,
  REGISTRY_URL,
  bookOptions,
  bookContents,
  contentsOrder,
  findBook,
  howToCommentClash,
  ignorePatternsFor,
  parseCommitInfo,
  parseFollowLog,
  parseGitLog,
  parseLsTree,
  registryDigest,
  renderConfig,
  revisionsOf,
  HISTORY_PAGE,
  creatorsOf,
  editorsOf,
  historyData,
  historyPageMarkdown,
  pageTitle,
  platformPeopleOf,
  setPlatform,
} from "./lib.mjs"
import { isAutomation } from "../automation/scripts/lib/credits.mjs"
import { quartzUrl } from "../automation/scripts/backup-annotations.mjs"

/** The book's declined items from the function (batch 2c); [] when it can't be asked. */
async function fetchDeclined(revisionEndpoint) {
  try {
    const url = new URL("history", revisionEndpoint)
    url.searchParams.set("book", new URL(revisionEndpoint).searchParams.get("book") ?? "")
    url.searchParams.set("declined", "1")
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    return Array.isArray(d?.declined) ? d.declined : []
  } catch (err) {
    console.warn(`prepare: declined items not read (${err.message}); the page's script asks again`)
    return []
  }
}

const BUILDER = resolve(import.meta.dirname, "..")
const [bookDir, branch, workDir, registryFile] = process.argv.slice(2)

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

async function readRegistry() {
  if (registryFile) return JSON.parse(readFileSync(registryFile, "utf8"))
  const res = await fetch(REGISTRY_URL)
  if (!res.ok) throw new Error(`fetching the registry from ${REGISTRY_URL} answered ${res.status}.`)
  return res.json()
}

try {
  if (!bookDir || !branch || !workDir)
    throw new BuildRefused("usage: prepare.mjs <book checkout> <branch> <work dir> [registry.json]")
  const book = resolve(bookDir)
  if (!existsSync(join(book, ".git"))) throw new BuildRefused(`${book} is not a git checkout.`)

  const config = JSON.parse(readFileSync(join(book, "textbook.config.json"), "utf8"))
  const registry = await readRegistry()
  setPlatform(platformPeopleOf(registry))
  const entry = findBook(registry, config.slug)
  const opts = bookOptions(registry, entry, branch, { preview: process.env.PREVIEW === "1" })

  // The marker names the book commit, so what is built must be that commit.
  const dirty = git(book, "status", "--porcelain", "--", ...ALLOWLIST)
  if (dirty)
    throw new BuildRefused(
      `the book checkout has uncommitted changes in published files, so the build marker would name the wrong commit:\n${dirty}`,
    )

  const entries = readdirSync(book)
  const clash = howToCommentClash(entries)
  if (clash)
    throw new BuildRefused(
      `the book has its own "${clash}", but /${clash.replace(/\.md$/i, "").toLowerCase()} is a page the builder adds to every book. Rename or remove the book's file.`,
    )

  // Quartz reads a copy, so the checkout is never written to. The copy keeps the
  // whole tree (ignorePatterns do the excluding, §0) and gains the builder's page.
  const content = join(workDir, "content")
  mkdirSync(workDir, { recursive: true })
  cpSync(book, content, {
    recursive: true,
    filter: (src) => !src.startsWith(join(book, ".git") + "/") && src !== join(book, ".git"),
  })
  let page = readFileSync(join(BUILDER, "builder/pages/how-to-comment.md"), "utf8")
  if (opts.editionTemplateRepo)
    page += `\n---\n\n*Course coordinators: briefing notes for students are in [the department edition template's guide](https://github.com/${opts.editionTemplateRepo}/blob/main/docs/for-course-coordinators.md).*\n`
  writeFileSync(join(content, `${HOW_TO_COMMENT}.md`), page)

  const shared = YAML.parse(readFileSync(join(BUILDER, "quartz.config.yaml"), "utf8"))
  // The Contents lists every page the explorer shows: any it misses is added at
  // its end in the copy Quartz reads (completeContents), so the front page and
  // the explorer, which follows the Contents, always show the same pages.
  const indexFile = join(book, "index.md")
  let indexText = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : ""
  if (indexText) {
    const completed = bookContents(
      indexText,
      git(book, "ls-files", "-z", "--", ...ALLOWLIST).split("\0"),
      (path) => readFileSync(join(book, path), "utf8"),
    )
    if (completed.added.length) {
      indexText = completed.text
      writeFileSync(join(content, "index.md"), indexText)
      console.log(
        `prepare: added to the Contents, not in index.md's: ${completed.added.join(", ")}`,
      )
    }
  }
  const order = contentsOrder(indexText)
  // The commit, and each published file's blob, the pages are built from.
  const bookCommit = git(book, "rev-parse", "HEAD")
  const sourceBlobs = parseLsTree(git(book, "ls-tree", "-r", "-z", "HEAD", "--", ...ALLOWLIST))
  const rendered = renderConfig(
    shared,
    { ...opts, sourceCommit: bookCommit, sourceBlobs },
    ignorePatternsFor(entries),
    order,
  )
  // CI's layout checks only: the annotation sidebar's layout is still checked on
  // every width, so they build with a Hypothes.is client (the public layer, as
  // editions have). A book's real build never sets this.
  if (process.env.TB_LAYOUT_ANNOTATIONS === "public") {
    const ei = rendered.plugins.find((p) => p.source?.name === "edition-integrations")
    if (ei) ei.options.publicAnnotations = true
  }
  writeFileSync(join(workDir, "quartz.config.yaml"), YAML.stringify(rendered))

  const builderDirty = git(BUILDER, "status", "--porcelain", "--untracked-files=no") !== ""
  const facts = {
    ...opts,
    bookCommit,
    // When the content being built was committed: every page's "published" date.
    bookCommitDate: git(book, "show", "-s", "--format=%cI", "HEAD"),
    builderCommit: git(BUILDER, "rev-parse", "HEAD") + (builderDirty ? "-dirty" : ""),
    registryDigest: registryDigest(registry, entry),
    platformPeople: platformPeopleOf(registry),
    status: entry.status,
    contentsOrder: order,
  }
  writeFileSync(join(workDir, "facts.json"), JSON.stringify(facts, null, 2) + "\n")

  // The recent history of the published files, for the catalog's recent
  // changes. A shallow checkout gives what it has; its boundary commits are
  // dropped because they show every file as added.
  const log = git(
    book,
    "log",
    `-n${HISTORY_COMMITS}`,
    "-M",
    "--name-status",
    "-z",
    `--format=${GIT_LOG_FORMAT}`,
    "--",
    ...ALLOWLIST,
  )
  const shallowPath = resolve(book, git(book, "rev-parse", "--git-path", "shallow"))
  const shallow = existsSync(shallowPath)
    ? readFileSync(shallowPath, "utf8").split(/\s+/).filter(Boolean)
    : []
  const commits = parseGitLog(log, shallow)
  writeFileSync(join(workDir, "history.json"), JSON.stringify(commits) + "\n")
  // Each page's revisions (the History panel), from the whole history: the
  // workflows check books out in full for this. A shallow checkout would cut
  // every list short, so it's refused rather than published incomplete.
  if (shallow.length)
    throw new BuildRefused(
      "the book checkout is shallow, so page histories would be cut short. Fetch the whole history (no --depth).",
    )
  const automation = isAutomation(platformPeopleOf(registry))
  const info = parseCommitInfo(
    git(book, "log", "--no-merges", "-z", `--format=${COMMIT_INFO_FORMAT}`),
  )
  const revisions = {}
  for (const file of git(book, "ls-files", "-z", "--", ...ALLOWLIST).split("\0")) {
    if (!file.endsWith(".md")) continue
    const follow = git(
      book,
      "log",
      "--follow",
      "--no-merges",
      "-M",
      "--name-status",
      "-z",
      "--format=%x1e%H",
      "--",
      file,
    )
    revisions[file] = revisionsOf(parseFollowLog(follow), info, automation)
  }
  writeFileSync(join(workDir, "revisions.json"), JSON.stringify(revisions) + "\n")

  // The book's version history (batch 2a): each page's commits on the live
  // branch (Published) and on drafts but not yet live (Being edited), and the
  // releases (v* tags). The workflows fetch the live and drafts branches and the
  // tags beside the commit being built; a branch that isn't there is left out
  // with a note, never guessed.
  const refOk = (ref) => {
    try {
      return git(book, "rev-parse", "--verify", "-q", `${ref}^{commit}`)
    } catch {
      return null
    }
  }
  const live = entry.content.live_branch
  const draftsBranch = entry.content.drafts_branch
  const liveRef =
    branch === live
      ? "HEAD"
      : refOk(`refs/remotes/origin/${live}`)
        ? `refs/remotes/origin/${live}`
        : null
  const draftsRef = !draftsBranch
    ? null
    : branch === draftsBranch
      ? "HEAD"
      : ([`refs/remotes/origin/${draftsBranch}`, `refs/heads/${draftsBranch}`].find(refOk) ?? null)
  if (!liveRef)
    console.log(`prepare: no ${live} beside the build, so the history has no published versions`)
  if (draftsBranch && !draftsRef)
    console.log(
      `prepare: no ${draftsBranch} beside the build, so the history has nothing being edited`,
    )
  const lsMd = (ref) =>
    ref
      ? git(book, "ls-tree", "-r", "-z", "--name-only", ref, "--", ...ALLOWLIST)
          .split("\0")
          .filter(
            (f) => f.endsWith(".md") && !f.startsWith("community/") && !f.startsWith("assets/"),
          )
      : []
  const historyFiles = [...new Set([...lsMd(liveRef), ...lsMd(draftsRef)])].sort()
  const allInfo = parseCommitInfo(
    git(
      book,
      "log",
      "--no-merges",
      "-z",
      `--format=${COMMIT_INFO_FORMAT}`,
      ...[liveRef, draftsRef].filter(Boolean),
    ),
  )
  const follow = (range, file) =>
    revisionsOf(
      parseFollowLog(
        git(
          book,
          "log",
          "--follow",
          "--no-merges",
          "-M",
          "--name-status",
          "-z",
          "--format=%x1e%H",
          range,
          "--",
          file,
        ),
      ),
      allInfo,
      automation,
    ).map((r) => ({ ...r, body: allInfo.get(r.sha)?.body ?? "" }))
  const releases = git(
    book,
    "for-each-ref",
    "--format=%(refname:short)%09%(creatordate:iso-strict)%09%(*objectname)%09%(objectname)",
    "refs/tags/v*",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, date, peeled, own] = line.split("\t")
      return { tag, date, commit: peeled || own }
    })
  const readAt = (ref, file) => {
    try {
      return git(book, "show", `${ref}:${file}`)
    } catch {
      return null
    }
  }
  const frontOf = (text) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "")
    try {
      const fm = m ? YAML.parse(m[1]) : {}
      return fm && typeof fm === "object" && !Array.isArray(fm) ? fm : {}
    } catch {
      return {}
    }
  }
  const indexFm = frontOf(readAt(liveRef ?? draftsRef ?? "HEAD", "index.md"))
  const bookPeople = { creators: creatorsOf(indexFm), editors: editorsOf(indexFm) }
  const historyFilesData = {}
  const historyPages = {}
  for (const file of historyFiles) {
    const text = readAt(liveRef ?? "HEAD", file) ?? readAt(draftsRef, file) ?? ""
    const fm = frontOf(text)
    const creators = creatorsOf(fm)
    const editors = editorsOf(fm)
    historyPages[file] = {
      url: quartzUrl(file, ""),
      title: pageTitle(text, file),
      people: {
        creators: creators.length ? creators : bookPeople.creators,
        editors: editors.length ? editors : bookPeople.editors,
      },
    }
    historyFilesData[file] = {
      published: liveRef ? follow(liveRef, file) : [],
      drafts: liveRef && draftsRef ? follow(`${liveRef}..${draftsRef}`, file) : [],
      releases: Object.fromEntries(
        releases.map((r) => [
          r.tag,
          git(book, "log", "-1", "--format=%H", r.commit, "--", file) || null,
        ]),
      ),
    }
  }
  // What the authors declined (batch 2c): the function's /api/history, read with the
  // App; the build has no GitHub access of its own. Without an answer the history
  // still builds, and the page's script asks again when it is opened.
  const declined = facts.revisionEndpoint ? await fetchDeclined(facts.revisionEndpoint) : []
  const history = historyData({ files: historyFilesData, pages: historyPages, releases, declined })
  writeFileSync(join(workDir, "history-data.json"), JSON.stringify(history) + "\n")
  // The marker's other_commit: the other branch's head, as fetched beside the build.
  const otherRef = branch === live ? draftsRef : branch === draftsBranch ? liveRef : null
  facts.otherCommit = otherRef ? (refOk(otherRef) ?? "") : ""
  writeFileSync(join(workDir, "facts.json"), JSON.stringify(facts, null, 2) + "\n")
  writeFileSync(
    join(content, `${HISTORY_PAGE}.md`),
    historyPageMarkdown(history, { repo: entry.content.repo }),
  )
  console.log(
    `prepare: ${facts.slug} @ ${facts.branch} (${facts.bookCommit.slice(0, 7)}), ${facts.noindex ? "preview, noindex" : "live branch"}, suggest ${facts.suggestEndpoint ? "on" : "off"}`,
  )
} catch (err) {
  console.error(`build-book: ${err instanceof BuildRefused ? "refused: " : ""}${err.message}`)
  process.exit(err instanceof BuildRefused ? 2 : 1)
}
