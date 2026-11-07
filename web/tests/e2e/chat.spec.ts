// Scenario 1 (specs/001-secure-realtime-chat/quickstart.md): two people, two browsers, one
// encrypted conversation: online, offline, ordering, no duplicates, and nothing readable on the
// server. Runs against a real relay and database (scripts/e2e.sh).

import { execFileSync } from 'node:child_process';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const SEED = process.env.E2E_SEED_INVITE ?? '';
const PASSCODE = 'correct horse battery staple';

interface Person {
  context: BrowserContext;
  page: Page;
}

async function person(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  // Browser-side problems should fail the run loudly, not hide behind a timeout.
  page.on('pageerror', (error) => console.log(`[${name}] page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[${name}] console: ${message.text()}`);
  });
  return { context, page };
}

async function fillAccountForm(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Passcode', { exact: true }).fill(PASSCODE);
  await page.getByLabel('Passcode again').fill(PASSCODE);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('recovery-key')).toHaveText(/^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
  await page.getByLabel('I have written it down').check();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function signUp(page: Page, invite: string, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Invite link').fill(invite);
  await fillAccountForm(page, name);
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  // Wait until the message shows in this person's own list before the next one is written.
  await expect(page.getByRole('list', { name: 'Messages' }).getByText(text)).toBeVisible();
}

async function makeInviteLink(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Invite someone' }).click();
  await page.getByRole('button', { name: 'Make an invite link' }).click();
  const link = (await page.getByTestId('invite-link').textContent()) ?? '';
  expect(link).toContain('#/join/');
  return link;
}

async function offlineCatchUp(alice: Person, bob: Person): Promise<void> {
  await bob.context.setOffline(true);
  await send(alice.page, 'second while you are away');
  await send(alice.page, 'third while you are away');
  await bob.context.setOffline(false);
  const bobMessages = bob.page.getByRole('list', { name: 'Messages' }).getByRole('listitem');
  await expect(bobMessages).toHaveCount(3, { timeout: 15000 });
  await expect(bobMessages.nth(1)).toContainText('second while you are away');
  await expect(bobMessages.nth(2)).toContainText('third while you are away');
}

/** Everything an operator with full database access could read, as text. */
function everythingInTheDatabase(): string {
  const url = process.env.DATABASE_URL ?? '';
  const psql = (sql: string) =>
    execFileSync('psql', ['-At', url, '-c', sql], { encoding: 'latin1' });
  const tables = psql("select tablename from pg_tables where schemaname = 'public'")
    .split('\n')
    .filter(Boolean);
  return tables.map((t) => psql(`select row_to_json(t)::text from "${t}" t`)).join('\n');
}

function expectNothingReadableOnServer(secrets: string[]): void {
  const dump = everythingInTheDatabase();
  expect(dump.length).toBeGreaterThan(100); // the dump really contains the rows
  for (const secret of secrets) expect(dump).not.toContain(secret);
}

test.describe('Scenario 1: two people, one encrypted conversation', () => {
  test.skip(SEED === '', 'run through scripts/e2e.sh, which provides a relay and a seed invite');

  test('sign up, connect by invite, message online and offline, nothing readable on the server', async ({
    browser,
  }) => {
    const alice = await person(browser, 'Alice');
    const bob = await person(browser, 'Bob');

    await test.step('Alice signs up with the operator invite', async () => {
      await signUp(alice.page, SEED, 'Alice Anderson');
      await expect(alice.page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
    });

    await test.step("Bob opens Alice's link, signs up and lands in a conversation", async () => {
      const link = await makeInviteLink(alice.page);
      // The test relay is not at the link's origin, so open the same fragment on this site.
      await bob.page.goto(link.slice(link.indexOf('/#/join/')));
      await fillAccountForm(bob.page, 'Bob Baker');
      await expect(bob.page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    });

    await test.step('a message arrives at once and is marked delivered', async () => {
      await alice.page.goto('/#/');
      await alice.page.getByRole('link', { name: 'New conversation' }).click();
      await send(alice.page, 'hello Bob, this is a secret');
      await expect(bob.page.getByText('hello Bob, this is a secret')).toBeVisible({
        timeout: 5000,
      });
      await expect(alice.page.getByText('Delivered')).toBeVisible({ timeout: 5000 });
    });

    await test.step('Bob is offline, then catches up in order, once', () =>
      offlineCatchUp(alice, bob));

    await test.step('the server holds nothing readable', () =>
      expectNothingReadableOnServer([
        'hello Bob',
        'secret',
        'Alice Anderson',
        'Bob Baker',
        'while you are away',
      ]));
  });
});
