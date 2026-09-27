// build-book.sh end to end, on the fixture book (fixtures/book) and the fixture
// registry. Needs `npm ci` and `npx quartz plugin install` first. Each build takes
// a few seconds.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { after, test } from "node:test"
import { walkFiles } from "../builder/lib.mjs"

const ROOT = new URL("..", import.meta.url).pathname
const REGISTRY = join(ROOT, "fixtures/registry.json")
const scratch = mkdtempSync(join(tmpdir(), "quartz-book-test-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
/** A git checkout of the fixture book, as the given slug, with an optional change. */
function fixtureBook(slug, change = () => {}) {
  const dir = join(scratch, `book-${++n}`)
  cpSync(join(ROOT, "fixtures/book"), dir, { recursive: true })
  writeFileSync(join(dir, "textbook.config.json"), JSON.stringify({ slug }, null, 2) + "\n")
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  )
  change(dir)
  return { dir, head: git("rev-parse", "HEAD") }
}

/**
 * Which of the home link's logos (full, icon) a page shows at `width`, from its
 * built CSS: the last `display` given to `.home-link .home-link-<logo>` at the top
 * level, in an @layer, or in an @media whose min-/max-width the width meets.
 */
function logosShown(css, width) {
  const display = { full: "", icon: "" }
  const applies = (prelude) => {
    if (!prelude.startsWith("@media")) return true
    const cond = prelude.replace(/^@media\s*(all\s+and\s*)?/, "")
    const parts = [...cond.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)]
    if (parts.length === 0 || cond.replace(/\((min|max)-width:\s*\d+px\)|\s|and/g, "") !== "")
      return false
    return parts.every(([, m, px]) => (m === "min" ? width >= +px : width <= +px))
  }
  const stack = []
  for (const [, text, brace] of css.matchAll(/([^{}]*)([{}])/g)) {
    if (brace === "{") {
      stack.push(text.trim())
      continue
    }
    const selectors =
      stack
        .pop()
        ?.split(",")
        .map((s) => s.trim()) ?? []
    if (!stack.every((p) => !p.startsWith("@") || p.startsWith("@layer") || applies(p))) continue
    const value = /(?:^|;)\s*display:\s*([^;]+)/.exec(text)?.[1].trim()
    if (!value) continue
    for (const logo of Object.keys(display))
      if (selectors.includes(`.home-link .home-link-${logo}`)) display[logo] = value
  }
  return Object.keys(display).filter((logo) => display[logo] !== "none")
}

function build(bookDir, branch, ...flags) {
  const out = join(scratch, `out-${++n}`)
  const run = spawnSync(
    join(ROOT, "build-book.sh"),
    [bookDir, "--branch", branch, ...flags, "--out", out, "--registry", REGISTRY],
    {
      encoding: "utf8",
    },
  )
  const read = (p) => readFileSync(join(out, p), "utf8")
  return {
    out,
    status: run.status,
    log: run.stdout + run.stderr,
    read,
    has: (p) => existsSync(join(out, p)),
  }
}

