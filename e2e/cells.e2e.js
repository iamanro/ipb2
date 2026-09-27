// Cell isolation end to end (docs/phase1-access.md, ADR 0002): three members
// of different cells, each in their own browser, against the signed-in
// server. Server tests prove the dispatcher's decisions; this proves what each
// cell's browser actually shows, and that live updates reach exactly the
// item's cells.
import { expect, test } from '@playwright/test';

import { AUTH_ADMIN_PASSWORD, AUTH_BASE_URL } from './authServer.js';

test.use({ baseURL: AUTH_BASE_URL });

const TEMPORARY_PASSWORD = 'temporary password';
const CHOSEN_PASSWORD = 'e2e chosen password';
const MEMBERS = {
  'white-gm': { cell: 'white', role: 'game-master' },
  'blue-analyst': { cell: 'blue', role: 'analyst' },
  'red-analyst': { cell: 'red', role: 'analyst' },
};

async function postOk(request, url, data, method = 'post') {
  const response = await request[method](url, { data });
  expect(response.ok(), `${method.toUpperCase()} ${url}: ${await response.text()}`).toBe(true);
  return response.json();
}

/** Signs `request` (a browser context's or a standalone one) in, replacing a temporary password. */
async function signIn(request, name, password) {
  const { user } = await postOk(request, '/api/auth/login', { name, password });
  if (user.must_change_password) {
    await postOk(request, '/api/auth/password', { current: password, next: CHOSEN_PASSWORD });
  }
}

/** Opens the Reports tab and waits for its list and the live stream, so no later change is missed. */
async function openReports(page) {
  const stream = page.waitForResponse((response) => response.url().endsWith('/api/live'));
  await page.goto('/exercise/?tab=reports');
  await stream;
  await expect(page.getByRole('heading', { name: 'Reports & evidence' })).toBeVisible();
}

async function memberPage(browser, name) {
  const context = await browser.newContext({ baseURL: AUTH_BASE_URL });
  await signIn(context.request, name, TEMPORARY_PASSWORD);
  const page = await context.newPage();
  await openReports(page);
  return page;
}

const reportRows = (page) => page.locator('.report-row');

