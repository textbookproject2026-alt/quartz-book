// The reader's layout at the widths that matter, in Chromium and WebKit, plus an
// Android Chrome emulation:
//
//   node test/layout-checks.mjs <site base URL> <out dir> [page path]
//
// The page is the book's first chapter (from its catalog), unless given.
// Widths: about a dozen, at and around each switch point the page itself reports
// (edition-integrations' window.__tbLayout: the drawer's edge, Quartz's desktop
// breakpoint; the open-sidebar arrangement's edge from its CSS rule), plus 320,
// 360, 412, 600, 1440 and 1920. WebKit emulates iOS (mobile viewport, touch) at
// drawer widths. One page load per width and browser; on it:
//
//   scroll   at load, the logo leads the header row and the explorer (where it is
//            a sidebar) starts within 48px below it; after scrolling 1500px the
//            header's top is 0, it is fully in view, on top, and no control is
//            off-screen or under the annotation client's strip.
//   panels   at the top and at the bottom of the page: every shown header control
//            is on screen and on top; Contribute, Appearance, More and the
//            explainer each open by a click at their button's centre, and
//            elementFromPoint at nine points inside each returns it.
//   reading  (drawer widths) the drawer opens below the header and the header
//            stays on top and usable; the text column is the page less 16px a
//            side (or centred at its measure); no annotation strip; Standard text
//            18px with 35 to 75 characters a line (from 360px; characters a line
//            = the column's width over the body text's average character width);
//            Small text at least 16px.
//   android  Pixel 7 (its UA, scale, touch, mobile viewport) at 360, 390 and
//            412px: reading, no sideways scroll or zoom-out, the drawer, and
//            Annotate opening the annotation sidebar across the screen below the
//            header and closing it again.
//
// Writes <out dir>/summary.md (for the pull request comment) and a screenshot of
// every failing width; exit status 1 on any failure.
import { chromium, webkit, devices } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [base, outDir, given] = process.argv.slice(2)
if (!base || !outDir) {
  console.error("usage: layout-checks.mjs <site base URL> <out dir> [page path]")
  process.exit(2)
}
let path = given
if (!path) {
  const catalog = await (await fetch(new URL(".well-known/textbook-catalog.json", base))).json()
  path = (
    catalog.pages.find((p) => p.path.startsWith("/chapters/") && !p.concept) ??
    catalog.pages.find((p) => p.path !== "/")
  ).path
}
mkdirSync(outDir, { recursive: true })
const URL_ = new URL(path, base).toString()
const H = 900
const launch = (engine) =>
  engine === chromium && process.env.PW_CHROMIUM_CHANNEL
    ? engine.launch({ channel: process.env.PW_CHROMIUM_CHANNEL })
    : engine.launch()

const failures = []
const fail = (where, problems) => {
  for (const p of problems) failures.push(`${where}: ${p}`)
}
let checks = 0
const figures = []

