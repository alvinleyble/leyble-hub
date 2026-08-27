// Minimal DOM test harness: jsdom + react-dom/client, no framework. Components under
// test are the real V2 POS ones, loaded through the esbuild JSX hook (jsx-hooks.mjs).
import { JSDOM } from 'jsdom';
import React from 'react';

// `url` matters: jsdom refuses localStorage on an opaque origin, and api/client.js
// reads it to pick the active profile.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });

globalThis.window   = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node     = dom.window.Node;
globalThis.Event    = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent    = dom.window.MouseEvent;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { MemoryRouter } from 'react-router-dom';

const { createRoot } = await import('react-dom/client');
const { act } = React;

export function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(React.createElement(MemoryRouter, null, element)); });
  return {
    container,
    text: () => container.textContent,
    unmount: () => act(() => { root.unmount(); }),
    all: (selector) => [...container.querySelectorAll(selector)],
    byLabel: (label) => container.querySelector(`[aria-label="${label}"]`),
    // The card / dialog buttons all fire on click; useHoldRepeat's pointerdown path is
    // exercised by the app and tested with pointerDown/pointerUp.
    click: (el) => act(() => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }),
    press: (key) => act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    }),
    pointerDown: (el, opts = {}) => act(() => {
      el.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, ...opts }));
    }),
    pointerMove: (el, opts = {}) => act(() => {
      el.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, cancelable: true, ...opts }));
    }),
    pointerUp: (el, opts = {}) => act(() => {
      el.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, cancelable: true, ...opts }));
    }),
    pointerCancel: (el, opts = {}) => act(() => {
      el.dispatchEvent(new dom.window.PointerEvent('pointercancel', { bubbles: true, cancelable: true, ...opts }));
    }),
    pointerLeave: (el) => act(() => {
      el.dispatchEvent(new dom.window.PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    }),
  };
}

export { React, act };
