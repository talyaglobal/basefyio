"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Adds a "Copy" button to every code block matched by `selector`.
 *
 * The docs pages are plain server-rendered JSX with raw <pre><code> blocks, so
 * instead of rewriting every page around a component this enhances the blocks
 * after hydration. The button is appended inside the <pre> (never moving the
 * <pre> itself), so React still owns and can remove every node it rendered.
 * It runs again on each client-side navigation.
 */
export function CodeCopyButtons({ selector }: { selector: string }) {
  const pathname = usePathname();

  useEffect(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLPreElement>(selector));
    const added: HTMLButtonElement[] = [];
    const timers: number[] = [];

    for (const pre of blocks) {
      if (pre.dataset.copyReady) continue;
      pre.dataset.copyReady = "1";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-button";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");
      button.addEventListener("click", async () => {
        const text = (pre.querySelector("code") ?? pre).textContent ?? "";
        let label = "Copied";
        try {
          await navigator.clipboard.writeText(text.replace(/\n$/, ""));
        } catch {
          // No clipboard access (an insecure origin, a denied permission):
          // select the code so the reader can copy it by hand.
          const range = document.createRange();
          range.selectNodeContents(pre.querySelector("code") ?? pre);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          label = "Selected";
        }
        button.textContent = label;
        timers.push(window.setTimeout(() => (button.textContent = "Copy"), 1500));
      });

      pre.appendChild(button);
      added.push(button);
    }

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      for (const button of added) {
        const pre = button.parentElement as HTMLPreElement | null;
        if (pre) delete pre.dataset.copyReady;
        button.remove();
      }
    };
  }, [selector, pathname]);

  return null;
}