const open = async (page) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 })
      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {})
      await page
        .waitForSelector(".tb-page-controls[data-tb-wired]", { state: "attached", timeout: 15000 })
        .catch(() => {})
      await page.waitForTimeout(800)
      return true
    } catch {
      if (attempt >= 2) return false
    }
  }
}
const clickCentre = async (page, sel) => {
  const b = await page.evaluate((s) => {
    const e = document.querySelector(s)
    if (!e || e.hidden) return null
    const r = e.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, sel)
  if (!b) return false
  await page.mouse.click(b.x, b.y)
  await page.waitForTimeout(250)
  return true
}

// --- in the page -------------------------------------------------------------------
const onTop = (sel) => {
  const el = document.querySelector(sel)
  if (!el || el.hidden || !el.isConnected) return ["not open"]
  const b = el.getBoundingClientRect()
  if (b.width < 8 || b.height < 8)
    return [`open but ${Math.round(b.width)}x${Math.round(b.height)}`]
  const bad = []
  for (const x of [b.left + 4, b.left + b.width / 2, b.right - 4])
    for (const y of [b.top + 4, b.top + b.height / 2, b.bottom - 4]) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        bad.push(`(${Math.round(x)},${Math.round(y)}) off-screen`)
        continue
      }
      const h = document.elementFromPoint(x, y)
      if (!h || !el.contains(h))
        bad.push(
          `(${Math.round(x)},${Math.round(y)}) ${h ? (typeof h.className === "string" && h.className ? h.className.split(" ")[0] : h.tagName) : "nothing"}`,
        )
    }
  return bad
}
const controls = () => {
  const row = document.querySelector(".tb-header-slot") || document.querySelector(".tb-header")
  const bad = []
  for (const el of [row.querySelector(".tb-hdr-title"), ...row.querySelectorAll(".tb-hdr-btn")]) {
    if (!el || el.hidden || el.closest("[hidden]")) continue
    const b = el.getBoundingClientRect()
    if (!b.width) continue
    const label = (
      el.getAttribute("aria-label") ||
      el.querySelector(".tb-hdr-label")?.textContent ||
      "title"
    ).trim()
    if (
      b.left < -0.5 ||
      b.right > document.documentElement.clientWidth + 0.5 ||
      b.top < -0.5 ||
      b.bottom > innerHeight + 0.5
    ) {
      bad.push(`${label} off-screen (x ${Math.round(b.left)}–${Math.round(b.right)})`)
      continue
    }
    const hit = document.elementFromPoint(b.left + Math.min(b.width / 2, 8), b.top + b.height / 2)
    if (!hit || !el.contains(hit))
      bad.push(
        `${label} covered by ${hit ? (typeof hit.className === "string" && hit.className ? hit.className.split(" ")[0] : hit.tagName) : "nothing"}`,
      )
  }
  return bad
}
const atLoad = () => {
  const problems = []
  const slot = document.querySelector(".tb-header-slot")
  const ex = document.querySelector(".explorer .desktop-explorer")
  if (slot && ex && getComputedStyle(ex).display !== "none") {
    const e = ex.getBoundingClientRect()
    const s = slot.getBoundingClientRect()
    if (e.top - s.bottom > 48)
      problems.push(`explorer starts ${Math.round(e.top - s.bottom)}px below the header row`)
  }
  if (
    document.querySelector(".home-link") &&
    !document.querySelector(".tb-header-slot > .home-link")
  )
    problems.push("the logo isn't in the header row")
  return problems
}
const afterScroll = (natural) => {
  const h = document.querySelector(".tb-header")
  const row = document.querySelector(".tb-header-slot") || h
  const r = row.getBoundingClientRect()
  const want = Math.max(0, natural - scrollY)
  const host = document.querySelector("hypothesis-sidebar")
  const strip =
    host && host.shadowRoot
      ? [...host.shadowRoot.querySelectorAll("button")]
          .map((b) => b.getBoundingClientRect())
          .filter((b) => b.width > 0)
          .map((b) => b.left)
      : []
  const edge = Math.min(innerWidth, ...strip)
  const problems = []
  if (Math.abs(r.top - want) > 1)
    problems.push(`header top ${Math.round(r.top)}px after scrolling (want ${Math.round(want)})`)
  if (r.top < -1 || r.bottom > innerHeight + 1) problems.push("header not fully in view")
  for (const el of [h.querySelector(".tb-hdr-title"), ...row.querySelectorAll(".tb-hdr-btn")]) {
    if (!el || el.hidden) continue
    const b = el.getBoundingClientRect()
    if (b.width > 0 && (b.left < -0.5 || b.right > edge + 0.5))
      problems.push(
        `${(el.getAttribute("aria-label") || el.querySelector(".tb-hdr-label")?.textContent || "title").trim()} at x ${Math.round(b.left)}–${Math.round(b.right)} (edge ${Math.round(edge)})`,
      )
  }
  const t = h.querySelector(".tb-hdr-title").getBoundingClientRect()
  const hit = document.elementFromPoint(t.left + 4, t.top + t.height / 2)
  if (!(hit && h.contains(hit))) problems.push("header covered")
  return problems
}
const reading = (size) => {
  const paras = [...document.querySelectorAll("article p")].filter(
    (x) =>
      !x.classList.contains("tb-lead") &&
      !x.closest(".popover, blockquote, li, table") &&
      x.textContent.trim().length > 120,
  )
  if (!paras.length) return { problems: ["no body paragraph to measure"] }
  const para = paras[0]
  const text = paras
    .map((x) => x.textContent.replace(/\s+/g, " ").trim())
    .join(" ")
    .slice(0, 3000)
  const probe = document.createElement("span")
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;left:0;top:0"
  probe.textContent = text
  para.append(probe)
  const avg = probe.getBoundingClientRect().width / text.length
  probe.remove()
  const r = para.getBoundingClientRect()
  const W = document.documentElement.clientWidth
  const cs = getComputedStyle(para)
  const font = parseFloat(cs.fontSize)
  const cpl = Math.round(r.width / avg)
  const problems = []
  if (r.width >= W - 33 && (Math.abs(r.left - 16) > 1 || Math.abs(r.right - (W - 16)) > 1))
    problems.push(`text column ${Math.round(r.left)}–${Math.round(r.right)}, not 16–${W - 16}`)
  if (r.width < W - 33 && Math.abs(r.left - (W - r.width) / 2) > 1)
    problems.push(
      `text column ${Math.round(r.left)}–${Math.round(r.right)}: neither full nor centred`,
    )
  const host = document.querySelector("hypothesis-sidebar")
  if (host && getComputedStyle(host).display !== "none") problems.push("annotation strip shown")
  if (size === "standard" && W >= 360 && (cpl < 35 || cpl > 75))
    problems.push(`${cpl} characters a line at Standard`)
  if (size === "standard" && Math.abs(font - 18) > 0.5) problems.push(`body ${font}px at Standard`)
  if (size === "small" && font < 16) problems.push(`body ${font}px at Small`)
  return { cpl, font, lh: Math.round((parseFloat(cs.lineHeight) / font) * 100) / 100, problems }
}
const drawerOpen = () => {
  const problems = []
  if (document.querySelector(".explorer")?.classList.contains("collapsed"))
    return ["the drawer didn't open"]
  const s = (
    document.querySelector(".tb-header-slot") || document.querySelector(".tb-header")
  ).getBoundingClientRect()
  const d = document.querySelector(".explorer-content")?.getBoundingClientRect()
  if (d && d.top < s.bottom - 1) problems.push("the drawer opens over the header")
  for (const el of [
    document.querySelector(".tb-hdr-title"),
    document.querySelector("[data-tb-menu]"),
  ]) {
    if (!el) continue
    const b = el.getBoundingClientRect()
    const hit = document.elementFromPoint(b.left + Math.min(8, b.width / 2), b.top + b.height / 2)
    if (!hit || !el.contains(hit)) problems.push("the header is covered with the drawer open")
  }
  const menu = document.querySelector("[data-tb-menu]")
  if (menu && Math.abs(menu.getBoundingClientRect().left - 16) > 1)
    problems.push("menu button not at the 16px gutter")
  return problems
}
const annotationOpen = () => {
  const host = document.querySelector("hypothesis-sidebar")
  const c = host?.shadowRoot?.querySelector(".sidebar-container")
  if (!c || !document.documentElement.classList.contains("tb-hypothesis-expanded"))
    return ["Annotate didn't open the sidebar"]
  const out = []
  const r = c.getBoundingClientRect()
  const s = document.querySelector(".tb-header-slot").getBoundingClientRect()
  if (Math.abs(r.left) > 1 || Math.abs(r.right - innerWidth) > 1)
    out.push("annotation sidebar not the screen's width")
  if (r.top < s.bottom - 1) out.push("annotation sidebar over the header")
  const a = document.querySelector("[data-tb-annotate]")
  if (!a.classList.contains("tb-closes")) out.push("Annotate doesn't become Close")
  return out
}

