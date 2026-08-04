import { createElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

const renderHeading: NonNullable<Components["h1"]> = ({ children }) =>
  createElement("h4", null, children);

const components: Components = {
  h1: renderHeading,
  h2: renderHeading,
  h3: renderHeading,
  h4: renderHeading,
  h5: renderHeading,
  h6: renderHeading,
  a: ({ children }) => createElement("span", { className: "text-reference" }, children),
};

export function MarkdownText({
  markdown,
  streaming = false,
}: {
  markdown: string;
  streaming?: boolean;
}) {
  return createElement(
    "div",
    { className: streaming ? "markdown-text markdown-text--streaming" : "markdown-text" },
    createElement(ReactMarkdown, { components, skipHtml: true }, markdown),
  );
}
