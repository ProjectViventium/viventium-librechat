import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { MongoClient } from 'mongodb';

function requireDedicatedFixtureMongoUri(): string {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri || process.env.VIVENTIUM_E2E_CHANNEL_FIXTURES !== 'true') {
    throw new Error('Connected-channel fixtures require explicit isolated-QA opt-in');
  }
  const databaseName = new URL(mongoUri).pathname.replace(/^\//, '');
  if (!/(?:qa|test|e2e)/i.test(databaseName)) {
    throw new Error('Connected-channel fixtures require a QA/test database name');
  }
  return mongoUri;
}

test.describe('Connected Channels', () => {
  test('guides a signed-in administrator without persisting typed secrets', async ({ page }) => {
    await page.goto('/c/new');

    await page.getByTestId('nav-user').click();
    await page.getByRole('option', { name: 'Connected Channels' }).click();

    // LibreChat keeps responsive dialog shells mounted; target the surface a user can see.
    const dialog = page.getByRole('dialog', { name: /Settings/ }).last();
    const channelsTab = dialog.getByRole('tab', { name: 'Channels' });
    const accountTab = dialog.getByRole('tab', { name: 'Account' });
    await expect(channelsTab).toBeVisible();
    await expect(channelsTab).toHaveAttribute('data-state', 'active');
    await channelsTab.focus();
    await channelsTab.press('ArrowDown');
    await expect(accountTab).toBeFocused();
    await expect(accountTab).toHaveAttribute('data-state', 'active');
    await accountTab.press('ArrowUp');
    await expect(channelsTab).toBeFocused();
    await expect(channelsTab).toHaveAttribute('data-state', 'active');
    await expect(
      dialog.getByRole('heading', { name: 'Connect your messaging accounts' }),
    ).toBeVisible();

    for (const provider of ['Telegram', 'Slack', 'WhatsApp']) {
      await expect(dialog.getByRole('group', { name: `${provider} pairing` })).toBeVisible();
      await expect(dialog.getByRole('region', { name: `${provider} channel` })).toBeVisible();
    }

    const accessibility = await new AxeBuilder({ page })
      .include('[role="tabpanel"][data-state="active"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);

    const beforeStorage = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));

    const telegram = dialog.getByRole('region', { name: 'Telegram channel' });
    await telegram.getByRole('button', { name: 'Set up' }).click();
    const telegramToken = telegram.getByLabel('Bot token');
    await expect(telegramToken).toHaveAttribute('type', 'password');
    await expect(telegram.getByRole('link', { name: 'Open BotFather' })).toHaveAttribute(
      'href',
      'https://t.me/BotFather',
    );
    await telegramToken.fill('synthetic-browser-only-telegram-secret');
    await telegram.getByRole('button', { name: 'Cancel' }).click();
    await expect(telegramToken).toBeHidden();

    const slack = dialog.getByRole('region', { name: 'Slack channel' });
    await slack.getByRole('button', { name: 'Set up' }).click();
    await expect(slack.getByLabel('App token (xapp-)')).toHaveAttribute('type', 'password');
    await expect(slack.getByLabel('Bot token (xoxb-)')).toHaveAttribute('type', 'password');
    const manifest = await slack.getByLabel('Slack app manifest').inputValue();
    expect(manifest).toContain('"socket_mode_enabled": true');
    expect(manifest).not.toMatch(/xapp-|xoxb-/);
    await slack.getByLabel('App token (xapp-)').fill('xapp-synthetic-browser-only');
    await slack.getByLabel('Bot token (xoxb-)').fill('xoxb-synthetic-browser-only');
    await slack.getByRole('button', { name: 'Cancel' }).click();

    const whatsapp = dialog.getByRole('region', { name: 'WhatsApp channel' });
    await whatsapp.getByRole('button', { name: 'Set up' }).click();
    await expect(whatsapp.getByLabel('Public Viventium HTTPS address')).toHaveAttribute(
      'placeholder',
      'https://api.example.com',
    );
    await expect(
      whatsapp.getByRole('link', { name: 'Open the public HTTPS setup guide' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/ProjectViventium/viventium/blob/main/docs/requirements_and_learnings/47_Remote_Access_and_Tunneling.md',
    );
    await expect(whatsapp.getByLabel('Cloud API access token')).toHaveAttribute('type', 'password');
    await expect(whatsapp.getByLabel('Meta app secret')).toHaveAttribute('type', 'password');
    await expect(whatsapp.getByLabel('Webhook verify token')).toHaveAttribute('type', 'password');
    await whatsapp
      .getByLabel('Cloud API access token')
      .fill('synthetic-browser-only-whatsapp-secret');
    await whatsapp.getByLabel('Public Viventium HTTPS address').fill('https://api.example.test');
    await whatsapp.getByRole('button', { name: 'Cancel' }).click();

    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).toBe(
      beforeStorage.local,
    );
    expect(await page.evaluate(() => JSON.stringify(window.sessionStorage))).toBe(
      beforeStorage.session,
    );

    await page.setViewportSize({ width: 320, height: 720 });
    await expect(channelsTab).toBeVisible();
    await expect(dialog.getByRole('tablist', { name: 'Settings' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    );
    await channelsTab.focus();
    await channelsTab.press('ArrowRight');
    await expect(accountTab).toBeFocused();
    await expect(accountTab).toHaveAttribute('data-state', 'active');
    await channelsTab.click();
    await expect(channelsTab).toHaveAttribute('data-state', 'active');
    await expect(dialog.getByRole('region', { name: 'WhatsApp channel' })).toBeVisible();
    await whatsapp.getByRole('button', { name: 'Set up' }).click();
    const mobilePublicOrigin = whatsapp.getByLabel('Public Viventium HTTPS address');
    await mobilePublicOrigin.scrollIntoViewIfNeeded();
    await expect(mobilePublicOrigin).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await whatsapp.getByRole('button', { name: 'Cancel' }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Close Settings' }).click();
    await page.evaluate(() => localStorage.setItem('navVisible', 'false'));
    await page.reload();

    const accountSettings = page.getByTestId('nav-user');
    const openSidebar = page.getByTestId('open-sidebar-button');
    await expect(openSidebar).toBeVisible();
    await openSidebar.click();
    await expect(accountSettings).toBeVisible();
    await accountSettings.click();
    await page.getByRole('option', { name: 'Connected Channels' }).click();
    const reopenedDialog = page.getByRole('dialog', { name: /Settings/ }).last();
    for (const provider of ['Telegram', 'Slack', 'WhatsApp']) {
      await expect(
        reopenedDialog.getByRole('region', { name: `${provider} channel` }),
      ).toBeVisible();
    }
  });

  test('keeps recovery local and clear when a provider connection fails', async ({ page }) => {
    const syntheticSecret = 'synthetic-browser-only-telegram-failure';
    let submittedBody = '';
    await page.route('**/api/viventium/channels/telegram/connect', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      submittedBody = route.request().postData() ?? '';
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'connection_unavailable' }),
      });
    });

    await page.goto('/c/new');
    await page.getByTestId('nav-user').click();
    await page.getByRole('option', { name: 'Connected Channels' }).click();

    const dialog = page.getByRole('dialog', { name: /Settings/ }).last();
    const telegram = dialog.getByRole('region', { name: 'Telegram channel' });
    await telegram.getByRole('button', { name: 'Set up' }).click();
    const token = telegram.getByLabel('Bot token');
    await token.fill(syntheticSecret);
    await telegram.getByRole('button', { name: 'Save connection' }).click();

    await expect(
      page.getByText('The connection could not be saved. Check the fields and try again.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(token).toHaveValue(syntheticSecret);
    expect(JSON.parse(submittedBody)).toEqual({
      channel: 'telegram',
      botToken: syntheticSecret,
      dmPolicy: 'PAIRING',
    });
    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain(
      syntheticSecret,
    );
    expect(await page.evaluate(() => JSON.stringify(window.sessionStorage))).not.toContain(
      syntheticSecret,
    );
  });

  test('disconnects and reconnects from Settings without database repair', async ({ page }) => {
    const submittedTokens: string[] = [];
    await page.route('**/api/viventium/channels', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          channels: [
            { channel: 'telegram', state: 'disconnected' },
            { channel: 'slack', state: 'not_configured' },
            { channel: 'whatsapp', state: 'not_configured' },
          ],
        }),
      });
    });
    await page.route('**/api/viventium/channels/telegram/connect', async (route) => {
      const body = route.request().postDataJSON() as { botToken: string };
      submittedTokens.push(body.botToken);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          channel: {
            channel: 'telegram',
            state: 'connected',
            displayName: '@synthetic_viventium_bot',
          },
        }),
      });
    });
    await page.route('**/api/viventium/channels/telegram/disconnect', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ channel: { channel: 'telegram', state: 'disconnected' } }),
      });
    });

    await page.goto('/c/new');
    await page.getByTestId('nav-user').click();
    await page.getByRole('option', { name: 'Connected Channels' }).click();

    const dialog = page.getByRole('dialog', { name: /Settings/ }).last();
    const telegram = dialog.getByRole('region', { name: 'Telegram channel' });
    await expect(telegram.getByText('Disconnected')).toBeVisible();
    await telegram.getByRole('button', { name: 'Set up' }).click();
    await telegram.getByLabel('Bot token').fill('synthetic-reconnect-token-one');
    await telegram.getByRole('button', { name: 'Save connection' }).click();
    await expect(telegram.getByText('Connected')).toBeVisible();

    await telegram.getByRole('button', { name: 'Disconnect' }).click();
    await expect(telegram.getByText('Disconnect this channel?')).toBeVisible();
    await telegram.getByRole('button', { name: 'Disconnect' }).last().click();
    await expect(telegram.getByText('Disconnected')).toBeVisible();

    await telegram.getByRole('button', { name: 'Set up' }).click();
    await telegram.getByLabel('Bot token').fill('synthetic-reconnect-token-two');
    await telegram.getByRole('button', { name: 'Save connection' }).click();
    await expect(telegram.getByText('Connected')).toBeVisible();
    expect(submittedTokens).toEqual([
      'synthetic-reconnect-token-one',
      'synthetic-reconnect-token-two',
    ]);
  });

  test('warns before a user retries an uncertain provider delivery', async ({ page }) => {
    await page.route('**/api/viventium/channels', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          channels: [
            {
              channel: 'telegram',
              state: 'connected',
              issueCode: 'delivery_uncertain',
            },
            { channel: 'slack', state: 'not_configured' },
            { channel: 'whatsapp', state: 'not_configured' },
          ],
        }),
      });
    });

    await page.goto('/c/new');
    await page.getByTestId('nav-user').click();
    await page.getByRole('option', { name: 'Connected Channels' }).click();

    const dialog = page.getByRole('dialog', { name: /Settings/ }).last();
    const telegram = dialog.getByRole('region', { name: 'Telegram channel' });
    await expect(
      telegram.getByText(
        'The provider may have received the last reply, but Viventium could not confirm it. Check the conversation before sending that message again.',
      ),
    ).toBeVisible();
  });

  test('creates a focused one-use pairing code and persists only its hash', async ({ page }) => {
    const mongoUri = requireDedicatedFixtureMongoUri();
    const mongo = new MongoClient(mongoUri);
    await mongo.connect();
    const db = mongo.db();
    const user = await db.collection('users').findOne({
      email: process.env.E2E_USER_EMAIL,
    });
    if (!user) {
      throw new Error('Synthetic E2E user was not created');
    }
    let fixtureId;

    try {
      const existingConnection = await db
        .collection('channelconnections')
        .findOne({ channel: 'telegram' });
      if (existingConnection) {
        throw new Error('Dedicated channel QA database is not pristine');
      }
      const fixture = await db.collection('channelconnections').insertOne({
        channel: 'telegram',
        state: 'connected',
        accountId: 'synthetic-e2e',
        accountLabel: 'Synthetic Telegram QA',
        displayName: 'Synthetic Telegram QA',
        encryptedCredentials: 'synthetic-browser-fixture-not-decrypted',
        callbackId: 'synthetic-browser-telegram-callback',
        createdBy: user._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      fixtureId = fixture.insertedId;

      await page.goto('/c/new');
      await page.getByTestId('nav-user').click();
      await page.getByRole('option', { name: 'Connected Channels' }).click();

      const dialog = page.getByRole('dialog', { name: /Settings/ }).last();
      const pairingGroup = dialog.getByRole('group', { name: 'Telegram pairing' });
      await pairingGroup.getByRole('button', { name: 'Connect Telegram' }).click();

      const output = pairingGroup.getByRole('status', {
        name: 'Telegram one-use pairing code',
      });
      await expect(output).toBeVisible();
      await expect(output).toBeFocused();
      const code = (await output.textContent())?.trim() ?? '';
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      await pairingGroup.getByRole('button', { name: 'Copy pairing code' }).click();
      await expect(pairingGroup.getByText('Pairing code copied')).toBeVisible();

      expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain(code);
      expect(await page.evaluate(() => JSON.stringify(window.sessionStorage))).not.toContain(code);
      const persisted = await db.collection('channelpairingcodes').findOne({
        channel: 'telegram',
        libreChatUserId: user._id,
      });
      expect(persisted?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(persisted)).not.toContain(code);
    } finally {
      await db.collection('channelpairingcodes').deleteMany({ libreChatUserId: user._id });
      if (fixtureId) {
        await db.collection('channelconnections').deleteOne({ _id: fixtureId });
      }
      await mongo.close();
    }
  });

  test('shows a regular user only self-service pairing, never installation secrets', async ({
    browser,
    baseURL,
  }) => {
    const mongoUri = requireDedicatedFixtureMongoUri();
    const email = `qa.channels.user.${Date.now()}@example.test`;
    const password = 'Synthetic-User-QA-Only-2026!';
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();

    await context.clearCookies();
    await page.goto('/login');
    await page.getByRole('link', { name: 'Sign up' }).click();
    await page.getByLabel('Full name').fill('Synthetic Channel User');
    await page.getByLabel('Email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('confirm_password').fill(password);
    await page.getByLabel('Submit registration').click();
    await page.waitForURL('**/c/new');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="password"]').press('Enter');
    await page.waitForURL('**/c/new');

    try {
      await page.getByTestId('nav-user').click();
      await page.getByRole('option', { name: 'Connected Channels' }).click();
      const dialog = page.getByRole('dialog', { name: /Settings/ }).last();
      await expect(
        dialog.getByRole('heading', { name: 'Connect your messaging accounts' }),
      ).toBeVisible();
      await expect(dialog.getByRole('group', { name: 'Telegram pairing' })).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Connected Channels' })).toHaveCount(0);
      await expect(dialog.getByRole('region', { name: 'Telegram channel' })).toHaveCount(0);
      await expect(dialog.getByLabel('Bot token')).toHaveCount(0);
    } finally {
      const mongo = new MongoClient(mongoUri);
      await mongo.connect();
      const db = mongo.db();
      const user = await db.collection('users').findOne({ email });
      if (user) {
        await Promise.all([
          db.collection('sessions').deleteMany({ user: user._id }),
          db.collection('tokens').deleteMany({ userId: user._id }),
          db.collection('balances').deleteMany({ user: user._id }),
          db.collection('transactions').deleteMany({ user: user._id }),
          db.collection('aclentries').deleteMany({ principalId: user._id }),
        ]);
        await db.collection('users').deleteOne({ _id: user._id });
      }
      await mongo.close();
      await context.close();
    }
  });
});
