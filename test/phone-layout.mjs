// The phone layout, in real device emulation (Playwright's device profiles:
// user agent, viewport, scale factor, isMobile, hasTouch), through every state
// a reader reaches:
//
//   node test/phone-layout.mjs <site base URL> <screenshot dir>
//
// Devices: Pixel 7 (Chromium) and iPhone 13 (WebKit). Pages: the front page and
// the book's first chapter (from its catalog). States: loaded; menu open; menu
// closed; after navigating to another page through the menu; the annotation
// sidebar opened (screenshot only) and closed again. In every state but the open
// sidebar, it asserts:
//   - one bar: Quartz's own row (the left sidebar) takes no height; the header
//     row has the menu button at its left edge (the 16px gutter), then the logo,
//     the title and the controls;
//   - menu button and logo on one row: tops within 4px, the logo right of the button;
//   - reader mode on that row too, right of the menu button, or in ⋯ where the
//     row is short of room;
//   - the header bar (menu, title, Search, Contribute, Annotate, Aa, ⋯) with
//     every control on one row and inside the screen, and on top, the drawer
//     open or not (it opens below the header);
//   - no annotation strip: the Hypothes.is client present, its host not drawn
//     while closed, so no tab or bucket bar over the page;
//   - the logo on top at its own spot (what a tap there would hit);
//   - no element past the viewport width, and no horizontal scroll.
// A screenshot of every state goes to <screenshot dir>. Exit status 1 on any
// failure. Browsers: `npx playwright install chromium webkit` (CI), or set
// PW_CHROMIUM_CHANNEL=chrome to use an installed Chrome.
import { chromium, webkit, devices } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const [base, outDir] = process.argv.slice(2)
if (!base || !outDir) {
  console.error("usage: phone-layout.mjs <site base URL> <screenshot dir>")
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const DEVICES = ["Pixel 7", "iPhone 13"]
const failures = []
let checks = 0

const catalog = await (await fetch(new URL(".well-known/textbook-catalog.json", base))).json()
const chapter =
  catalog.pages.find((p) => p.path.startsWith("/chapters/") && !p.concept) ??
  catalog.pages.find((p) => p.path !== "/")
const PAGES = [
  ["front", "/"],
  ["chapter", chapter.path],
]

/** Everything the assertions need, measured in the page. */
const measure = () => {
  const W = window.innerWidth
  const rect = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return {
      left: b.left,
      right: b.right,
      top: b.top,
      bottom: b.bottom,
      width: b.width,
      height: b.height,
    }
  }
  const q = (s) => document.querySelector(s)
  const logoLink = q(".tb-header-slot .home-link a")
  const readerButton = q("[data-tb-reader]")
  const header = {
    logo: rect(q(".tb-header-slot .home-link")),
    burger: rect(q("[data-tb-menu]")),
    reader: readerButton && !readerButton.hidden ? rect(readerButton) : null,
    // The sticky header bar, and its Search (Quartz's own button is hidden now).
    bar: rect(q(".tb-header")),
    search: rect(q("[data-tb-search]")),
  }
  const barButtons = [...document.querySelectorAll(".tb-header-slot .tb-hdr-btn")]
    .filter((b) => !b.hidden)
    .map(rect)
  const lr = rect(logoLink)
  const hit = lr ? document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2) : null
  const logoOnTop = !!(hit && logoLink && (hit === logoLink || logoLink.contains(hit)))

  const host = q("hypothesis-sidebar")
  const hostStyle = host ? getComputedStyle(host) : null
  const hButtons =
    host && host.shadowRoot
      ? [...host.shadowRoot.querySelectorAll("button")]
          .filter((b) =>
            /Annotation sidebar|Show highlights|Hide highlights|New page note/.test(
              b.getAttribute("aria-label") || "",
            ),
          )
          .map((b) => ({ label: b.getAttribute("aria-label"), ...rect(b) }))
      : []

  const menu = q(".explorer")
  const menuOpen = !!menu && !menu.classList.contains("collapsed")
  const menuItems = menuOpen
    ? [...document.querySelectorAll(".explorer-content a, .explorer-content button")]
        .map(rect)
        .filter((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight)
    : []
  const textLines = []
  if (!menuOpen) {
    const art = q("article")
    const walker = art ? document.createTreeWalker(art, NodeFilter.SHOW_TEXT) : null
    let t
    while (walker && (t = walker.nextNode()) && textLines.length < 400) {
      if (!t.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(t)
      for (const r of range.getClientRects())
        if (r.width > 1 && r.bottom > 0 && r.top < innerHeight)
          textLines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })
    }
  }

  // Past the viewport: every visible element of the page itself, and the client's buttons.
  const past = []
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("hypothesis-sidebar, hypothesis-notebook, hypothesis-profile, hypothesis-adder"))
      continue
    const cs = getComputedStyle(el)
    if (cs.visibility === "hidden" || cs.display === "none") continue
    const b = el.getBoundingClientRect()
    if (b.width > 0 && b.height > 0 && b.right > W + 1) {
      past.push(
        `${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(" ")[0]} right=${Math.round(b.right)}`,
      )
    }
  }
  for (const b of hButtons)
    if (b.right > W + 1) past.push(`hypothesis ${b.label} right=${Math.round(b.right)}`)

  const readerItem = q("[data-tb-reader-item]")
  return {
    W,
    path: location.pathname,
    quartzRow: rect(q(".page > #quartz-body > .sidebar.left")),
    readerInMore: !!readerItem && !readerItem.hidden,
    scrollWidth: document.documentElement.scrollWidth,
    header,
    barButtons,
    logoOnTop,
    hitWas: hit ? hit.tagName.toLowerCase() : null,
    host: !!host,
    hostVisible: !!hostStyle && hostStyle.visibility === "visible" && hostStyle.display !== "none",
    hButtons,
    menuOpen,
    menuItems,
    textLines,
    past: past.slice(0, 5),
  }
}

