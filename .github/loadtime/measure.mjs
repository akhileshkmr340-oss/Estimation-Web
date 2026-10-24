// Loads the live website in a fresh browser (empty cache, like a first
// visit) and again with the cache (a return visit), and reports how long
// the login page takes to appear and what was downloaded.
// node measure.mjs https://estimation-6fa32.web.app [budget_first_s] [budget_repeat_s]
import { chromium } from 'playwright';
const [url, firstBudget = '12', repeatBudget = '6'] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
async function visit(label) {
  const page = await ctx.newPage();
  const reqs = [];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const sizes = new Map();
  cdp.on('Network.loadingFinished', (e) => sizes.set(e.requestId, e.encodedDataLength));
  const urls = new Map();
  cdp.on('Network.responseReceived', (e) => urls.set(e.requestId, { url: e.response.url, status: e.response.status, cached: e.response.fromDiskCache || e.response.fromMemoryCache, t: e.timestamp }));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 120000, polling: 100 });
  const firstFrame = (Date.now() - t0) / 1000;
  // Flutter builds its accessibility tree only when asked; then the login
  // buttons can be found.
  await page.evaluate(() => document.querySelector('flt-semantics-placeholder')?.click());
  await page.getByRole('button', { name: /Log in|Sign up/ }).first().waitFor({ timeout: 60000 }).catch(() => {});
  const ready = (Date.now() - t0) / 1000;
  await page.waitForTimeout(1500);
  let total = 0;
  const rows = [];
  for (const [id, u] of urls) {
    const s = sizes.get(id) ?? 0;
    total += s;
    rows.push([s, u.status, u.cached ? 'cache' : 'net', u.url.replace(url, '')]);
  }
  rows.sort((a, b) => b[0] - a[0]);
  console.log(`::notice::${label}: first frame ${firstFrame.toFixed(1)} s, login page ready ${ready.toFixed(1)} s, ${(total / 1048576).toFixed(2)} MB, ${rows.length} requests. Largest: ${rows.slice(0, 6).map((r) => `${r[3].split('?')[0].slice(-40)} ${(r[0] / 1024).toFixed(0)} KB ${r[2]}`).join('; ')}`);
  console.log(`\n== ${label}: first frame ${firstFrame.toFixed(1)} s, login page ready ${ready.toFixed(1)} s, downloaded ${(total / 1048576).toFixed(2)} MB in ${rows.length} requests`);
  for (const r of rows.slice(0, 15)) console.log(`${(r[0] / 1024).toFixed(0).padStart(7)} KB  ${r[1]} ${r[2].padEnd(5)} ${r[3].slice(0, 100)}`);
  await page.close();
  return ready;
}
const first = await visit('First visit (empty cache)');
const repeat = await visit('Return visit (cached)');
await browser.close();
console.log(`::notice::First visit ${first.toFixed(1)} s (budget ${firstBudget} s), return visit ${repeat.toFixed(1)} s (budget ${repeatBudget} s)`);
if (first > Number(firstBudget) || repeat > Number(repeatBudget)) {
  console.log('::error::The website loads slower than its budget.');
  process.exit(1);
}
