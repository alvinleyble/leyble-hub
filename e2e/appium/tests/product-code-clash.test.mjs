// Two real devices, one throwaway LOCAL backend. Never defaults to a personal
// emulator or a remote database. See README's product-code clash run recipe.
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createDriver, switchToWebview, assert } from '../helpers/driver.js';
import { loginAs, navigateTo } from '../helpers/auth.js';
import { clickTestId } from '../helpers/ui.js';

const serials = [process.env.DEVICE_A_UDID, process.env.DEVICE_B_UDID];
const apiBase = process.env.TEST_API_URL;
const output = process.env.TEST_OUTPUT_DIR;
if (serials[0] !== 'emulator-5556' || serials[1] !== 'emulator-5558') throw new Error('Set DEVICE_A_UDID=emulator-5556 DEVICE_B_UDID=emulator-5558 (dedicated test devices only).');
if (!apiBase || !['localhost', '127.0.0.1'].includes(new URL(apiBase).hostname)) throw new Error('TEST_API_URL must point at the throwaway localhost backend.');
if (!output) throw new Error('TEST_OUTPUT_DIR is required.');
const adb = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb';
const stamp = Date.now();
let token;

function connection(index, enabled) {
  execFileSync(adb, ['-s', serials[index], 'shell', 'svc', 'wifi', enabled ? 'enable' : 'disable']);
  // Wi-Fi-only AVDs (including tablets) do not expose the telephony service.
  const phoneService = execFileSync(adb, ['-s', serials[index], 'shell', 'service', 'check', 'phone'], { encoding: 'utf8' });
  if (phoneService.includes(': found')) execFileSync(adb, ['-s', serials[index], 'shell', 'svc', 'data', enabled ? 'enable' : 'disable']);
}
async function products() {
  const res = await fetch(`${apiBase}/api/v1/products?include_inactive=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Product read failed: ${res.status}`);
  return res.json();
}
async function clickText(driver, text) {
  const clicked = await driver.execute((label) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label && b.getBoundingClientRect().height > 0);
    if (!button) return false;
    button.click(); return true;
  }, text);
  assert(clicked, `clicked ${text}`);
}
async function fillLabel(driver, label, value) {
  await driver.execute((label, value) => {
    const node = [...document.querySelectorAll('label')].find(l => l.textContent.replace('*', '').trim() === label);
    const input = node && document.getElementById(node.htmlFor);
    if (!input) throw new Error(`Missing input: ${label}`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, label, value);
}
async function deviceRecords(driver) {
  return driver.executeAsync((done) => {
    const preferences = window.Capacitor.Plugins.Preferences;
    preferences.keys().then(async ({ keys }) => {
      const values = await Promise.all(keys.filter(k => /^v25\.outbox\.\d+$/.test(k)).map(async key => JSON.parse((await preferences.get({ key })).value)));
      done(values);
    }).catch(err => done({ error: err.message }));
  });
}
async function waitQueueEmpty(driver) {
  await driver.waitUntil(async () => {
    const records = await deviceRecords(driver);
    if (!Array.isArray(records)) throw new Error(JSON.stringify(records));
    return records.length === 0;
  }, { timeout: 60000, interval: 2000, timeoutMsg: 'device outbox did not empty' });
  assert(true, 'device queue drained with no Needs attention item');
}
async function addOffline(driver, index, name, sku, price = '200') {
  await navigateTo(driver, 'inventory');
  connection(index, false);
  await clickText(driver, '+ Add Product');
  await fillLabel(driver, 'Product Name', name);
  await fillLabel(driver, 'SKU', sku);
  await fillLabel(driver, 'Wholesale Price (₱ / case)', price);
  await clickText(driver, 'Save Product');
  await driver.waitUntil(async () => !await (await driver.$('#create-product-title')).isExisting(), { timeout: 20000, interval: 1000 });
  const queued = await deviceRecords(driver);
  assert(queued.some(r => r.entity_type === 'product' && r.payload.sku === sku && r.status === 'queued'), `${serials[index]} saved ${sku} offline`);
}
async function waitClash(driver, sku, mine, theirs, filename) {
  await driver.waitUntil(async () => (await deviceRecords(driver)).some(r => r.status === 'needs_attention' && r.product_clash?.sku === sku), { timeout: 60000, interval: 2000 });
  await driver.waitUntil(async () => (await driver.$('[data-testid="status-light"]')).getAttribute('data-tone').then(tone => tone === 'red'), { timeout: 15000, interval: 1000 });
  await clickTestId(driver, 'status-light');
  await driver.waitUntil(async () => (await driver.$('body').getText()).includes('Use existing product'), { timeout: 15000, interval: 1000 });
  const text = await driver.$('body').getText();
  assert(text.includes(sku) && text.includes(mine) && text.includes(theirs), 'clash shows code and both product names');
  assert(text.includes('Use existing product') && text.includes('Change code'), 'clash offers both required actions');
  await driver.saveScreenshot(`${output}/screenshots/${filename}`);
}
async function closeAttention(driver) {
  await driver.execute(() => document.querySelector('[aria-labelledby="attention-list-title"] button[aria-label="Close"]').click());
}

async function run() {
  await mkdir(`${output}/screenshots`, { recursive: true });
  const login = await fetch(`${apiBase}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alvin@leyblestore.com', password: 'leyble123' }) });
  token = (await login.json()).token;
  if (!token) throw new Error(`Fixture observer login failed: ${login.status}`);
  const drivers = [];
  let keepAlive;
  try {
    // Sequential setup avoids the known concurrent instrumentation crash on loaded hosts.
    for (const [index, email] of ['josie@leyblestore.com', 'luis@leyblestore.com'].entries()) {
      connection(index, true);
      const driver = await createDriver({ udid: serials[index] });
      drivers.push(driver);
      await switchToWebview(driver);
      await loginAs(driver, { email });
      if (index === 0) keepAlive = setInterval(() => driver.getTimeouts().catch(() => {}), 30000);
    }
    clearInterval(keepAlive);
    const [phone, tablet] = drivers;
    const sameSku = `same-${stamp}`;
    await addOffline(phone, 0, 'Clash Same Drink', sameSku);
    await addOffline(tablet, 1, 'clash  SAME drink', sameSku, '999');
    connection(0, true);
    await waitQueueEmpty(phone);
    connection(1, true);
    await waitQueueEmpty(tablet);
    let matches = (await products()).filter(p => p.sku === sameSku);
    assert(matches.length === 1 && Number(matches[0].base_wholesale_price) === 200, 'same-name creates yield one product; existing price stands');

    const differentSku = `different-${stamp}`;
    await addOffline(phone, 0, 'Server Cola', differentSku);
    await addOffline(tablet, 1, 'Tablet Lemonade', differentSku);
    connection(0, true);
    await waitQueueEmpty(phone);
    connection(1, true);
    await waitClash(tablet, differentSku, 'Tablet Lemonade', 'Server Cola', 'tablet-product-code-clash.png');
    await clickText(tablet, 'Use existing product');
    await waitQueueEmpty(tablet);
    matches = (await products()).filter(p => p.sku === differentSku);
    assert(matches.length === 1 && matches[0].name === 'Server Cola', 'explicit adoption keeps existing product');
    await closeAttention(tablet);

    const reverseSku = `reverse-${stamp}`;
    await addOffline(tablet, 1, 'Server Orange', reverseSku);
    await addOffline(phone, 0, 'Phone Grape', reverseSku);
    connection(1, true);
    await waitQueueEmpty(tablet);
    connection(0, true);
    await waitClash(phone, reverseSku, 'Phone Grape', 'Server Orange', 'phone-product-code-clash.png');
    await clickText(phone, 'Change code');
    await fillLabel(phone, 'New product code', `${reverseSku}-new`);
    await clickText(phone, 'Save new code');
    await waitQueueEmpty(phone);
    const all = await products();
    assert(all.some(p => p.sku === `${reverseSku}-new` && p.name === 'Phone Grape'), 'changed code creates this device’s product without losing its name');
    assert(all.some(p => p.sku === reverseSku && p.name === 'Server Orange'), 'original server product remains untouched');
    console.log('\nALL ASSERTIONS PASSED');
  } finally {
    clearInterval(keepAlive);
    for (let index = 0; index < 2; index++) {
      try { connection(index, true); }
      catch (err) { console.error(`Could not restore connectivity on ${serials[index]}:`, err.message); process.exitCode = 1; }
    }
    for (const driver of drivers) await driver.deleteSession().catch(() => {});
  }
}
run().catch(err => { console.error('TEST FAILED:', err); process.exitCode = 1; });
