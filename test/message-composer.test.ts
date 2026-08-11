import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";

import { MessageComposer } from "../web/src/MessageComposer.ts";

test("Enter sends, Shift+Enter keeps a newline, and IME Enter does not submit", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    Node: { configurable: true, value: dom.window.Node },
    Element: { configurable: true, value: dom.window.Element },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    CompositionEvent: { configurable: true, value: dom.window.CompositionEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const { createRoot } = await import("react-dom/client");

  const submissions: string[] = [];
  function Harness() {
    const [value, setValue] = useState("阶段回答");
    return createElement(MessageComposer, {
      id: "answer",
      label: "你的回答",
      value,
      onChange: setValue,
      onSubmit: () => submissions.push(value),
      placeholder: "输入回答",
      context: "继续同一个地图 Agent 会话",
      disabled: false,
      busy: false,
    });
  }

  const rootElement = dom.window.document.querySelector("#root")!;
  const root = createRoot(rootElement);
  await act(async () => root.render(createElement(Harness)));
  const textarea = rootElement.querySelector("textarea")!;
  const sendButton = rootElement.querySelector<HTMLButtonElement>("button[type=submit]")!;
  assert.equal(sendButton.getAttribute("aria-label"), "发送回答");
  assert.ok(sendButton.querySelector("svg"), "the send action has a recognizable icon");
  assert.match(rootElement.textContent ?? "", /Enter 发送 · Shift\+Enter 换行/);

  const enter = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => textarea.dispatchEvent(enter));
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(submissions, ["阶段回答"]);

  submissions.length = 0;
  const shiftedEnter = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => textarea.dispatchEvent(shiftedEnter));
  assert.equal(shiftedEnter.defaultPrevented, false);
  assert.deepEqual(submissions, []);

  await act(async () => textarea.dispatchEvent(new dom.window.CompositionEvent(
    "compositionstart",
    { bubbles: true, data: "地" },
  )));
  const composingEnter = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => textarea.dispatchEvent(composingEnter));
  assert.equal(composingEnter.defaultPrevented, false);
  assert.deepEqual(submissions, []);

  await act(async () => root.unmount());
  dom.window.close();
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: previousWindow },
    document: { configurable: true, value: previousDocument },
    navigator: { configurable: true, value: previousNavigator },
  });
});
