// Minimal static file server for local development of the calculator.
//   node tools/serve.mjs [port]
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const port = parseInt(process.argv[2] || "8000", 10)
const types = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
    ".wasm": "application/wasm", ".gif": "image/gif",
}

http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://localhost").pathname)
    if (p.endsWith("/")) {
        p += "calc.html"
    }
    let file = path.join(root, p)
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end("not found")
        return
    }
    res.writeHead(200, {"Content-Type": types[path.extname(file)] || "application/octet-stream"})
    fs.createReadStream(file).pipe(res)
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}/`))