// --- per width -----------------------------------------------------------------------
const widthsFrom = async (browser) => {
  const page = await (await browser.newContext({ viewport: { width: 1920, height: H } })).newPage()
  await open(page)
  const p = await page.evaluate(() => {
    const px = (v) => (v ? parseFloat(v) : null)
    let room = null
    for (const sheet of document.styleSheets) {
      let rules
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const r of rules)
        if (
          r.media &&
          [...(r.cssRules || [])].some((c) =>
            String(c.selectorText).includes("tb-hypothesis-expanded .page"),
          )
        )
          room = px((/min-width:\s*([\d.]+px)/.exec(r.media.mediaText) || [])[1])
    }
    const L = window.__tbLayout || {}
    return { narrow: px(L.narrow), desktop: px(L.desktop), room }
  })
  await page.context().close()
  const ws = new Set([320, 360, 412, 600, 1440, 1920])
  if (p.narrow) [p.narrow, p.narrow + 1].forEach((w) => ws.add(w))
  if (p.desktop) [p.desktop, p.desktop + 1].forEach((w) => ws.add(w))
  if (p.room) [p.room - 1, p.room + 1].forEach((w) => ws.add(w))
  return { widths: [...ws].sort((a, b) => a - b), narrow: p.narrow ?? 800 }
}

