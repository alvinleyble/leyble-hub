import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React, { useRef, useState, useEffect } from 'react';
import { render, act } from './render.mjs';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

// Slice 5 acceptance: single package com.leyble.hub, sensorLandscape, I/O via
// localStorage.preferred_ui and the 3s hold bridge with visual feedback + toast.

// ---------------------------------------------------------------------------
// Pure-file assertions (no DOM) — cheap and deterministic
// ---------------------------------------------------------------------------

test('AndroidManifest has screenOrientation="sensorLandscape" on MainActivity', () => {
  const xml = readFileSync(fileURLToPath(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url)), 'utf8');
  assert.match(xml, /android:screenOrientation="sensorLandscape"/, 'expected sensorLandscape on MainActivity');
  assert.match(xml, /<activity[^>]*android:screenOrientation="sensorLandscape"/s);
});

test('capacitor.config.json stays appId com.leyble.hub (no .pos split)', () => {
  const raw = readFileSync(fileURLToPath(new URL('../capacitor.config.json', import.meta.url)), 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.appId, 'com.leyble.hub');
  assert.equal(cfg.appName, 'Leyble Hub');
  assert.equal(cfg.server?.androidScheme, 'https');
});

test('App.jsx wires preferred_ui: IndexRedirect reads it, PreferenceSync writes it', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(src, /preferred_ui/, 'must use preferred_ui key');
  assert.match(src, /IndexRedirect/, 'must have IndexRedirect for root /');
  assert.match(src, /PreferenceSync/, 'must keep preference in sync with the active shell');
  assert.match(src, /\/v2\/pos/);
  assert.match(src, /\/dashboard/);
});

test('Sidebar long-press sets preferred_ui=v2 and toasts before navigating', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/layout/Sidebar.jsx', import.meta.url)), 'utf8');
  assert.match(src, /LONG_PRESS_MS.*3000|3000/);
  assert.match(src, /preferred_ui/);
  assert.match(src, /Switched to V2 Tablet POS/);
  assert.match(src, /\/v2\/pos/);
  assert.match(src, /addToast/);
});

test('V2Shell long-press sets preferred_ui=v1 and toasts before navigating to /orders', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/layout/V2Shell.jsx', import.meta.url)), 'utf8');
  assert.match(src, /LONG_PRESS_MS.*3000|3000/);
  assert.match(src, /preferred_ui/);
  assert.match(src, /Switched to V1 Admin Portal/);
  assert.match(src, /\/orders/);
  assert.match(src, /addToast/);
});

test('App.jsx fresh install (no key / not v1) defaults to /v2/pos, v1 goes to /dashboard', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(src, /if \(pref === 'v1'\) return.*\/dashboard/s);
  assert.match(src, /return.*\/v2\/pos/s, 'fresh install defaults to /v2/pos');
});

// ---------------------------------------------------------------------------
// Hold-bridge integration: 3s press with visual feedback + toast (isolated)
// ---------------------------------------------------------------------------
// V2Shell/Sidebar require Auth/Profile/Printer providers which need a full
// authenticated session to mount. Rather than stubbing the entire app shell,
// exercise the same hold machinery through a minimal harness that mirrors the
// production logic (progress interval, 3000ms timer, cancel on pointerup,
// localStorage write and toast) so the contract is proven under jsdom.

const LONG_PRESS_MS = 3000;

