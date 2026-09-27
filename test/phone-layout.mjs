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
//   - logo and menu button on one row: tops within 4px, the button right of the logo;
//   - search and reader mode on that row too, right of the menu button;
//   - the Hypothes.is sidebar element present and visible, with its tab, eye and
//     note buttons at the right edge;
//   - those buttons over no header icon, no visible text and no open-menu item;
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
  const logoLink = q(".left.sidebar .home-link a")
  const header = {
    logo: rect(q(".left.sidebar .home-link")),
    burger: rect(q(".explorer-toggle")),
    search: rect(q(".left.sidebar .search-button")),
    reader: rect(q(".left.sidebar .readermode")),
  }
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

  return {
    W,
    path: location.pathname,
    scrollWidth: document.documentElement.scrollWidth,
    header,
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

const overlaps = (a, b) =>
  a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

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
      burger.left >= logo.right,
      `menu button right of the logo (${Math.round(burger.left)} vs ${Math.round(logo.right)})`,
    )
  }
  ok(search && reader, "search and reader mode present")
  if (search && reader && burger) {
    ok(
      Math.abs(search.top + search.height / 2 - (burger.top + burger.height / 2)) <= 6,
      "search on the header row",
    )
    ok(
      Math.abs(reader.top + reader.height / 2 - (burger.top + burger.height / 2)) <= 6,
      "reader mode on the header row",
    )
    ok(
      search.left >= burger.right && reader.left >= search.right,
      "search then reader mode, right of the menu button",
    )
  }
  ok(m.logoOnTop, `logo on top at its own spot (a tap there hits ${m.hitWas})`)
  ok(m.host && m.hostVisible, "Hypothes.is sidebar element present and visible")
  ok(m.hButtons.length >= 3, `Hypothes.is tab, eye and note buttons present (${m.hButtons.length})`)
  for (const b of m.hButtons) {
    ok(
      b.width > 0 && b.right <= m.W + 1 && b.left >= m.W - 60,
      `${b.label} at the right edge (x ${Math.round(b.left)})`,
    )
    for (const [name, r] of Object.entries(m.header))
      if (!m.menuOpen || name === "logo" || name === "burger")
        ok(!overlaps(b, r), `${b.label} over the ${name}`)
    ok(!m.textLines.some((t) => overlaps(b, t)), `${b.label} over body text`)
    ok(!m.menuItems.some((t) => overlaps(b, t)), `${b.label} over a menu item`)
  }
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
    const toggleMenu = () => page.tap(".explorer-toggle")
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