/** The assertions for one state. */
const assertState = (m, where, expectMenuOpen) => {
  const fail = (what) => failures.push(`${where}: ${what}`)
  const ok = (cond, what) => {
    checks++
    if (!cond) fail(what)
  }
  const { logo, burger, search, reader } = m.header
  ok(m.menuOpen === expectMenuOpen, `menu should be ${expectMenuOpen ? "open" : "closed"}`)
  ok(logo && burger, "logo and menu button present")
  if (logo && burger) {
    ok(
      Math.abs(logo.top - burger.top) <= 4,
      `logo and menu button on one row (tops ${Math.round(logo.top)} / ${Math.round(burger.top)})`,
    )
    ok(
      logo.left >= burger.right,
      `logo right of the menu button (${Math.round(logo.left)} vs ${Math.round(burger.right)})`,
    )
    ok(
      Math.abs(burger.left - 16) <= 1,
      `menu button at the 16px gutter (x ${Math.round(burger.left)})`,
    )
  }
  ok(
    !!m.quartzRow && m.quartzRow.height <= 0.5,
    `one bar: Quartz's own row has no height (${m.quartzRow && Math.round(m.quartzRow.height)}px)`,
  )
  ok(search && (reader || m.readerInMore), "search and reader mode (on the row or in ⋯) present")
  if (reader && burger) {
    ok(
      Math.abs(reader.top + reader.height / 2 - (burger.top + burger.height / 2)) <= 6,
      "reader mode on the header row",
    )
    ok(reader.left >= burger.right, "reader mode right of the menu button")
  }
  ok(
    m.barButtons.length === (reader ? 7 : 6),
    `the header bar's controls: menu, Search, Contribute, Annotate, ${reader ? "Reader mode, " : ""}Aa, ⋯ (${m.barButtons.length})`,
  )
  if (m.barButtons.length)
    ok(
      m.barButtons.every(
        (b) => Math.abs(b.top - m.barButtons[0].top) <= 2 && b.left >= 0 && b.right <= m.W,
      ),
      "the header bar's controls on one row, inside the screen",
    )
  // The drawer opens below the header: the bar stays usable, the logo included.
  ok(m.logoOnTop, `logo on top at its own spot (a tap there hits ${m.hitWas})`)
  ok(m.host, "Hypothes.is client present")
  ok(
    !m.hostVisible,
    "no annotation strip: the client's host isn't drawn while its sidebar is closed",
  )
  ok(
    m.hButtons.every((b) => b.width === 0),
    `no annotation tab or bucket-bar buttons on the page (${m.hButtons.filter((b) => b.width > 0).length})`,
  )
  ok(m.scrollWidth <= m.W, `no horizontal scroll (page ${m.scrollWidth} > ${m.W})`)
  ok(m.past.length === 0, `nothing past the viewport width: ${m.past.join(", ")}`)
}

