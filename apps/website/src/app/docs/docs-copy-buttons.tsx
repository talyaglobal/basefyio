"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Adds a "Copy" button to every code block of the docs article. The pages are plain server-rendered
 * <pre><code>, so the buttons are attached after render, once per route.
 */
export function DocsCopyButtons() {
  const pathname = usePathname();

  useEffect(() => {
    const blocks = document.querySelectorAll<HTMLPreElement>("article pre:not([data-copy])");
    blocks.forEach((pre) => {
      pre.dataset.copy = "1";
      pre.classList.add("relative");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");
      button.className =
        "absolute right-2 top-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground opacity-70 transition hover:opacity-100 focus-visible:opacity-100";
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Press Ctrl+C";
        }
        setTimeout(() => (button.textContent = "Copy"), 1500);
      });
      pre.appendChild(button);
    });
  }, [pathname]);

  return null;
}
