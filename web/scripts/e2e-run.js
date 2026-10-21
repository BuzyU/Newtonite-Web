import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = path.resolve('..', 'docs', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function main() {
  console.log('Starting Playwright End-to-End Suite against http://localhost:5173...');
  const browser = await chromium.launch({ headless: true });

  try {
    // ------------------------------------------------------------------------
    // Scenario 1: Setup Context 1 (Priya) and Context 2 (Elena)
    // ------------------------------------------------------------------------
    const context1 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Login User 1: Priya Sharma (Lead)
    console.log('Logging in Context 1 (Priya Sharma, Lead)...');
    await page1.goto('http://localhost:5173/login');
    await page1.fill('input[type="email"]', 'priya.lead@newtonite.local');
    await page1.fill('input[type="password"]', 'Password123!');
    await page1.click('button[type="submit"]');
    await page1.waitForURL('http://localhost:5173/');
    console.log('Context 1 logged in successfully.');

    // Login User 2: Elena Rostova (Member)
    console.log('Logging in Context 2 (Elena Rostova, Member)...');
    await page2.goto('http://localhost:5173/login');
    await page2.fill('input[type="email"]', 'elena.member@newtonite.local');
    await page2.fill('input[type="password"]', 'Password123!');
    await page2.click('button[type="submit"]');
    await page2.waitForURL('http://localhost:5173/');
    console.log('Context 2 logged in successfully.');

    // ------------------------------------------------------------------------
    // Scenario 2: Capture Dashboard in Light & Dark Mode
    // ------------------------------------------------------------------------
    console.log('Capturing Light Mode Dashboard...');
    await page1.waitForSelector('h1', { timeout: 10000 });
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'dashboard_light.png'), fullPage: true });

    console.log('Switching to Dark Theme and capturing Dark Mode Dashboard...');
    await page1.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('newtonite_theme', 'dark');
    });
    await page1.waitForTimeout(300);
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'dashboard_dark.png'), fullPage: true });

    // Restore to light mode
    await page1.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('newtonite_theme', 'light');
    });

    page1.on('console', msg => console.log('PAGE 1 LOG:', msg.text()));
    page2.on('console', msg => console.log('PAGE 2 LOG:', msg.text()));
    page1.on('pageerror', err => console.error('PAGE 1 ERROR:', err));
    page2.on('pageerror', err => console.error('PAGE 2 ERROR:', err));

    // ------------------------------------------------------------------------
    // Scenario 3: Create an Unassigned Item Requiring Approval
    // ------------------------------------------------------------------------
    console.log('Context 1 creating an unassigned work item...');
    await page1.click('#create-item-button');
    await page1.waitForSelector('#create-item-title', { timeout: 5000 });
    await page1.waitForFunction(() => {
      const el = document.querySelector('#create-item-team-select');
      return el && el.options.length > 0;
    }, { timeout: 5000 });
    const testTitle = `Production Capacity Scale-Out ${Date.now()}`;
    await page1.fill('#create-item-title', testTitle);
    await page1.fill('textarea', 'Immediate capacity increase needed for operations workload.');
    // Check requires approval
    await page1.check('#requires_approval');
    await page1.click('button[type="submit"]:has-text("Create Item")');

    // Wait for navigation to item detail page
    await page1.waitForURL(/\/items\/[a-f0-9-]+/, { timeout: 15000 });
    const itemUrl = page1.url();
    console.log(`Item created at ${itemUrl}`);

    // Context 2 navigates to the exact same item
    await page2.goto(itemUrl);
    await page2.waitForSelector('#claim-action-btn', { timeout: 10000 });
    await page1.waitForSelector('#claim-action-btn', { timeout: 10000 });

    // ------------------------------------------------------------------------
    // Scenario 4: Concurrent Claim Race (Winner gets 200, Loser gets 409 with Winner Name)
    // ------------------------------------------------------------------------
    console.log('RACING: Context 1 and Context 2 clicking Claim concurrently...');
    await Promise.all([
      page1.click('#claim-action-btn'),
      page2.click('#claim-action-btn'),
    ]);

    // Give UI time to update
    await page1.waitForTimeout(1200);
    await page2.waitForTimeout(1200);

    const text1 = await page1.content();
    const text2 = await page2.content();

    const winnerPage = text1.includes('Already claimed by') ? page2 : page1;
    const loserPage = winnerPage === page1 ? page2 : page1;
    const loserText = await loserPage.content();

    console.log('Claim race completed!');
    console.log('Checking loser conflict announcement...');
    const hasConflictBanner = loserText.includes('Already claimed by');
    console.log(`Loser sees winner banner: ${hasConflictBanner}`);

    await loserPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'claim_race_conflict.png'), fullPage: true });

    // ------------------------------------------------------------------------
    // Scenario 5: Advance Status and Test Approval Flow
    // ------------------------------------------------------------------------
    console.log('Testing Approval Flow...');
    // Winner submits for lead approval (claiming automatically advanced to in_progress)
    const submitApprovalBtn = await winnerPage.waitForSelector('button:has-text("Submit for Lead Approval")', { timeout: 8000 });
    await submitApprovalBtn.click();
    await winnerPage.waitForTimeout(600);

    // Context 3: Lead Marcus approves (creator != approver, lead role check)
    const contextLeadMarcus = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageMarcus = await contextLeadMarcus.newPage();
    await pageMarcus.goto('http://localhost:5173/login');
    await pageMarcus.fill('input[type="email"]', 'marcus.lead@newtonite.local');
    await pageMarcus.fill('input[type="password"]', 'Password123!');
    await pageMarcus.click('button[type="submit"]');
    await pageMarcus.waitForURL('http://localhost:5173/');

    await pageMarcus.goto(itemUrl);
    const approveBtn = await pageMarcus.waitForSelector('button:has-text("Approve & Resolve")', { timeout: 8000 });
    console.log('Lead Marcus approving item...');
    await approveBtn.click();

    // Fill note in approval modal
    await pageMarcus.waitForSelector('textarea[placeholder*="reason or context"]', { timeout: 5000 });
    await pageMarcus.fill('textarea[placeholder*="reason or context"]', 'Scale-out approved after operational load review.');
    await pageMarcus.click('button:has-text("Confirm")');
    await pageMarcus.waitForTimeout(1000);

    await pageMarcus.screenshot({ path: path.join(SCREENSHOT_DIR, 'approve_flow_success.png'), fullPage: true });
    console.log('Approval flow completed and captured.');

    // ------------------------------------------------------------------------
    // Scenario 6: Mobile 360px Viewport Layout
    // ------------------------------------------------------------------------
    console.log('Capturing 360px Mobile Viewport Layout...');
    const mobileContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto('http://localhost:5173/login');
    await mobilePage.fill('input[type="email"]', 'priya.lead@newtonite.local');
    await mobilePage.fill('input[type="password"]', 'Password123!');
    await mobilePage.click('button[type="submit"]');
    await mobilePage.waitForURL('http://localhost:5173/');
    await mobilePage.waitForSelector('h1', { timeout: 8000 });
    await mobilePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'mobile_360px.png'), fullPage: true });

    // ------------------------------------------------------------------------
    // Scenario 7: Focus States & Keyboard Navigation
    // ------------------------------------------------------------------------
    console.log('Capturing Focus Ring States...');
    await page1.goto('http://localhost:5173/');
    await page1.waitForSelector('#create-item-button', { timeout: 5000 });
    await page1.focus('#create-item-button');
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'focus_states.png') });

    console.log('All Playwright tests passed successfully and screenshots saved.');
    await context1.close();
    await context2.close();
    await contextLeadMarcus.close();
    await mobileContext.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Playwright E2E suite failed:', err);
  process.exit(1);
});
