"use client";

import { MessageSquarePlus } from "lucide-react";

/**
 * Feedback entry point for the marketing/content site.
 *
 * Submitting feedback needs the user's authenticated session, which lives in
 * the app origin (app.basefyio.com) — the marketing origin can't read it
 * (cross-site storage isolation, and the JWT is deliberately not a root cookie).
 * So this routes to the authenticated feedback composer when signed in, and to
 * login otherwise. The `basefyio_logged_in` marker is a readable root-domain
 * cookie, so we can tell which case applies client-side.
 */
function isLoggedIn(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split("; ").some((c) => c.startsWith("basefyio_logged_in=1"));
}

export function MarketingFeedback({ appUrl, variant = "link" }: { appUrl: string; variant?: "link" | "floating" }) {
  function go() {
    const base = appUrl.replace(/\/+$/, "");
    if (isLoggedIn()) {
      // Lands on the dashboard with the feedback composer auto-opened.
      window.location.href = `${base}/dashboard?feedback=compose`;
    } else {
      // Send unauthenticated visitors to login, returning to compose afterward.
      const next = encodeURIComponent("/dashboard?feedback=compose");
      window.location.href = `${base}/login?next=${next}`;
    }
  }

  if (variant === "floating") {
    return (
      <button
        type="button"
        onClick={go}
        className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
        aria-label="Send feedback"
      >
        <MessageSquarePlus className="h-4 w-4" />
        Feedback
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={go}
      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      Feedback
    </button>
  );
}
