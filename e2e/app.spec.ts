import { expect, test, type Page } from '@playwright/test';
import { BASE, api, startServer, stopServer } from './server';

// Full UI workflow against the production build, using DEMO (synthetic) data so it runs without an API key or open market.
const SHOTS = process.env.LTS_SHOTS ?? 'test-results';
test.describe.configure({ mode: 'serial' });
test.beforeAll(startServer);
test.afterAll(stopServer);

async function ticketOrder(page: Page, o: { side?: string; qty: string; type?: string; limit?: string }) {
  if (o.side) await page.getByLabel(/^Action/).first().selectOption({ label: o.side });
  await page.getByLabel(/^Quantity/).first().fill(o.qty);
  await page.getByLabel(/^Order type/).first().selectOption({ label: o.type ?? 'Market' });
  if (o.limit) await page.getByLabel(/^Limit price/).first().fill(o.limit);
  await page.getByRole('button', { name: 'Preview order' }).click();
  await page.getByRole('button', { name: 'Confirm simulated order' }).click();
  await expect(page.getByText(/Order accepted/)).toBeVisible();
}

test('create account, trade, modify, cancel, close, analytics', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: 'Create your first simulated account' })).toBeVisible();
  await page.getByLabel(/^Account name/).fill('E2E Demo Margin');
  await page.getByLabel(/^Starting balance/).fill('200000');
  await page.getByLabel(/^Account type/).selectOption('margin');
  await page.getByLabel(/^Market data/).selectOption('demo');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.stat', { hasText: 'Net liquidation value' })).toContainText('$200,000.00');
  await expect(page.getByText('SIMULATED', { exact: true })).toBeVisible();

  // search
  await page.getByRole('link', { name: 'Markets' }).click();
  await page.getByLabel('Symbol or name').fill('DEMO');
  await page.getByRole('button', { name: /^DEMO-AAA Demo Alpha/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /DEMO-AAA/ })).toBeVisible();
  await expect(page.locator('.quote-big .badge.demo')).toBeVisible({ timeout: 10_000 });

  // market buy
  await ticketOrder(page, { qty: '10' });
  await expect(page.locator('.kv', { hasText: /^Long/ })).toContainText('10', { timeout: 15_000 });

  // limit buy far below -> modify -> cancel
  await ticketOrder(page, { qty: '5', type: 'Limit', limit: '50.00' });
  await page.getByRole('link', { name: 'Orders' }).click();
  await page.getByRole('row', { name: /buy 5 DEMO-AAA limit @ \$50\.00/ }).click();
  await expect(page.getByRole('dialog')).toContainText('above limit');
  await page.getByRole('button', { name: 'Modify' }).click();
  await page.getByLabel('Limit price').fill('55.00');
  await page.getByRole('button', { name: 'Submit modification' }).click();
  await expect(page.getByRole('row', { name: /buy 5 DEMO-AAA limit @ \$55\.00/ })).toBeVisible();
  await page.getByRole('row', { name: /buy 5 DEMO-AAA limit @ \$55\.00/ }).click();
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByRole('dialog')).toContainText('canceled');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Canceled / rejected / expired' }).click();
  await expect(page.getByRole('row', { name: /replaced/ })).toBeVisible();

  // close the position
  await page.goto(`${BASE}/#/instrument/DEMO-AAA`);
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  await ticketOrder(page, { side: 'Sell', qty: '10' });
  await expect(page.getByText('No position in DEMO-AAA.')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Analytics' }).click();
  await expect(page.locator('.stat', { hasText: 'Closed trades' })).toContainText('1');
  await page.getByRole('tab', { name: 'Trades' }).click();
  await expect(page.getByRole('row', { name: /DEMO-AAA/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/desktop-analytics.png`, fullPage: true });
});

test('explanation mode on/off and keyboard help', async ({ page }) => {
  await page.goto(`${BASE}/#/overview`);
  await expect(page.locator('.help-btn').first()).toBeVisible();
  const help = page.locator('.help-btn').first();
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.help-pop').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.help-pop')).toHaveCount(0);
  await page.getByRole('button', { name: /Explain on/ }).click();
  await expect(page.locator('.help-btn')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /Explain off/ })).toBeVisible(); // persisted
  await page.getByRole('button', { name: /Explain off/ }).click();
  await expect(page.locator('.help-btn').first()).toBeVisible();
});

