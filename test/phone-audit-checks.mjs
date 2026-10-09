// The phone audit's seven checks (batch 2b), run inside a page with
// page.evaluate(auditPage, options). Self-contained: no imports, no closures.
// Each failure names the element (tag#id.class "text").
//
//   1 overflow   no page-level sideways scroll
//   2 clipped    no element with overflow hidden/clip cutting off its content,
//                unless it is meant to (ellipsis, visually hidden, an image crop)
//   3 wrapped    no short control label (< 30 characters) on more than one line
//   4 target     tap targets at least 44x44, or at least 24x24 with 24px spacing
//                (WCAG 2.2 2.5.8); links inside running text are exempt, as WCAG says
//   5 text-size  body text at least 16px on book pages; no text under 12px anywhere
//   6 covered    no control covered by a fixed or sticky element (the header)
//   7 contrast   text at least 4.5:1 (3:1 when large) against what is behind it
//
// options: { bookPage: boolean, scope?: CSS selector (only check inside it, e.g. an
// open dialog), ignore?: CSS selector of elements to skip }
export function auditPage({ bookPage = false, scope = null, ignore = null } = {}) {
  const failures = []
  const root = (scope && document.querySelector(scope)) || document.body
  const W = innerWidth
  const H = innerHeight
  const skip = (el) => (ignore ? el.closest(ignore) : null)
  const name = (el) => {
    if (!el || el.nodeType !== 1) return String(el)
    const id = el.id ? `#${el.id}` : ""
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : ""
    const text = (el.getAttribute("aria-label") || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40)
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`
  }
  const fail = (check, el, detail) => failures.push({ check, el: name(el), detail })
  const style = (el) => getComputedStyle(el)
  const visible = (el) => {
    if (!el.isConnected) return false
    const s = style(el)
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false
    if (el.closest("[hidden], [aria-hidden='true'], [inert]")) return false
    const r = el.getBoundingClientRect()
    if (r.right <= 0 || r.left >= W) return false // off to the side: a closed drawer
    return r.width > 0 && r.height > 0
  }
  const visuallyHidden = (el) => {
    const r = el.getBoundingClientRect()
    const s = style(el)
    return (
      (r.width <= 1 && r.height <= 1) ||
      s.clipPath === "inset(50%)" ||
      /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(s.clip)
    )
  }
  const all = [...root.querySelectorAll("*")].filter(
    (el) => !skip(el) && visible(el) && !visuallyHidden(el),
  )

  // 1 overflow
  const sw = document.documentElement.scrollWidth
  if (sw > W + 1) {
    const widest = [...document.body.querySelectorAll("*")]
      .filter(
        (el) =>
          visible(el) &&
          el.getBoundingClientRect().right > W + 1 &&
          !el.closest("[data-scroll], .tb-table-scroll"),
      )
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0]
    fail("overflow", widest ?? document.documentElement, `page is ${sw}px wide in a ${W}px window`)
  }

  // 2 clipped
  for (const el of all) {
    const s = style(el)
    const clips = /hidden|clip/.test(s.overflowX) || /hidden|clip/.test(s.overflow)
    if (!clips) continue
    if (s.textOverflow === "ellipsis") continue // an intended truncation, with the full text elsewhere
    if (["IMG", "VIDEO", "CANVAS", "SVG", "IFRAME", "svg"].includes(el.tagName)) continue
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      // Content that is only scrollbars or hidden children doesn't count: find a visible child past the edge.
      const box = el.getBoundingClientRect()
      const past = [...el.querySelectorAll("*")].find(
        (c) =>
          visible(c) &&
          !visuallyHidden(c) &&
          c.getBoundingClientRect().right > box.right + 1 &&
          (c.textContent || "").trim(),
      )
      if (past)
        fail(
          "clipped",
          el,
          `content ${el.scrollWidth}px in a ${el.clientWidth}px box (${name(past)})`,
        )
    }
  }

  // 2b tables: a table wider than its box is cut off unless it sits in a marked
  // horizontal scroller (data-scroll: the sticky first column and the edge fade say
  // there is more). A plain overflow:auto box gives a phone reader no cue.
  for (const t of all.filter((el) => el.tagName === "TABLE")) {
    const box = t.parentElement
    if (!box) continue
    if (t.getBoundingClientRect().width > box.clientWidth + 1 && !t.closest("[data-scroll]"))
      fail(
        "clipped",
        t,
        `table ${Math.round(t.getBoundingClientRect().width)}px in a ${box.clientWidth}px column, no scroll cue`,
      )
  }

  // Controls: what a reader taps.
  const inText = (el) => {
    // A link in running text (a sentence in a paragraph, list item, cell, quote), which WCAG exempts.
    if (el.tagName !== "A") return false
    const block = el.parentElement?.closest("p, li, td, th, dd, blockquote, figcaption")
    if (!block) return false
    const own = (el.textContent || "").trim().length
    const all = (block.textContent || "").trim().length
    return all > own + 8
  }
  const CONTROL =
    "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=link], [tabindex]:not([tabindex='-1'])"
  const controls = all.filter((el) => el.matches(CONTROL) && !el.closest("svg"))

  // 3 wrapped: short labels on one line
  const lines = (el) => {
    // The visible text only: an icon button's hidden label isn't a second line.
    const tops = new Set()
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (tw.nextNode()) {
      const n = tw.currentNode
      const p = n.parentElement
      if (!n.textContent.trim() || !p || !visible(p) || visuallyHidden(p)) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects())
        if (r.width > 1 && r.height > 1) tops.add(Math.round(r.top + r.height / 2))
    }
    // Rects of one line sit within a few px of each other.
    const sorted = [...tops].sort((a, b) => a - b)
    let n = 0
    let last = -Infinity
    for (const t of sorted) {
      if (t - last > 6) n++
      last = t
    }
    return n
  }
  // A link in the book's text flows with it; only links that act as controls count.
  const prose = (el) =>
    el.tagName === "A" &&
    el.closest(
      "article p, article li, article td, article dd, article blockquote, .markdown-rendered p, .markdown-rendered li",
    )
  const labels = all.filter(
    (el) =>
      el.matches(
        "a, button, [role=tab], [role=menuitem], [role=button], .badge, .tb-role, .tb-type-badge, label, summary",
      ) &&
      !inText(el) &&
      !prose(el),
  )
  for (const el of labels) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ")
    if (!text || text.length >= 30) continue
    if (lines(el) > 1) fail("wrapped", el, `"${text}" breaks over ${lines(el)} lines`)
  }

  // 4 target size (WCAG 2.2 2.5.8): 24x24 at least, or, if smaller, a 24px circle on
  // its centre that meets no other target and no other small target's circle.
  // The brief asks 44x44 where there is room; under that, the WCAG minimum is the bar.
  const rects = controls.map((el) => ({ el, r: el.getBoundingClientRect() }))
  const small = (r) => r.width < 24 - 0.5 || r.height < 24 - 0.5
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2]
  const distTo = ([x, y], r) =>
    Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))
  for (const { el, r } of rects) {
    if (inText(el) || !small(r)) continue
    if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) continue // the label is the target
    const c = centre(r)
    const crowded = rects.some((o) => {
      if (o.el === el || o.el.contains(el) || el.contains(o.el)) return false
      if (distTo(c, o.r) < 12) return true
      return small(o.r) && !inText(o.el) && Math.hypot(...centre(o.r).map((v, k) => v - c[k])) < 24
    })
    if (crowded)
      fail(
        "target",
        el,
        `${Math.round(r.width)}x${Math.round(r.height)}px, too close to another target`,
      )
  }

  // 5 text size
  const texts = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.textContent.trim() &&
      n.parentElement &&
      visible(n.parentElement) &&
      !visuallyHidden(n.parentElement) &&
      !skip(n.parentElement)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  })
  while (walker.nextNode()) texts.push(walker.currentNode)
  const seenSmall = new Set()
  for (const t of texts) {
    const el = t.parentElement
    if (el.closest("svg")) continue // a drawing's own labels scale with it
    const size = parseFloat(style(el).fontSize)
    if (size < 12 - 0.01 && !seenSmall.has(el)) {
      seenSmall.add(el)
      fail("text-size", el, `${size}px text`)
    }
  }
  if (bookPage) {
    for (const p of root.querySelectorAll("article p, .center p.tb-para, article li")) {
      if (
        !visible(p) ||
        p.closest("figure, footer, .tb-credits-foot, .tb-byline, nav, table, .tb-credits-block")
      )
        continue
      const size = parseFloat(style(p).fontSize)
      if (size < 16 - 0.01) {
        fail("text-size", p, `body text ${size}px`)
        break
      }
    }
  }

  // 6 covered by a fixed or sticky element
  const pinned = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const p = style(e).position
      if (p === "fixed" || p === "sticky") return e
    }
    return null
  }
  for (const { el, r } of rects) {
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < 0 || cy < 0 || cx > W || cy > H) continue
    const hit = document.elementFromPoint(cx, cy)
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue
    const over = pinned(hit)
    if (!over || over.contains(el) || over.matches("dialog, [role=dialog], [aria-modal]")) continue
    // Scrolled behind a header pinned to the top is just scrolling: the reader scrolls
    // back. Covered means at the top of the page, or by something pinned elsewhere
    // (a notice at the bottom, a button floating over the text).
    if (
      scrollY > 0 &&
      over.getBoundingClientRect().top <= 1 &&
      r.top < over.getBoundingClientRect().bottom
    )
      continue
    // A notice pinned to the bottom, with room left to scroll the control clear of it.
    const ob = over.getBoundingClientRect()
    if (
      ob.bottom >= H - 40 &&
      document.documentElement.scrollHeight - scrollY - H >= r.bottom - ob.top
    )
      continue
    fail("covered", el, `under ${name(over)}`)
  }

  // 7 contrast
  const rgba = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (!m) return null
    const [r, g, b, a = 1] = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number)
    return { r, g, b, a }
  }
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  })
  const background = (el) => {
    const layers = []
    for (let e = el; e; e = e.parentElement) {
      const s = style(e)
      if (s.backgroundImage && s.backgroundImage !== "none" && !/gradient/.test(s.backgroundImage))
        return null // a picture: can't tell
      const c = rgba(s.backgroundColor)
      if (c && c.a > 0) {
        layers.push(c)
        if (c.a >= 1) break
      }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 }
    const pageBg = rgba(style(document.documentElement).backgroundColor)
    if (pageBg && pageBg.a > 0) bg = over(pageBg, bg)
    for (const c of layers.reverse()) bg = over(c, bg)
    return bg
  }
  const seenContrast = new Set()
  for (const t of texts) {
    const el = t.parentElement
    if (
      seenContrast.has(el) ||
      el.closest("svg, del, s, [aria-disabled='true'], :disabled, .tb-ed-del")
    )
      continue
    seenContrast.add(el)
    const s = style(el)
    const fg = rgba(s.color)
    const bg = background(el)
    if (!fg || !bg) continue
    if (fg.a === 0) continue // painted another way (gradient text): can't be measured here
    const text = over(fg, bg)
    const [a, b] = [lum(text), lum(bg)].sort((x, y) => y - x)
    const ratio = (a + 0.05) / (b + 0.05)
    const size = parseFloat(s.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5) - 0.05)
      fail(
        "contrast",
        el,
        `${ratio.toFixed(2)}:1 (${s.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}))`,
      )
  }

  // One line per element and check.
  const seen = new Set()
  return failures.filter((f) => {
    const k = `${f.check}|${f.el}`
    return seen.has(k) ? false : seen.add(k)
  })
}