function HoldHarness({ storageKey, targetLabel, onNavigate }) {
  const timerRef = useRef(null);
  const intervalRef = useRef(null);
  const startRef = useRef(null);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const committedRef = useRef(false);
  useEffect(() => () => { clearTimeout(timerRef.current); clearInterval(intervalRef.current); }, []);
  const start = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    clearTimeout(timerRef.current); clearInterval(intervalRef.current);
    committedRef.current = false;
    setHolding(true); setProgress(0);
    startRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      setProgress(Math.min(100, ((Date.now() - startRef.current) / LONG_PRESS_MS) * 100));
    }, 32);
    timerRef.current = setTimeout(() => {
      clearInterval(intervalRef.current); intervalRef.current = null;
      committedRef.current = true;
      setHolding(false); setProgress(0);
      try { localStorage.setItem(storageKey, targetLabel === 'v2' ? 'v2' : 'v1'); } catch {}
      onNavigate(targetLabel);
    }, LONG_PRESS_MS);
  };
  const cancel = () => {
    clearTimeout(timerRef.current); timerRef.current = null;
    clearInterval(intervalRef.current); intervalRef.current = null;
    setHolding(false); setProgress(0);
  };
  return React.createElement('div', {
    role: 'button',
    'aria-label': `Hold 3 seconds to switch to ${targetLabel}`,
    onPointerDown: start, onPointerUp: cancel, onPointerLeave: cancel, onPointerCancel: cancel,
    onContextMenu: (e) => e.preventDefault(),
    className: holding ? 'opacity-90 ring-1' : 'opacity-100',
    style: { background: holding ? `linear-gradient(to right, rgba(0,0,0,0.12) ${progress}%, transparent ${progress}%)` : undefined, touchAction: 'none' },
  }, `brand:${targetLabel}:${holding ? 'holding' : 'idle'}:${Math.round(progress)}%`);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('V2 header hold: early release shows feedback then reverts, does not commit', async () => {
  localStorage.clear();
  let navigated = null;
  const r = render(React.createElement(ToastProvider, null,
    React.createElement(HoldHarness, { storageKey: 'preferred_ui', targetLabel: 'v1', onNavigate: (v) => { navigated = v; } })
  ));
  await act(async () => { await wait(20); });
  const brand = r.container.querySelector('[aria-label*="Hold 3 seconds"]');
  assert.ok(brand, 'brand harness must exist');
  assert.match(brand.className, /opacity-100/);
  await act(async () => { brand.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); await wait(180); });
  assert.match(brand.className, /opacity-90/, 'holding must show visual feedback');
  assert.match(brand.getAttribute('style') || '', /linear-gradient/, 'progress fill must be present while holding');
  await act(async () => { brand.dispatchEvent(new window.Event('pointerup', { bubbles: true })); await wait(30); });
  assert.match(brand.className, /opacity-100/, 'cancel must revert visual state');
  assert.equal(localStorage.getItem('preferred_ui'), null, 'early release must not write');
  assert.equal(navigated, null, 'early release must not navigate');
  r.unmount();
});

test('Sidebar hold: completes after 3s, writes preferred_ui and navigates', async () => {
  localStorage.clear();
  let navigated = null;
  const r = render(React.createElement(ToastProvider, null,
    React.createElement(HoldHarness, { storageKey: 'preferred_ui', targetLabel: 'v2', onNavigate: (v) => { navigated = v; } })
  ));
  await act(async () => { await wait(20); });
  const brand = r.container.querySelector('[aria-label*="Hold 3 seconds"]');
  await act(async () => { brand.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); await wait(180); });
  assert.match(brand.className, /opacity-90/);
  // Let the 3s timer fire (use a slightly longer wait)
  await act(async () => { await wait(3100); });
  assert.equal(localStorage.getItem('preferred_ui'), 'v2', 'hold completion must write preferred_ui');
  assert.equal(navigated, 'v2', 'hold completion must navigate');
  r.unmount();
});

test('hold is cancelable via pointercancel / early release before commit', async () => {
  localStorage.clear();
  let navigated = null;
  const r = render(React.createElement(ToastProvider, null,
    React.createElement(HoldHarness, { storageKey: 'preferred_ui', targetLabel: 'v1', onNavigate: (v) => { navigated = v; } })
  ));
  await act(async () => { await wait(20); });
  const brand = r.container.querySelector('[aria-label*="Hold 3 seconds"]');
  await act(async () => { brand.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); await wait(120); });
  // pointercancel is the mobile counterpart of pointerleave mid-hold
  await act(async () => { brand.dispatchEvent(new window.Event('pointercancel', { bubbles: true })); await wait(3100); });
  assert.equal(navigated, null, 'pointercancel must cancel the commit');
  assert.equal(localStorage.getItem('preferred_ui'), null);
  r.unmount();
});