const atWidth = async (browser, engine, width, narrow) => {
  const phone = engine === "webkit" && width <= narrow
  const ctx = await browser.newContext({
    viewport: { width, height: H },
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("tb-contribute-explained", "1")
    } catch {}
  })
  const page = await ctx.newPage()
  const where = `${engine} ${width}px`
  const problems = []
  if (!(await open(page))) {
    fail(where, ["the page didn't load"])
    await ctx.close()
    return
  }
  // scroll
  checks++
  problems.push(...(await page.evaluate(atLoad)))
  const natural = await page.evaluate(
    () =>
      (
        document.querySelector(".tb-header-slot") || document.querySelector(".tb-header")
      ).getBoundingClientRect().top + scrollY,
  )
  await page.evaluate(() => window.scrollTo(0, 1500))
  await page.waitForTimeout(400)
  problems.push(...(await page.evaluate(afterScroll, natural)))
  // panels, at the top and the bottom
  for (const at of ["top", "bottom"]) {
    checks++
    await page.evaluate(
      (a) => window.scrollTo(0, a === "top" ? 0 : document.documentElement.scrollHeight),
      at,
    )
    await page.waitForTimeout(300)
    for (const c of await page.evaluate(controls)) problems.push(`${at}: ${c}`)
    for (const [label, btn, panel] of [
      ["Contribute", "[data-tb-contribute]", "#tb-contribute-menu"],
      ["Appearance", "[data-tb-appearance]", "#tb-appearance"],
      ["More", "[data-tb-more]", "#tb-more-menu"],
    ]) {
      await clickCentre(page, btn)
      const bad = await page.evaluate(onTop, panel)
      if (bad.length) problems.push(`${at}: ${label} ${bad.slice(0, 3).join(", ")}`)
      await page.keyboard.press("Escape")
      await page.waitForTimeout(150)
    }
    // The explainer, from Contribute's "How contributing works".
    await clickCentre(page, "[data-tb-contribute]")
    await clickCentre(page, "#tb-contribute-menu [data-tb-explain]")
    await page.waitForTimeout(250)
    const bad = await page.evaluate(onTop, "dialog.tb-dialog[open]")
    if (bad.length) problems.push(`${at}: explainer ${bad.slice(0, 3).join(", ")}`)
    await page.keyboard.press("Escape")
    await page.waitForTimeout(200)
  }
  // reading, where the explorer is a drawer
  if (width <= narrow) {
    checks++
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(200)
    const std = await page.evaluate(reading, "standard")
    problems.push(...std.problems)
    await page.evaluate(() => document.documentElement.setAttribute("data-tb-text", "small"))
    await page.waitForTimeout(200)
    const small = await page.evaluate(reading, "small")
    problems.push(...small.problems.map((p) => `Small: ${p}`))
    await page.evaluate(() => document.documentElement.setAttribute("data-tb-text", "standard"))
    if (await clickCentre(page, "[data-tb-menu]")) {
      await page.waitForTimeout(500)
      problems.push(...(await page.evaluate(drawerOpen)))
      await clickCentre(page, "[data-tb-menu]")
    } else problems.push("no menu button")
  }
  if (problems.length) {
    fail(where, problems)
    await page.screenshot({ path: join(outDir, `${engine}-${width}.png`) })
  }
  console.log(
    `${problems.length ? "FAIL" : "ok  "} ${where}${problems.length ? ": " + problems.slice(0, 3).join("; ") : ""}`,
  )
  await ctx.close()
}