test('a report stays in its cell until released, a release is read-only, and reassigning moves it', async ({
  browser,
  playwright,
}) => {
  const admin = await playwright.request.newContext({ baseURL: AUTH_BASE_URL });
  await signIn(admin, 'admin', AUTH_ADMIN_PASSWORD);
  for (const [name, membership] of Object.entries(MEMBERS)) {
    await postOk(admin, '/api/auth/users', { name, password: TEMPORARY_PASSWORD });
    await postOk(admin, `/api/auth/members/${name}`, membership, 'put');
  }

  // Blue signs in through the real screens: sign-in, then the forced password change.
  const blueContext = await browser.newContext({ baseURL: AUTH_BASE_URL });
  const blue = await blueContext.newPage();
  await blue.goto('/exercise/?tab=reports');
  await blue.getByLabel('Name').fill('blue-analyst');
  await blue.getByLabel('Password', { exact: true }).fill(TEMPORARY_PASSWORD);
  await blue.getByRole('button', { name: 'Sign in' }).click();
  await blue.getByLabel('Current password').fill(TEMPORARY_PASSWORD);
  await blue.getByLabel(/^New password/).fill(CHOSEN_PASSWORD);
  await blue.getByLabel('Confirm new password').fill(CHOSEN_PASSWORD);
  await blue.locator('form.login-card').getByRole('button', { name: 'Change password' }).click();
  await expect(blue.getByRole('heading', { name: 'Reports & evidence' })).toBeVisible();
  await openReports(blue);

  const white = await memberPage(browser, 'white-gm');
  const red = await memberPage(browser, 'red-analyst');

  await test.step('IPB opens the Blue cell study automatically, while White can switch studies', async () => {
    const blueStudies = (await (await blue.context().request.get('/api/ipb/studies')).json()).items;
    expect(blueStudies).toHaveLength(1);
    expect(blueStudies[0].owner_cell).toBe('blue');

    await blue.goto('/ipb/');
    await expect(blue.locator('#worksheet-study-name')).toHaveText(blueStudies[0].name);
    await expect(blue.locator('#study-toggle')).toBeDisabled();
    await expect(blue.locator('#study-menu')).toBeHidden();
    await expect(blue.locator('#create-study')).toBeHidden();
    await expect(blue.locator('#map-empty-create')).toBeHidden();
    await blue.keyboard.press('/');
    await expect(blue.locator('#study-menu')).toBeHidden();

    const whiteStudies = (await (await white.context().request.get('/api/ipb/studies')).json())
      .items;
    const blueStudy = whiteStudies.find((study) => study.owner_cell === 'blue');
    expect(blueStudy).toBeTruthy();
    await white.goto('/ipb/');
    const whiteStudy = whiteStudies.find((study) => study.cell_study_cell === 'white');
    await expect(white.locator('#worksheet-study-name')).toHaveText(whiteStudy.name);
    await expect(white.locator('#study-toggle')).toBeEnabled();
    await white.locator('#study-toggle').click();
    await expect(white.locator('#create-study')).toBeVisible();
    await white
      .locator('.study-row', { hasText: blueStudy.name })
      .getByRole('button', { name: blueStudy.name })
      .click();
    await expect(white.locator('#worksheet-study-name')).toHaveText(blueStudy.name);

    const legacy = await postOk(white.context().request, '/api/ipb/studies', {
      name: 'White legacy IPB e2e',
      owner_cell: 'white',
    });
    await white.goto(`/ipb/?study=${legacy.id}&step=3`);
    await expect(white.locator('#worksheet-study-name')).toHaveText(legacy.name);
    await white.getByRole('link', { name: 'Exercise' }).click();
    await expect(white).toHaveURL(/\/exercise\//);
    await white.getByRole('link', { name: 'IPB' }).click();
    await expect(white.locator('#worksheet-study-name')).toHaveText(legacy.name);
    await expect(white).toHaveURL(new RegExp(`study=${legacy.id}&step=3`));

    await openReports(blue);
    await openReports(white);
  });

  const report = await postOk(blueContext.request, '/api/exercise/reports', {
    text: 'Two BMPs moving north at the bridge',
    reliability: 'B',
    credibility: 2,
  });

  await test.step('White and Blue see the new report live; Red neither sees nor can fetch it', async () => {
    await expect(reportRows(white)).toHaveCount(1);
    await expect(reportRows(white).locator('.cell-badge')).toHaveText('Blue');
    await expect(reportRows(blue)).toHaveCount(1);
    await expect(reportRows(blue).getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(reportRows(blue).getByRole('button', { name: 'Delete' })).toBeVisible();

    await expect(red.getByText('No reports yet.')).toBeVisible();
    const redRequest = red.context().request;
    expect(await (await redRequest.get('/api/exercise/reports')).json()).toEqual([]);
    expect((await redRequest.get(`/api/exercise/reports/${report.id}`)).status()).toBe(404);
  });

  await test.step('Blue releases it to Red; Red gets it live, read-only', async () => {
    await blue.getByRole('button', { name: 'Expand report details' }).click();
    await blue.getByRole('button', { name: 'Release…' }).click();
    const dialog = blue.locator('dialog.release-dialog');
    await dialog.getByLabel('Red').check();
    await dialog.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(reportRows(red)).toHaveCount(1);
    await expect(reportRows(red).locator('.cell-badge')).toHaveText('Blue');
    await expect(reportRows(red).getByRole('button')).toHaveCount(1); // only the expand toggle
    await red.getByRole('button', { name: 'Expand report details' }).click();
    const detail = red.locator('.report-detail-row');
    await expect(detail).toContainText('Two BMPs moving north at the bridge');
    await expect(detail.locator('.cell-badge-chip')).toHaveText('Red');
    await expect(detail.getByRole('button', { name: 'Release…' })).toHaveCount(0);
    await expect(detail.locator('.owner-reassign')).toHaveCount(0);

    const edit = await red.context().request.patch(`/api/exercise/reports/${report.id}`, {
      data: { text: 'Red rewrites Blue' },
    });
    expect(edit.status()).toBe(403);
  });

  await test.step('White takes it over; Blue loses it live, Red keeps its release', async () => {
    await white.getByRole('button', { name: 'Expand report details' }).click();
    await white.locator('.report-detail-row .owner-reassign select').selectOption('white');

    await expect(blue.getByText('No reports yet.')).toBeVisible();
    await expect(reportRows(red).locator('.cell-badge')).toHaveText('White');
    await expect(reportRows(white).locator('.cell-badge')).toHaveText('White');
  });

  await test.step('White authors privately, then sends only the previewed development to Blue', async () => {
    await white.goto('/exercise/');
    await expect(white.getByRole('heading', { name: 'Instructor desk' })).toBeVisible();
    const story = white.locator('.instructor-story');
    await story.getByLabel('Title', { exact: true }).fill('Private exercise story');
    await story
      .getByLabel('Blue briefing', { exact: false })
      .fill('Assess movement near the bridge.');
    await story
      .getByLabel('Instructor notes (White only)')
      .fill('SECRET: reserve force arrives tomorrow');
    await story.getByRole('button', { name: 'Save story' }).click();
    await expect(story).not.toHaveAttribute('open');
    await white.getByRole('button', { name: 'New situation', exact: true }).click();
    await white.locator('dialog[open] input').fill('Private decoy situation');
    await white.getByRole('button', { name: 'Create situation', exact: true }).click();
    const situation = white.locator('.instructor-situation-card.open');
    await situation.getByLabel('Ground truth (White only)').fill('SECRET: this patrol is a decoy');
    await situation.getByRole('button', { name: 'Save situation', exact: true }).click();
    await situation.getByRole('button', { name: 'Compose inject for this situation…' }).click();
    await white.getByLabel('Message text').fill('Patrol reports two vehicles at the bridge.');
    await expect(white.locator('.instructor-composer-preview')).toContainText(
      'Patrol reports two vehicles',
    );
    await white.getByRole('button', { name: 'Save draft', exact: true }).click();
    const history = white.locator('.instructor-history');
    await expect(history).toContainText('Draft — not sent');
    for (const page of [blue, red]) {
      expect((await page.context().request.get('/api/exercise/instructor')).status()).toBe(403);
      expect(await (await page.context().request.get('/api/exercise/messages')).json()).toEqual([]);
      expect(
        JSON.stringify(await (await page.context().request.get('/api/exercise/activity')).json()),
      ).not.toContain('Private decoy situation');
      await page.goto('/exercise/?tab=scenario');
      await expect(page.getByRole('heading', { name: 'Briefing & scenario clock' })).toBeVisible();
      await expect(page.locator('[data-tab="instructor"]')).toBeHidden();
    }
    await history.getByRole('button', { name: 'Send now', exact: true }).click();
    const confirmation = white.getByRole('dialog', { name: 'Confirm delivery' });
    await expect(confirmation).toContainText('Patrol reports two vehicles at the bridge.');
    await expect(confirmation).not.toContainText('SECRET');
    await confirmation.getByRole('button', { name: 'Confirm send', exact: true }).click();
    await expect(blue.locator('.message-text')).toHaveText([
      'Patrol reports two vehicles at the bridge.',
    ]);
    await expect(red.locator('.message-text')).toHaveCount(0);
    await expect(blue.locator('#panel')).not.toContainText('SECRET');
    await expect(history).toContainText('Delivered');
  });

  await test.step("An admin's reset reloads every member's browser into the emptied exercise", async () => {
    const { name } = await (await admin.get('/api/auth/exercise')).json();
    await postOk(admin, '/api/auth/exercise/reset', { name: 'After the e2e run', confirm: name });
    for (const page of [white, blue, red]) {
      await expect(page.getByText('Not assigned to the current exercise')).toBeVisible();
    }
  });

  await admin.dispose();
});
