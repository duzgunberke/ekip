#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.DEMO_URL || 'http://127.0.0.1:7790';
const executablePath =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const items = [
  { title: 'Görevler', path: '/tasks', heading: 'Görevler' },
  { title: 'Genel bakış', path: '/overview', heading: 'Genel bakış' },
  { title: 'Projeler', path: '/projects', heading: 'Projeler' },
  { title: 'Kod haritası', path: '/code-map', heading: 'Kod haritası' },
  { title: 'İşler', path: '/jobs', heading: 'İşler' },
  { title: 'Çalıştırmalar', path: '/runs', heading: 'Çalıştırmalar' },
  { title: 'Havuzlar', path: '/pools', heading: 'Havuzlar' },
  { title: 'Paneller', path: '/panels', heading: 'Paneller' },
];

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    const binary = process.env.PATH.split(path.delimiter)
      .map((directory) => path.join(directory, 'playwright'))
      .find((candidate) => fs.existsSync(candidate));
    if (!binary) throw new Error('Playwright not found; run with npx --yes --package=playwright');
    return createRequire(fs.realpathSync(binary))('playwright');
  }
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true, executablePath });
const failures = [];

try {
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900, isMobile: false, hasTouch: false },
    { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
  ]) {
    const context = await browser.newContext({
      viewport,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    });
    const page = await context.newPage();
    const login = await page.request.post(`${base}/login`, {
      data: { password: 'demo' },
    });
    if (!login.ok()) throw new Error(`Demo login failed: HTTP ${login.status()}`);
    await page.addInitScript(() => localStorage.setItem('ekip-lang', 'tr'));

    await page.goto(`${base}/overview`);
    await page.getByRole('heading', { level: 1, name: 'Genel bakış' }).waitFor();

    for (const item of items) {
      if (viewport.name === 'mobile') {
        await page.locator('[data-sidebar="trigger"]').click();
      }

      const link = page
        .locator(`[data-sidebar="sidebar"] a[href="${item.path}"]`)
        .filter({ hasText: item.title })
        .last();
      await link.waitFor({ state: 'visible' });
      if (viewport.isMobile) await link.tap();
      else await link.click();
      try {
        await page.waitForFunction(
          ({ pathname, heading }) =>
            location.pathname === pathname &&
            document.querySelector('h1')?.textContent?.trim() === heading,
          { pathname: item.path, heading: item.heading },
          { timeout: 5000 }
        );
        console.log(`PASS ${viewport.name}: ${item.title} (${item.path})`);
      } catch {
        const actual = await page.locator('h1').textContent().catch(() => '(no heading)');
        const activeLinks = await page
          .locator('[data-sidebar="sidebar"] a[data-active="true"]')
          .allTextContents();
        const message = `FAIL ${viewport.name}: ${item.title} (${item.path}) after one click; URL=${page.url()}, heading=${JSON.stringify(actual?.trim())}, active=${JSON.stringify(activeLinks)}`;
        failures.push(message);
        console.error(message);
      }
    }

    await page.getByRole('button', { name: 'İngilizce', exact: true }).click();
    await page.waitForFunction(
      () =>
        new URL(location.href).searchParams.get('lang') === 'en' &&
        document.documentElement.lang === 'en',
      undefined,
      { timeout: 5000 }
    );
    console.log(`PASS ${viewport.name}: language change stays in router history`);

    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} navigation check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll 18 navigation and language checks passed.');
}