test('second account, switching, deposit, backup restore', async ({ page }) => {
  await page.goto(`${BASE}/#/settings/accounts`);
  await page.getByRole('button', { name: '+ New account' }).click();
  await page.getByLabel(/^Account name/).fill('E2E Cash');
  await page.getByLabel(/^Starting balance/).fill('50000');
  await page.getByLabel(/^Market data/).selectOption('demo');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.stat', { hasText: 'Net liquidation value' })).toContainText('$50,000.00');
  const margin = (await api<{ id: string; name: string }[]>('/api/accounts')).find((a) => a.name === 'E2E Demo Margin')!;
  await page.getByLabel('Current account').selectOption(margin.id);
  await expect(page.locator('.stat', { hasText: 'Net liquidation value' })).not.toContainText('$50,000.00');

  const accounts = await api<{ id: string; name: string }[]>('/api/accounts');
  const cash = accounts.find((a) => a.name === 'E2E Cash')!;
  await api(`/api/accounts/${cash.id}/cash`, { kind: 'DEPOSIT', amount: '1000', memo: 'e2e' });
  const backup = await (await fetch(`${BASE}/api/export?accountId=${cash.id}`)).text();

  await page.goto(`${BASE}/#/settings/backups`);
  await page.getByLabel('Backup file (.json)').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.getByText(/exists here/)).toBeVisible();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText(/Imported 1 account/)).toBeVisible();
  const after = await api<{ name: string; equity: string }[]>('/api/accounts');
  expect(after.find((a) => a.name === 'E2E Cash (imported)')?.equity).toBe('51000.00');
  // corrupt file is rejected without changes
  await page.getByLabel('Backup file (.json)').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(backup.replace('"51000', '"99999').replace('e2e', 'tampered')) });
  await expect(page.getByText(/Checksum mismatch/)).toBeVisible();
});

test('engine keeps working with the browser closed; restart keeps state and reports the gap', async ({ browser }) => {
  const accounts = await api<{ id: string; name: string }[]>('/api/accounts');
  const acc = accounts.find((a) => a.name === 'E2E Demo Margin')!;
  // place a bracket-like OTO through the API, no browser open: buy then a tight 0.01% trailing stop exit
  const r = await api<{ orders: { id: string }[]; preview: { errors: string[] } | null }>('/api/orders', {
    accountId: acc.id, symbol: 'DEMO-BBB', clientKey: 'e2e-closed-browser-1', strategy: 'oto',
    legs: [{ side: 'buy', qty: '20', type: 'limit', limitPrice: '40.00', tif: 'gtc' }, { side: 'sell', qty: '20', type: 'trailing_stop', trailType: 'amount', trailValue: '0.01', tif: 'gtc' }],
  });
  expect(r.preview?.errors ?? []).toEqual([]);
  const exitId = r.orders[1]!.id;
  let status = '';
  for (let i = 0; i < 60 && status !== 'filled'; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    status = (await api<{ order: { status: string } }>(`/api/orders/${exitId}`)).order.status;
  }
  expect(status).toBe('filled');

  // an order that will not fill, then restart the service
  await api('/api/orders', { accountId: acc.id, symbol: 'DEMO-ETF', clientKey: 'e2e-restart-1', strategy: 'single', legs: [{ side: 'buy', qty: '1', type: 'limit', limitPrice: '1.00', tif: 'gtc' }] }).catch(() => {});
  await stopServer();
  await startServer();
  const orders = await api<{ clientKey: string; status: string }[]>(`/api/accounts/${acc.id}/orders`);
  expect(orders.find((o) => o.clientKey === 'e2e-restart-1')?.status).toBe('open');
  const page = await browser.newPage();
  await page.goto(`${BASE}/#/settings/health`);
  await expect(page.getByText(/Service was stopped/).first()).toBeVisible();
  await page.goto(`${BASE}/#/orders`);
  await page.getByRole('row', { name: /DEMO-ETF/ }).click();
  await expect(page.getByRole('dialog')).toContainText('monitoring gap');
  await page.close();
});

test('mobile layout has no horizontal overflow', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const h of ['/overview', '/instrument/DEMO-AAA', '/portfolio', '/orders', '/analytics', '/settings/accounts', '/markets']) {
    await page.goto(`${BASE}/#${h}`);
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${h}`).toBeLessThanOrEqual(1);
    if (h === '/overview' || h === '/instrument/DEMO-AAA') await page.screenshot({ path: `${SHOTS}/mobile${h.replace(/\//g, '-')}.png`, fullPage: true });
  }
  await page.getByRole('link', { name: 'Orders' }).tap();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
  await page.close();
});

test('desktop screenshots', async ({ page }) => {
  for (const h of ['/overview', '/instrument/DEMO-AAA']) {
    await page.goto(`${BASE}/#${h}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/desktop${h.replace(/\//g, '-')}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/#/overview`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/desktop-dark-overview.png`, fullPage: true });
});
