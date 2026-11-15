// Screenshots of the live login page (desktop and phone), kept as a run artifact.
import { chromium } from 'playwright';
const [site, out] = process.argv.slice(2);
const b = await chromium.launch();
for (const [tag, o] of [['desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }]]) {
  const c = await b.newContext({ locale: 'en-IN', ...o });
  await c.addInitScript(() => { try { localStorage.setItem('arzimate_member', '1'); } catch (e) {} });
  const p = await c.newPage();
  await p.goto(site + '/', { timeout: 60000 });
  await p.waitForSelector('flutter-view', { timeout: 60000 });
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${out}/login-${tag}.png` });
  await c.close();
}
await b.close();
