import {
  createElement,
  useRef,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface MessageComposerProps {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  placeholder: string;
  context: string;
  disabled: boolean;
  busy: boolean;
  secondaryAction?: ReactNode;
  maxLength?: number;
}

export function MessageComposer({
  id,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  context,
  disabled,
  busy,
  secondaryAction,
  maxLength = 8_000,
}: MessageComposerProps) {
  const composing = useRef(false);
  const canSend = Boolean(value.trim()) && !disabled && !busy;
  const submit = () => {
    if (canSend) {
      onSubmit();
    }
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return createElement(
    "form",
    { className: "expedition-composer", onSubmit: handleSubmit },
    createElement("label", { htmlFor: id }, label),
    createElement("textarea", {
      id,
      value,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
      onKeyDown: handleKeyDown,
      onCompositionStart: () => { composing.current = true; },
      onCompositionEnd: () => { composing.current = false; },
      placeholder,
      rows: 3,
      maxLength,
      disabled,
    }),
    createElement(
      "div",
      null,
      createElement(
        "small",
        null,
        context,
        createElement("span", { className: "composer-shortcut" }, "Enter 发送 · Shift+Enter 换行"),
      ),
      createElement(
        "span",
        { className: "expedition-composer__actions" },
        secondaryAction,
        createElement(
          "button",
          {
            type: "submit",
            className: "message-composer__send",
            disabled: !canSend,
            "aria-label": "发送回答",
            title: "发送回答（Enter）",
          },
          createElement(
            "svg",
            {
              viewBox: "0 0 24 24",
              width: 15,
              height: 15,
              "aria-hidden": "true",
              focusable: "false",
            },
            createElement("path", {
              d: "M3.4 4.2 21 12 3.4 19.8l2.1-6.2L14 12 5.5 10.4 3.4 4.2Z",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "1.6",
              strokeLinejoin: "round",
            }),
          ),
          createElement("span", null, busy ? "正在发送…" : "发送回答"),
        ),
      ),
    ),
  );
}
