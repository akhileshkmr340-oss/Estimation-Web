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
  // On a manual run with log_shots, also print a small JPEG to the log (for readers that can't fetch artifacts).
  if (process.env.LOG_SHOTS === 'true') { await c.close(); const c2 = await b.newContext({ locale: 'en-IN', ...o, deviceScaleFactor: 1 }); await c2.addInitScript(() => { try { localStorage.setItem('arzimate_member', '1'); } catch (e) {} }); const p2 = await c2.newPage(); await p2.goto(site + '/'); await p2.waitForSelector('flutter-view'); await p2.waitForTimeout(6000); const j = await p2.screenshot({ type: 'jpeg', quality: 70 }); const s64 = j.toString('base64'); for (let i = 0; i < s64.length; i += 4000) console.log(`SHOT ${tag} ${String(i / 4000).padStart(4, '0')} ${s64.slice(i, i + 4000)}`); await c2.close(); continue; }
  await c.close();
}
await b.close();