for (const deviceName of DEVICES) {
  const device = devices[deviceName]
  const engine = device.defaultBrowserType === "webkit" ? webkit : chromium
  const launch =
    engine === chromium && process.env.PW_CHROMIUM_CHANNEL
      ? { channel: process.env.PW_CHROMIUM_CHANNEL }
      : {}
  const browser = await engine.launch({ headless: true, ...launch })
  for (const [pageName, path] of PAGES) {
    const ctx = await browser.newContext({ ...device })
    const page = await ctx.newPage()
    const tag = `${deviceName.replace(/\s+/g, "-")}-${pageName}`
    let n = 0
    const state = async (label, expectMenuOpen, assert = true) => {
      await page.waitForTimeout(700)
      const shot = join(
        outDir,
        `${tag}-${String(++n).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-")}.png`,
      )
      await page.screenshot({ path: shot })
      if (!assert) return
      const m = await page.evaluate(measure)
      const before = failures.length
      assertState(m, `${deviceName} ${pageName} [${label}] ${m.path}`, expectMenuOpen)
      console.log(
        `${failures.length === before ? "PASS" : "FAIL"} ${deviceName.padEnd(9)} ${pageName.padEnd(7)} ${label}`,
      )
    }
    const clientReady = () =>
      page
        .waitForSelector("hypothesis-sidebar", { state: "attached", timeout: 30000 })
        .then(() => page.waitForTimeout(2500))
    // The header's menu button opens the drawer, below the header, and closes it.
    const toggleMenu = () => page.tap("[data-tb-menu]")
    const clientToggle = () =>
      page.evaluate(() =>
        document
          .querySelector("hypothesis-sidebar")
          .shadowRoot.querySelector("button[aria-expanded]")
          .click(),
      )

    await page.goto(new URL(path, base).toString(), { waitUntil: "load" })
    await clientReady()
    await state("loaded", false)
    await toggleMenu()
    await state("menu open", true)
    await toggleMenu()
    await state("menu closed", false)
    // Another page through the menu: a top-level page link (ones inside a
    // collapsed folder overlap the folder buttons).
    await toggleMenu()
    await page.waitForTimeout(600)
    const target = await page.evaluate(() => {
      const here = location.pathname.replace(/\/$/, "")
      const a = [...document.querySelectorAll(".explorer-content a.nav-file-title")].find(
        (x) =>
          x.getBoundingClientRect().width > 0 &&
          !x.closest(".folder-outer") &&
          new URL(x.href).pathname.replace(/\/$/, "") !== here,
      )
      return a ? a.getAttribute("href") : null
    })
    if (!target) failures.push(`${deviceName} ${pageName}: no top-level page link in the menu`)
    else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "load" }),
        page.tap(`.explorer-content a[href="${target}"]`),
      ])
      await clientReady()
    }
    await state("after navigating via the menu", false)
    await clientToggle()
    await page.waitForTimeout(1500)
    await state("annotation sidebar open", false, false)
    await clientToggle()
    await page.waitForTimeout(1500)
    await state("annotation sidebar closed again", false)
    await ctx.close()
  }
  await browser.close()
}

console.log(`\n${checks - failures.length}/${checks} checks passed; screenshots in ${outDir}`)
if (failures.length) {
  console.log(failures.map((f) => `  FAIL ${f}`).join("\n"))
  process.exit(1)
}
