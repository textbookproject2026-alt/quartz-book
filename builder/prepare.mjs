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
  GIT_LOG_FORMAT,
  HISTORY_COMMITS,
  HOW_TO_COMMENT,
  REGISTRY_URL,
  bookOptions,
  findBook,
  howToCommentClash,
  ignorePatternsFor,
  parseGitLog,
  registryDigest,
  renderConfig,
} from "./lib.mjs"

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
      `the book has its own "${clash}", but /${HOW_TO_COMMENT} is the page the builder adds to every book. Rename or remove the book's file.`,
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
    page += `\n---\n\n*Course coordinators: briefing notes for students, and the reasoning behind the\nsingle shared public margin, are in [the department edition template's guide](https://github.com/${opts.editionTemplateRepo}/blob/main/docs/for-course-coordinators.md).*\n`
  writeFileSync(join(content, `${HOW_TO_COMMENT}.md`), page)

  const shared = YAML.parse(readFileSync(join(BUILDER, "quartz.config.yaml"), "utf8"))
  const rendered = renderConfig(shared, opts, ignorePatternsFor(entries))
  writeFileSync(join(workDir, "quartz.config.yaml"), YAML.stringify(rendered))

  const builderDirty = git(BUILDER, "status", "--porcelain", "--untracked-files=no") !== ""
  const facts = {
    ...opts,
    bookCommit: git(book, "rev-parse", "HEAD"),
    builderCommit: git(BUILDER, "rev-parse", "HEAD") + (builderDirty ? "-dirty" : ""),
    registryDigest: registryDigest(registry, entry),
    status: entry.status,
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
  console.log(
    `prepare: ${facts.slug} @ ${facts.branch} (${facts.bookCommit.slice(0, 7)}), ${facts.noindex ? "preview, noindex" : "live branch"}, suggest ${facts.suggestEndpoint ? "on" : "off"}`,
  )
} catch (err) {
  console.error(`build-book: ${err instanceof BuildRefused ? "refused: " : ""}${err.message}`)
  process.exit(err instanceof BuildRefused ? 2 : 1)
}
