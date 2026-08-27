import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';

const useHoldRepeat = (await import('../src/components/ui/useHoldRepeat.js')).default;

function TestButton({ onAction, options = {} }) {
  const handlers = useHoldRepeat(onAction, options);
  return React.createElement('button', {
    type: 'button',
    'aria-label': 'Test Button',
    ...handlers,
  }, 'Click me');
}

test('useHoldRepeat: quick tap (< threshold) calls action once on pointerup', () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, { onAction: () => { calls++; } }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  assert.equal(calls, 0, 'action must not fire on pointerdown');

  r.pointerUp(btn, { clientX: 52, clientY: 53 }); // 3.6px movement < 10px
  assert.equal(calls, 1, 'action must fire once on pointerup');

  // Trailing click event within 50ms should be suppressed
  r.click(btn);
  assert.equal(calls, 1, 'trailing click must be ignored');
  r.unmount();
});

test('useHoldRepeat: pointermove exceeding threshold cancels tap action (scroll drag)', () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, { onAction: () => { calls++; } }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  r.pointerMove(btn, { clientX: 50, clientY: 75 }); // 25px movement > 10px
  r.pointerUp(btn, { clientX: 50, clientY: 75 });

  assert.equal(calls, 0, 'drag must cancel action entirely');
  r.unmount();
});

test('useHoldRepeat: pointerup exceeding threshold without pointermove cancels action', () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, { onAction: () => { calls++; } }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  // Browser jumps directly to pointerup at distant coordinate
  r.pointerUp(btn, { clientX: 50, clientY: 80 });

  assert.equal(calls, 0, 'release past threshold must not trigger action');
  r.unmount();
});

test('useHoldRepeat: pointercancel cancels pending action', () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, { onAction: () => { calls++; } }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  r.pointerCancel(btn);
  r.pointerUp(btn, { clientX: 50, clientY: 50 });

  assert.equal(calls, 0, 'pointercancel must cancel action');
  r.unmount();
});

test('useHoldRepeat: press-and-hold ramps action repeatedly', async () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, {
    onAction: () => { calls++; },
    options: { delay: 60, interval: 30 },
  }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  assert.equal(calls, 0);

  // Wait 140ms: 60ms delay + 2 intervals (30ms each) -> 3 calls
  await new Promise((res) => setTimeout(res, 140));
  assert.ok(calls >= 2, `expected at least 2 repeat calls, got ${calls}`);

  const snapshot = calls;
  r.pointerUp(btn, { clientX: 50, clientY: 50 });
  assert.equal(calls, snapshot, 'pointerup after hold must not fire extra call');

  await new Promise((res) => setTimeout(res, 80));
  assert.equal(calls, snapshot, 'repeat timer must be stopped after pointerup');
  r.unmount();
});

test('useHoldRepeat: dragging past threshold during hold cancels repeating', async () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, {
    onAction: () => { calls++; },
    options: { delay: 40, interval: 25 },
  }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  // Wait for initial hold tick
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(calls >= 1, `expected initial tick, got ${calls}`);

  // Now drag past threshold
  r.pointerMove(btn, { clientX: 50, clientY: 90 });
  const countAtDrag = calls;

  // Wait further: no new calls should happen
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(calls, countAtDrag, 'repeat must stop once movement exceeds threshold');

  r.pointerUp(btn, { clientX: 50, clientY: 90 });
  assert.equal(calls, countAtDrag);
  r.unmount();
});

test('useHoldRepeat: pointerleave during hold stops repeat', async () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, {
    onAction: () => { calls++; },
    options: { delay: 40, interval: 25 },
  }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(calls >= 1);

  // Pointer leaves button
  r.pointerLeave(btn);
  const countAtLeave = calls;

  await new Promise((res) => setTimeout(res, 80));
  assert.equal(calls, countAtLeave, 'repeat must stop when pointer leaves button');
  r.unmount();
});

test('useHoldRepeat: unmount mid-hold cleans up timers and stops repeat', async () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, {
    onAction: () => { calls++; },
    options: { delay: 40, interval: 25 },
  }));
  const btn = r.byLabel('Test Button');

  r.pointerDown(btn, { clientX: 50, clientY: 50 });
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(calls >= 1);

  r.unmount();
  const countAtUnmount = calls;

  await new Promise((res) => setTimeout(res, 80));
  assert.equal(calls, countAtUnmount, 'repeat must stop when component unmounts');
});

test('useHoldRepeat: keyboard Enter and Space fire action once', () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, { onAction: () => { calls++; } }));
  const btn = r.byLabel('Test Button');

  let defaultPrevented = false;
  act(() => {
    const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    defaultPrevented = ev.defaultPrevented;
  });

  assert.equal(calls, 1, 'Enter should fire action');
  assert.equal(defaultPrevented, true, 'Enter should call preventDefault()');

  act(() => {
    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  });
  assert.equal(calls, 2, 'Space should fire action');
  r.unmount();
});

test('useHoldRepeat: click fallback fires action when no pointer events occurred', () => {
  let calls = 0;
  const r = render(React.createElement(TestButton, { onAction: () => { calls++; } }));
  const btn = r.byLabel('Test Button');

  // Direct click without pointerdown (e.g. screen reader / programmatic / test)
  r.click(btn);
  assert.equal(calls, 1, 'click fallback should fire action');
  r.unmount();
});
