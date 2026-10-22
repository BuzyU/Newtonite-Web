import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

async function capture() {
  console.log('Launching browser to capture screenshots...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Helper to toggle theme and screenshot
  async function saveLightAndDark(screenName) {
    // 1. Light Mode
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('newtonite_theme', 'light');
    });
    await page.waitForTimeout(400);
    const lightPath = path.join(outDir, `${screenName}-light.png`);
    await page.screenshot({ path: lightPath });
    console.log(`Saved: ${screenName}-light.png`);

    // 2. Dark Mode
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('newtonite_theme', 'dark');
    });
    await page.waitForTimeout(400);
    const darkPath = path.join(outDir, `${screenName}-dark.png`);
    await page.screenshot({ path: darkPath });
    console.log(`Saved: ${screenName}-dark.png`);

    // Revert to light
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('newtonite_theme', 'light');
    });
    await page.waitForTimeout(200);
  }

  // 1. Login Page
  console.log('Capturing Login Page...');
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
  await saveLightAndDark('login');

  console.log('Logging in as Alice Admin...');
  const adminDemoBtn = page.locator('button', { hasText: 'Alice Admin' });
  await adminDemoBtn.click();
  const signInBtn = page.locator('#login-submit-btn');
  await signInBtn.click();

  // Wait for redirect to Attention Home
  await page.waitForURL('http://localhost:5173/');
  await page.waitForSelector('.skeleton', { state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // 2. Attention Home
  console.log('Capturing Attention Home...');
  await saveLightAndDark('attention');

  // 3. All Work List
  console.log('Capturing All Work List...');
  await page.goto('http://localhost:5173/work', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await saveLightAndDark('work');

  // 4. Item Detail (click first row in work list)
  console.log('Capturing Item Detail...');
  const firstRow = page.locator('tbody tr').first();
  await firstRow.click();
  await page.waitForURL(/\/items\//);
  await page.waitForTimeout(1000);
  await saveLightAndDark('item-detail');

  // 5. Teams & Rosters
  console.log('Capturing Teams & Rosters...');
  await page.goto('http://localhost:5173/teams', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await saveLightAndDark('teams');

  // 6. Dead Letters Admin
  console.log('Capturing Dead Letters Admin...');
  await page.goto('http://localhost:5173/dead-letters', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await saveLightAndDark('dead-letters');

  await browser.close();
  console.log('All screenshots captured successfully.');
}

capture().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
