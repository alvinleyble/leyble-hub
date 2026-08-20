// Minimal DOM test harness: jsdom + react-dom/client, no framework. Components under
// test are the real V2 POS ones, loaded through the esbuild JSX hook (jsx-hooks.mjs).
import { JSDOM } from 'jsdom';
import React from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

globalThis.window   = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node     = dom.window.Node;
globalThis.Event    = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent    = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { act } = React;

export function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  return {
    container,
    text: () => container.textContent,
    unmount: () => act(() => { root.unmount(); }),
    all: (selector) => [...container.querySelectorAll(selector)],
    byLabel: (label) => container.querySelector(`[aria-label="${label}"]`),
    // The card / dialog buttons all fire on click; useHoldRepeat's pointerdown path is
    // exercised by the app, not here.
    click: (el) => act(() => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }),
    press: (key) => act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    }),
  };
}

export { React, act };