const android = async (browser) => {
  for (const width of [360, 390, 412]) {
    checks++
    const ctx = await browser.newContext({
      ...devices["Pixel 7"],
      viewport: { width, height: 800 },
    })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("tb-contribute-explained", "1")
      } catch {}
    })
    const page = await ctx.newPage()
    const where = `Android Chrome (Pixel 7) ${width}px`
    if (!(await open(page))) {
      fail(where, ["the page didn't load"])
      await ctx.close()
      continue
    }
    await page
      .waitForSelector("hypothesis-sidebar", { state: "attached", timeout: 30000 })
      .catch(() => {})
    await page.waitForTimeout(1500)
    const std = await page.evaluate(reading, "standard")
    const problems = [...std.problems]
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth || visualViewport.scale !== 1,
      )
    )
      problems.push("wider than the phone (zoomed out or scrolls sideways)")
    await page.tap("[data-tb-menu]")
    await page.waitForTimeout(600)
    problems.push(...(await page.evaluate(drawerOpen)))
    await page.tap("[data-tb-menu]")
    await page.waitForTimeout(500)
    await page.tap("[data-tb-annotate]")
    await page.waitForTimeout(3500)
    problems.push(...(await page.evaluate(annotationOpen)))
    await page.tap("[data-tb-annotate]")
    await page.waitForTimeout(1200)
    if (
      await page.evaluate(() =>
        document.documentElement.classList.contains("tb-hypothesis-expanded"),
      )
    )
      problems.push("Close didn't close the annotation sidebar")
    figures.push(`| ${width}px (Android) | ${std.cpl} | ${std.font}px / ${std.lh} |`)
    if (problems.length) {
      fail(where, problems)
      await page.screenshot({ path: join(outDir, `android-${width}.png`) })
    }
    console.log(`${problems.length ? "FAIL" : "ok  "} ${where}: ${std.cpl} a line, ${std.font}px`)
    await ctx.close()
  }
}

const desktopFigure = async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: H } })
  const page = await ctx.newPage()
  if (await open(page)) {
    const s = await page.evaluate(reading, "desktop")
    await page.evaluate(() => document.documentElement.setAttribute("data-tb-width", "wide"))
    await page.waitForTimeout(200)
    const w = await page.evaluate(reading, "desktop")
    figures.push(`| 1440px Standard / Wide | ${s.cpl} / ${w.cpl} | ${s.font}px / ${s.lh} |`)
    if (s.cpl < 60 || s.cpl > 75)
      fail("chromium 1440px", [`${s.cpl} characters a line at Standard (60–75)`])
    if (w.cpl > 92) fail("chromium 1440px", [`${w.cpl} characters a line at Wide (at most ~90)`])
  }
  await ctx.close()
}

// --- run: the two browsers side by side ---------------------------------------------------
const started = Date.now()
const runEngine = async (engineName) => {
  const browser = await launch(engineName === "webkit" ? webkit : chromium)
  const { widths, narrow } = await widthsFrom(browser)
  for (const w of widths) await atWidth(browser, engineName, w, narrow)
  if (engineName === "chromium") {
    await android(browser)
    await desktopFigure(browser)
  }
  await browser.close()
  return widths
}
const [widths] = await Promise.all([runEngine("chromium"), runEngine("webkit")])

const secs = Math.round((Date.now() - started) / 1000)
const lines = [
  `### Layout checks: ${failures.length ? `❌ ${failures.length} failing` : "✅ all pass"}`,
  "",
  `${URL_.replace(base, "/")} at ${widths.join(", ")}px in Chromium and WebKit (iOS emulation at drawer widths), and Android Chrome (Pixel 7) at 360, 390 and 412px: ${checks} checks in ${secs}s.`,
  "",
  "| Width | Characters a line | Body |",
  "|---|---|---|",
  ...figures,
]
if (failures.length)
  lines.push(
    "",
    "<details><summary>Failures</summary>",
    "",
    ...failures.slice(0, 40).map((f) => `- ${f}`),
    "",
    "</details>",
  )
writeFileSync(join(outDir, "summary.md"), lines.join("\n") + "\n")
console.log(
  `\n${checks - new Set(failures.map((f) => f.split(":")[0])).size}/${checks} checks passed in ${secs}s`,
)
if (failures.length) {
  console.log(failures.map((f) => `  FAIL ${f}`).join("\n"))
  process.exit(1)
}
