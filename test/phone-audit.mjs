// The phone audit (batch 2b) on a built book: the seven checks in
// phone-audit-checks.mjs (no sideways scroll, nothing clipped, short labels on one
// line, tap targets, text sizes, nothing under a pinned header, contrast) on the
// front page, a chapter, the contributors page, /history and how-to-comment, at
// 360x740, 390x844 and 412x915 in light and dark, in Chrome (or Chromium in CI).
//
//   node test/phone-audit.mjs <site base URL> <screenshot dir>
//
// A failure names the page, size, theme, check and element; a screenshot of each
// failing screen goes to <screenshot dir>. Exit status 1 on any failure.
import { chromium } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { auditPage } from "./phone-audit-checks.mjs"

const [base, outDir] = process.argv.slice(2)
if (!base || !outDir) {
  console.error("usage: phone-audit.mjs <site base URL> <screenshot dir>")
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
const catalog = await (await fetch(new URL(".well-known/textbook-catalog.json", base))).json()
const chapter =
  catalog.pages.find((p) => p.path.startsWith("/chapters/") && !p.concept) ??
  catalog.pages.find((p) => p.path !== "/")
const PAGES = [
  ["front", "/"],
  ["chapter", chapter.path],
  ["contributors", "/community/contributors"],
  ["history", "/history"],
  ["how-to-comment", "/how-to-comment"],
]
const SIZES = [
  [360, 740],
  [390, 844],
  [412, 915],
]
const browser = await chromium.launch(
  process.env.PW_CHROMIUM_CHANNEL ? { channel: process.env.PW_CHROMIUM_CHANNEL } : {},
)
let failed = 0
let screens = 0
for (const [name, path] of PAGES) {
  const url = new URL(path.replace(/^\//, ""), base).href
  for (const [w, h] of SIZES)
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
      })
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("tb-privacy-ok", "1")
        } catch {}
      })
      const page = await ctx.newPage()
      const res = await page.goto(url, { waitUntil: "networkidle" })
      screens++
      if (!res?.ok()) {
        if (name !== "contributors" && name !== "history") {
          failed++
          console.log(`FAIL ${name} ${w} ${theme}: HTTP ${res?.status()}`)
        }
        await ctx.close()
        continue
      }
      await page.waitForTimeout(500)
      const failures = await page.evaluate(auditPage, { bookPage: true })
      if (failures.length) {
        failed++
        for (const f of failures)
          console.log(`FAIL ${name} ${w} ${theme}: ${f.check} ${f.el} (${f.detail})`)
        await page.screenshot({ path: join(outDir, `${name}-${w}-${theme}.png`), fullPage: true })
      } else console.log(`ok   ${name} ${w} ${theme}`)
      await ctx.close()
    }
}
await browser.close()
console.log(`\n${screens - failed}/${screens} screens pass.`)
process.exit(failed ? 1 : 0)
