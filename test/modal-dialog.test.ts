import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useCallback, useRef, useState } from "react";
import { JSDOM } from "jsdom";

import { useModalDialog } from "../web/src/use-modal-dialog.ts";

test("modal dialog traps focus, closes with Escape, and restores its opener", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>");
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    KeyboardEvent: globalThis.KeyboardEvent,
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    Node: { configurable: true, value: dom.window.Node },
    Element: { configurable: true, value: dom.window.Element },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const { createRoot } = await import("react-dom/client");

  function TestDialog({ onClose }: { onClose(): void }) {
    const closeButton = useRef<HTMLButtonElement>(null);
    const dialog = useModalDialog<HTMLElement>({ onClose, initialFocus: closeButton });
    return createElement(
      "div",
      { className: "backdrop" },
      createElement(
        "section",
        { ref: dialog, role: "dialog", tabIndex: -1 },
        createElement("button", { ref: closeButton, type: "button", onClick: onClose }, "关闭"),
        createElement("button", { type: "button" }, "次要操作"),
      ),
    );
  }

  function Harness() {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    return createElement(
      "div",
      null,
      createElement("button", { id: "opener", type: "button", onClick: () => setOpen(true) }, "打开"),
      createElement("div", { id: "page-content" }, "页面内容"),
      open ? createElement(TestDialog, { onClose: close }) : null,
    );
  }

  const rootElement = dom.window.document.querySelector("#root")!;
  const root = createRoot(rootElement);
  await act(async () => root.render(createElement(Harness)));

  const opener = rootElement.querySelector<HTMLButtonElement>("#opener")!;
  opener.focus();
  await act(async () => opener.click());

  const dialog = rootElement.querySelector<HTMLElement>("[role=dialog]")!;
  const buttons = dialog.querySelectorAll<HTMLButtonElement>("button");
  const pageContent = rootElement.querySelector<HTMLElement>("#page-content")!;
  assert.equal(dom.window.document.activeElement, buttons[0]);
  assert.equal(opener.hasAttribute("inert"), true);
  assert.equal(pageContent.getAttribute("aria-hidden"), "true");

  buttons[1].focus();
  await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  })));
  assert.equal(dom.window.document.activeElement, buttons[0]);

  buttons[0].focus();
  await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })));
  assert.equal(dom.window.document.activeElement, buttons[1]);

  await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  })));
  assert.equal(rootElement.querySelector("[role=dialog]"), null);
  assert.equal(dom.window.document.activeElement, opener);
  assert.equal(opener.hasAttribute("inert"), false);
  assert.equal(pageContent.hasAttribute("aria-hidden"), false);

  await act(async () => root.unmount());
  dom.window.close();
  Object.defineProperties(globalThis, {
    ...Object.fromEntries(Object.entries(previousGlobals).map(([key, value]) => [
      key,
      { configurable: true, value },
    ])),
  });
});
