// Loads the spike WASM in each browser engine and prints the timings (T014).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium, firefox, webkit } = require('@playwright/test');

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  const path = join(root, normalize(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(4180, r));

let failed = false;
for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  const browser = await type.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:4180/');
  await page.waitForFunction(() => document.getElementById('out').textContent !== 'running', null, { timeout: 120000 });
  const out = JSON.parse(await page.textContent('#out'));
  if (!out.ok) failed = true;
  console.log(name, browser.version(), JSON.stringify(out.ok ? out.results.at(-1) : out));
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
