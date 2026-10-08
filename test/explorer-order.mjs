// The explorer and the chapters folder page follow the book's Contents
// (decision of 1 Oct 2026), in a real browser, since the explorer is drawn by
// script:
//
//   node test/explorer-order.mjs <site base URL> <book checkout>
//
// It opens the first chapter in the Contents of the checkout's index.md at
// 1280x800 and asserts that the explorer's chapters folder lists the Contents'
// chapters first, in order, so the folder's first page link is the first
// Contents entry under chapters/. It then opens /chapters/ and asserts the
// same of the folder page's listing (builder/lib.mjs, orderFolderListing).
// Last, on the front page: every page the explorer shows (but the builder's
// how-to-comment) is in the rendered Contents, and in the same order
// (completeContents adds any index.md's own list misses, decision of 8 Oct).
// Browser: `npx playwright install chromium` (CI), or set
// PW_CHROMIUM_CHANNEL=chrome to use an installed Chrome.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { contentsOrder } from "../builder/lib.mjs"

const [base, checkout] = process.argv.slice(2)
if (!base || !checkout) {
  console.error("usage: explorer-order.mjs <site base URL> <book checkout>")
  process.exit(1)
}
const chapters = contentsOrder(readFileSync(join(checkout, "index.md"), "utf8")).filter((s) =>
  s.startsWith("chapters/"),
)
assert.ok(chapters.length, "index.md's Contents lists no chapter")

const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM_CHANNEL })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(new URL(chapters[0], base).href, { waitUntil: "load" })
  const folder = '.explorer-ul [data-folderpath="chapters/index"]'
  await page.waitForSelector(folder, { state: "attached" })
  const listed = await page.$$eval(`${folder} ~ .folder-outer > .content > li > a`, (as) =>
    as.map((a) => new URL(a.href).pathname.replace(/^\//, "").replace(/\.html$/, "")),
  )
  console.log(`explorer's chapters: ${listed.join(", ")}`)
  assert.equal(
    listed[0],
    chapters[0],
    "the chapters folder's first page isn't the first Contents entry",
  )
  assert.deepEqual(listed.slice(0, chapters.length), chapters)
  console.log(`pass  the explorer lists ${chapters.length} chapters in Contents order`)

  await page.goto(new URL("chapters/", base).href, { waitUntil: "load" })
  const items = await page.$$eval("ul.section-ul > li.section-li h3 > a", (as) =>
    as.map((a) => new URL(a.href).pathname.replace(/^\//, "").replace(/\.html$/, "")),
  )
  console.log(`folder page's chapters: ${items.join(", ")}`)
  assert.deepEqual(items.slice(0, chapters.length), chapters)
  console.log(`pass  /chapters/ lists ${chapters.length} chapters in Contents order`)

  await page.goto(base, { waitUntil: "load" })
  await page.waitForSelector(".explorer-ul a", { state: "attached" })
  const path = (as) => as.map((a) => decodeURIComponent(new URL(a.href).pathname).replace(/^\//, "").replace(/\.html$/, ""))
  // Every page link is in the explorer's markup, folded folders included; folder links end in "/".
  const explorer = (await page.$$eval(".explorer-ul li > a", path)).filter((p) => p !== "how-to-comment" && !p.endsWith("/"))
  // Each item's first link, from the lists between the Contents heading and the next heading.
  const contents = path(
    await page.evaluate(() => {
      const links = []
      const h = document.querySelector("article h2#contents")
      for (let el = h?.nextElementSibling; el && !/^H[1-6]$/.test(el.tagName); el = el.nextElementSibling)
        for (const li of el.matches("ol, ul") ? el.children : []) {
          const a = li.querySelector("a.internal")
          if (a) links.push({ href: a.href })
        }
      return links
    }),
  )
  console.log(`explorer: ${explorer.join(", ")}\ncontents: ${contents.join(", ")}`)
  assert.deepEqual(explorer, contents.filter((p) => explorer.includes(p)), "the explorer and the Contents differ in order")
  assert.deepEqual([...explorer].sort(), [...new Set(contents)].sort(), "the explorer and the Contents list different pages")
  console.log(`pass  the explorer's ${explorer.length} pages are the Contents', in its order`)
} finally {
  await browser.close()
}
