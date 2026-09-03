// Small `data-testid`-based query/interaction helpers shared by every screen test.

import { assert } from './driver.js';

export function testId(id) {
  return `[data-testid="${id}"]`;
}

export async function waitForTestId(driver, id, { timeout = 20000 } = {}) {
  const el = await driver.$(testId(id));
  await el.waitForDisplayed({ timeout });
  return el;
}

// Clicked via executeScript rather than a plain WebDriver click: several elements in
// this app (flex-centered icon buttons, elements inside the app's forced sensorLandscape
// orientation) report "element not interactable" for a native click — first hit and
// documented for the profile picker in the original login.test.mjs, and again here for
// the hamburger nav button. A JS click sidesteps it uniformly rather than special-casing
// each element that turns out to need it.
export async function clickTestId(driver, id, { timeout = 15000 } = {}) {
  const el = await waitForTestId(driver, id, { timeout });
  const selector = testId(id);
  const clicked = await driver.execute((sel) => {
    const node = document.querySelector(sel);
    if (node) { node.click(); return true; }
    return false;
  }, selector);
  assert(clicked === true, `clicked ${selector}`);
  return el;
}

export async function allTestId(driver, id) {
  return driver.$$(testId(id));
}

// Sets a React-controlled text input's value directly, rather than WebDriver's
// setValue()/clearValue() — both were found to silently no-op against this app's search
// boxes in this WebView (the element's DOM value never changed, so React's own state
// never re-rendered the filtered list). This uses the standard workaround: call the
// native <input>/<textarea> value setter (bypassing React's value-tracking wrapper
// around the element) and then dispatch a real "input" event so React's change handler
// still fires.
export async function setInputValue(driver, id, value) {
  const selector = testId(id);
  const el = await waitForTestId(driver, id);
  const ok = await driver.execute((sel, val) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(node, val);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
  assert(ok === true, `set ${selector} value to ${JSON.stringify(value)}`);
  return el;
}

// Waits until querying `id` returns a stable (non-changing) count of elements, useful
// after typing into a debounced search box or switching a filter/tab. Polls rather than
// sleeping a fixed amount so a fast dev backend isn't penalized with a flat delay.
//
// The required-stable window (900ms) is deliberately longer than it looks like it needs
// to be: most of these screens unmount their whole list into a loading spinner while a
// request is in flight (so the count reads 0 immediately, correctly, but transiently)
// before the real count lands — a short window reads that transient 0 as "settled" and
// returns before the real network round trip (emulator -> host backend) finishes.
export async function waitForCountSettled(driver, id, { timeout = 12000, interval = 300, requiredStableMs = 900 } = {}) {
  let lastCount = -1;
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = (await allTestId(driver, id)).length;
    if (count === lastCount) {
      if (Date.now() - stableSince > requiredStableMs) return count;
    } else {
      lastCount = count;
      stableSince = Date.now();
    }
    await driver.pause(interval);
  }
  return lastCount;
}

export async function assertCount(driver, id, predicate, msg) {
  const count = (await allTestId(driver, id)).length;
  assert(predicate(count), `${msg} (count=${count})`);
  return count;
}
