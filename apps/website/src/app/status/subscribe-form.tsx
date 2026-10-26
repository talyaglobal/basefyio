"use client";

import { useState } from "react";
import { Bell, Loader2, X } from "lucide-react";

/**
 * "Subscribe to updates": the address gets a confirmation mail first, so
 * nobody can sign somebody else up. Posts straight to the platform API,
 * which answers every origin without credentials.
 */
export function SubscribeUpdates({ apiUrl }: { apiUrl: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}/api/platform-status/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => ({}))) as { state?: string; message?: string };
      if (!res.ok) {
        setMessage({ tone: "error", text: body.message || "Could not subscribe right now. Try again in a minute." });
      } else if (body.state === "already") {
        setMessage({ tone: "ok", text: "This address already receives updates." });
      } else {
        setMessage({ tone: "ok", text: "Check your inbox: confirm the address and you are in." });
        setEmail("");
      }
    } catch {
      setMessage({ tone: "error", text: "Could not reach the API. Try again in a minute." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
        aria-expanded={open}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        Subscribe to updates
      </button>
      {open && (
        <form
          onSubmit={submit}
          className="absolute right-0 z-20 mt-2 w-80 rounded-xl border bg-card p-4 shadow-lg"
          aria-label="Subscribe to status updates"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Incident mail</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                One mail when an incident opens, changes or resolves. Unsubscribe from any of them.
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <label className="mt-3 block text-xs font-medium" htmlFor="status-subscribe-email">
            E-mail address
          </label>
          <input
            id="status-subscribe-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-primary focus:ring-2"
          />
          <button
            type="submit"
            disabled={busy || !email}
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Send confirmation
          </button>
          {message && (
            <p className={`mt-2 text-xs ${message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="status">
              {message.text}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
