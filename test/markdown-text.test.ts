import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownText } from "../web/src/MarkdownText.ts";

test("renders the safe CommonMark used by conversations and decisions", () => {
  const html = renderToStaticMarkup(createElement(MarkdownText, {
    markdown: [
      "## 异物定义",
      "",
      "本轮只包括 **新增物体** 和 `标签`。",
      "",
      "- 缺失",
      "- 移位",
      "",
      "[证据](https://example.com)",
    ].join("\n"),
  }));

  assert.match(html, /<h4>异物定义<\/h4>/);
  assert.match(html, /<strong>新增物体<\/strong>/);
  assert.match(html, /<code>标签<\/code>/);
  assert.match(html, /<ul>\s*<li>缺失<\/li>\s*<li>移位<\/li>\s*<\/ul>/);
  assert.match(html, /<span class="text-reference">证据<\/span>/);
  assert.doesNotMatch(html, /##|\*\*|<a\b/);
});

test("never turns model-authored HTML into elements", () => {
  const html = renderToStaticMarkup(createElement(MarkdownText, {
    markdown: "安全正文\n\n<script>alert(1)</script>",
  }));

  assert.doesNotMatch(html, /<script\b/);
});
