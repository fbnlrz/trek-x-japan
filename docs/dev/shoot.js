const { chromium } = require('playwright-core');
const path = require('path');

const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DOCS = '/home/user/trek-x-japan/docs';
const BASE = 'http://localhost:4317';

const TABS = ['countdown','season','culture','nihongo','budget','ic','food','passport','safety','settings'];

async function main() {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });

  // --- hero 1600x900 ---
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(BASE + '/ui/hero.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(DOCS, 'screenshot.png') });
    console.log('hero -> screenshot.png');
    await page.close();
  }

  // --- per-tab full-content shots (light) ---
  for (const tab of TABS) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(BASE + `/ui/harness.html?tab=${tab}&theme=light&locale=en`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    // height reported onto body[data-h] by the harness
    let h = 900;
    try { h = parseInt(await page.getAttribute('body', 'data-h')) || 900; } catch (_) {}
    h = Math.max(560, Math.min(h + 24, 2000));
    await page.setViewportSize({ width: 1180, height: h });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(DOCS, `tab-${tab}.png`), fullPage: true });
    console.log(`tab ${tab} -> tab-${tab}.png (h=${h})`);
    await page.close();
  }

  // --- one dark shot (food) to show theme ---
  {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(BASE + '/ui/harness.html?tab=passport&theme=dark&locale=en', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    let h = 900;
    try { h = parseInt(await page.getAttribute('body', 'data-h')) || 900; } catch (_) {}
    h = Math.max(560, Math.min(h + 24, 2000));
    await page.setViewportSize({ width: 1180, height: h });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(DOCS, 'tab-passport-dark.png'), fullPage: true });
    console.log('dark passport -> tab-passport-dark.png');
    await page.close();
  }

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