test("the fixture on its live branch", async (t) => {
  const book = fixtureBook("design-fixture")
  const b = build(book.dir, "main")
  assert.equal(b.status, 0, b.log)

  await t.test("nothing outside the allowlist is published", () => {
    for (const p of [
      "LICENSE",
      "configure.mjs",
      "README.html",
      "admin/index.html",
      "admin/config.yml",
      "Frankenstein/chapter-01.html",
      "textbook.config.json",
    ])
      assert.equal(b.has(p), false, p)
  })
  await t.test("the book's pages, the picture and QA.md are", () => {
    for (const p of [
      "index.html",
      "glossary.html",
      "chapters/chapter-01.html",
      "chapters/qa.html",
      "chapters/definitions/the-three-domains.html",
      "community/contributors.html",
      "assets/chapter-01/square.png",
    ])
      assert.equal(b.has(p), true, p)
  })
  await t.test(
    "a wikilink resolves inside the allowlist though an ignored folder has the same name",
    () => {
      assert.match(b.read("community/contributors.html"), /href="\.\.\/chapters\/chapter-01"/)
    },
  )
  await t.test("Edit uses the repo root, and Suggest has the registry's endpoint", () => {
    const html = b.read("chapters/chapter-01.html")
    assert.match(
      html,
      /href="https:\/\/github\.com\/textbookproject2026-alt\/quartz-book\/edit\/main\/chapters\/chapter-01\.md"/,
    )
    assert.match(
      html,
      /class="tb-suggest-btn"[^>]*data-endpoint="https:\/\/suggest-edit\.example\.invalid\/api\/suggest-edit"/,
    )
    assert.match(
      b.read("chapters/definitions/the-three-domains.html"),
      /\/edit\/main\/chapters\/Definitions\/The%20Three%20Domains\.md"/,
    )
  })
  await t.test("the redirects, in both spellings", () => {
    const r = b.read("_redirects")
    assert.match(
      r,
      /^\/chapters\/Definitions\/The\+Three\+Domains \/chapters\/definitions\/the-three-domains 301$/m,
    )
    assert.match(
      r,
      /^\/chapters\/Definitions\/The%20Three%20Domains \/chapters\/definitions\/the-three-domains 301$/m,
    )
    assert.match(r, /^\/chapters\/QA \/chapters\/qa 301$/m)
    assert.match(r, /^\/docs\/how-to-comment \/how-to-comment 301$/m)
    assert.doesNotMatch(r, /chapter-01 /, "an unchanged URL has no redirect")
    assert.doesNotMatch(r, /for-course-coordinators/, "this book has no editions")
  })
  await t.test("the live branch is indexable", () => assert.equal(b.has("_headers"), false))
  await t.test("canonical links on the book's domain", () => {
    assert.match(
      b.read("chapters/chapter-01.html"),
      /<link rel="canonical" href="https:\/\/design-fixture\.example\.invalid\/chapters\/chapter-01" data-builder="quartz-book">/,
    )
    assert.match(
      b.read("index.html"),
      /<link rel="canonical" href="https:\/\/design-fixture\.example\.invalid\/" data-builder="quartz-book">/,
    )
  })
  await t.test("/how-to-comment is the builder's page, with no Edit link", () => {
    const html = b.read("how-to-comment.html")
    assert.match(html, /<title>Commenting in the Margins<\/title>/)
    assert.doesNotMatch(html, /<div class="tb-page-controls">/)
  })
  await t.test("the marker", () => {
    const m = JSON.parse(b.read(".well-known/textbook.json"))
    assert.deepEqual(Object.keys(m), [
      "slug",
      "branch",
      "book_commit",
      "registry_digest",
      "builder_commit",
    ])
    assert.equal(m.slug, "design-fixture")
    assert.equal(m.branch, "main")
    assert.equal(m.book_commit, book.head)
    assert.match(m.registry_digest, /^sha256:[0-9a-f]{64}$/)
    assert.match(m.builder_commit, /^[0-9a-f]{40}(-dirty)?$/)
  })
  await t.test("the catalog: the book's pages, from Quartz's own index", () => {
    const c = JSON.parse(b.read(".well-known/textbook-catalog.json"))
    assert.equal(c.version, 1)
    assert.equal(c.slug, "design-fixture")
    assert.equal(c.book_commit, book.head)
    const paths = c.pages.map((p) => p.path)
    assert.ok(paths.includes("/"))
    assert.ok(paths.includes("/chapters/chapter-01"))
    // The builder's page isn't the book's.
    assert.ok(!paths.includes("/how-to-comment"))
    // chapters/Definitions/ is a concept folder.
    const concepts = c.pages.filter((p) => p.concept).map((p) => p.title)
    assert.ok(concepts.includes("The Three Domains"), `concepts: ${concepts}`)
    assert.ok(Array.isArray(c.recent))
  })
  await t.test("the pinned extras are in: same-page citations work", () => {
    const html = b.read("chapters/chapter-01.html")
    assert.doesNotMatch(html, /href="#%5E/)
    assert.match(html, /href="#ref-bhaskar-1979"/)
  })

  await t.test("every page, the 404 too, starts its left sidebar with the home link", () => {
    const pages = walkFiles(b.out)
      .map((p) => relative(b.out, p))
      .filter((p) => p.endsWith(".html"))
      // alias-redirects' stubs are a meta refresh, with no layout.
      .filter((p) => !/<meta http-equiv="refresh"/.test(b.read(p)))
    assert.ok(pages.includes("404.html") && pages.includes("how-to-comment.html"), pages.join())
    const link =
      '<div class="left sidebar"><p class="home-link"><a href="https://confused4now.org/" aria-label="Confused for Now (home)"><svg '
    for (const p of pages) assert.ok(b.read(p).includes(link), p)
    // The rest of the sidebar follows it, as before.
    assert.match(b.read("chapters/chapter-01.html"), /<\/svg><\/a><\/p><h2 class="page-title">/)
  })

  await t.test("the home link's two inline logos: exactly one shows at each width", () => {
    const html = b.read("chapters/chapter-01.html")
    const a = /<p class="home-link">(<a [\s\S]*?<\/a>)<\/p>/.exec(html)[1]
    const svgs = a.match(/<svg [^>]*>/g)
    assert.deepEqual(
      svgs.map((s) => /class="([^"]*)"/.exec(s)[1]),
      ["home-link-full", "home-link-icon"],
    )
    for (const s of svgs) {
      assert.match(s, / aria-hidden="true"/)
      assert.match(s, / focusable="false"/)
      assert.match(s, / fill="currentColor"/)
    }
    const css = [...html.matchAll(/<link href="([^"]+\.css)" rel="stylesheet"/g)]
      .filter((m) => !/^https?:/.test(m[1]))
      .map((m) => b.read(join("chapters", m[1])))
      .join("\n")
    // Quartz's desktop breakpoint is 1200px: the full logo from there up.
    for (const width of [375, 800, 801, 1199])
      assert.deepEqual(logosShown(css, width), ["icon"], `${width}px`)
    for (const width of [1200, 1600])
      assert.deepEqual(logosShown(css, width), ["full"], `${width}px`)
  })

  await t.test("the output check fails once machinery is added to the output", () => {
    const tampered = join(scratch, "tampered")
    cpSync(b.out, tampered, { recursive: true })
    writeFileSync(join(tampered, "configure.mjs"), "x")
    writeFileSync(join(tampered, "LICENSE"), "x")
    cpSync(join(ROOT, "fixtures/book/admin"), join(tampered, "admin"), { recursive: true })
    const run = spawnSync("node", [join(ROOT, "builder/check-output.mjs"), tampered], {
      encoding: "utf8",
    })
    assert.equal(run.status, 2, run.stdout + run.stderr)
    for (const p of ["configure.mjs", "LICENSE", "admin/index.html", "admin/config.yml"])
      assert.match(run.stderr, new RegExp(`^  ${p.replace(".", "\\.")}$`, "m"))
    const clean = spawnSync("node", [join(ROOT, "builder/check-output.mjs"), b.out], {
      encoding: "utf8",
    })
    assert.equal(clean.status, 0, clean.stderr)
  })
})

