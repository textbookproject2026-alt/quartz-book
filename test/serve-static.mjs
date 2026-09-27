// Serves a built book on 127.0.0.1 with Pages' extensionless URLs (/x → x.html,
// /dir/ → dir/index.html), for test/phone-layout.mjs in CI:
//   node test/serve-static.mjs <site dir> <port>
import { createServer } from "node:http"
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs"
import { extname, join, normalize } from "node:path"

const [root, port] = process.argv.slice(2)
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
}
createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0])
  for (const candidate of [path, `${path}.html`, join(path, "index.html")]) {
    const file = normalize(join(root, candidate))
    if (file.startsWith(normalize(root)) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
      return createReadStream(file).pipe(res)
    }
  }
  const notFound = join(root, "404.html")
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
  res.end(existsSync(notFound) ? readFileSync(notFound) : "not found")
}).listen(Number(port), "127.0.0.1")
