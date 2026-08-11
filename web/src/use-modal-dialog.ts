import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalDialogOptions {
  onClose(): void;
  initialFocus?: { readonly current: HTMLElement | null };
}

interface HiddenSibling {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

export function useModalDialog<T extends HTMLElement>({
  onClose,
  initialFocus,
}: ModalDialogOptions): RefObject<T | null> {
  const dialog = useRef<T>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }

    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const backdrop = element.parentElement;
    const host = backdrop?.parentElement;
    const hiddenSiblings: HiddenSibling[] = [];

    if (host && backdrop) {
      for (const sibling of host.children) {
        if (sibling === backdrop || !(sibling instanceof HTMLElement)) {
          continue;
        }
        hiddenSiblings.push({
          element: sibling,
          inert: sibling.inert || sibling.hasAttribute("inert"),
          ariaHidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.inert = true;
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
    }

    const focusable = () => Array.from(
      element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((candidate) => {
      const style = window.getComputedStyle(candidate);
      return !candidate.hidden && style.display !== "none" && style.visibility !== "hidden";
    });

    (initialFocus?.current ?? focusable()[0] ?? element).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        element.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !element.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !element.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      for (const sibling of hiddenSiblings) {
        sibling.element.inert = sibling.inert;
        if (sibling.inert) {
          sibling.element.setAttribute("inert", "");
        } else {
          sibling.element.removeAttribute("inert");
        }
        if (sibling.ariaHidden === null) {
          sibling.element.removeAttribute("aria-hidden");
        } else {
          sibling.element.setAttribute("aria-hidden", sibling.ariaHidden);
        }
      }
      if (returnFocus?.isConnected) {
        returnFocus.focus();
      }
    };
  }, [initialFocus, onClose]);

  return dialog;
}