test("a design preview builds the live branch as it is, but noindex (§4b)", () => {
  const book = fixtureBook("design-fixture")
  const live = build(book.dir, "main")
  const preview = build(book.dir, "main", "--preview")
  assert.equal(preview.status, 0, preview.log)
  assert.equal(live.has("_headers"), false)
  assert.equal(preview.read("_headers"), "/*\n  X-Robots-Tag: noindex\n")
  // The same marker as the live build: the preview is that build, beside it.
  assert.equal(preview.read(".well-known/textbook.json"), live.read(".well-known/textbook.json"))
  assert.equal(JSON.parse(preview.read(".well-known/textbook.json")).book_commit, book.head)
  assert.match(preview.read("chapters/chapter-01.html"), /\/edit\/main\/chapters\/chapter-01\.md"/)
  assert.equal(preview.read("chapters/chapter-01.html"), live.read("chapters/chapter-01.html"))
})

test("a drafts build is a noindex preview, and its links follow the branch", () => {
  const b = build(fixtureBook("design-fixture").dir, "drafts")
  assert.equal(b.status, 0, b.log)
  assert.equal(b.read("_headers"), "/*\n  X-Robots-Tag: noindex\n")
  assert.equal(JSON.parse(b.read(".well-known/textbook.json")).branch, "drafts")
  assert.match(b.read("chapters/chapter-01.html"), /\/edit\/drafts\/chapters\/chapter-01\.md"/)
})

test("suggest-edit off in the registry: no Suggest button", () => {
  const b = build(fixtureBook("no-suggest-fixture").dir, "main")
  assert.equal(b.status, 0, b.log)
  const html = b.read("chapters/chapter-01.html")
  assert.match(html, /class="edit-on-github"/)
  assert.doesNotMatch(html, /<button[^>]*tb-suggest-btn/)
  assert.match(
    b.read("_redirects"),
    /^\/docs\/for-course-coordinators https:\/\/github\.com\/textbookproject2026-alt\/textbook-edition-template\/blob\/main\/docs\/for-course-coordinators\.md 301$/m,
  )
  assert.match(b.read("how-to-comment.html"), /for-course-coordinators\.md/)
})

test("a retired book is refused", () => {
  const b = build(fixtureBook("retired-fixture").dir, "main")
  assert.equal(b.status, 2, b.log)
  assert.match(b.log, /refused: book "retired-fixture" is retired/)
  assert.equal(b.has("index.html"), false)
})

test("a book with its own how-to-comment is refused", () => {
  const book = fixtureBook("design-fixture", (dir) => {
    writeFileSync(join(dir, "how-to-comment.md"), "# Ours\n")
    execFileSync("git", ["-C", dir, "add", "-A"])
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=f",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-qm",
      "own page",
    ])
  })
  const b = build(book.dir, "main")
  assert.equal(b.status, 2, b.log)
  assert.match(b.log, /refused: the book has its own "how-to-comment\.md"/)
})

test("uncommitted changes to published files are refused", () => {
  const book = fixtureBook("design-fixture", (dir) =>
    writeFileSync(join(dir, "chapters/chapter-01.md"), "# Changed\n"),
  )
  const b = build(book.dir, "main")
  assert.equal(b.status, 2, b.log)
  assert.match(b.log, /uncommitted changes/)
})
