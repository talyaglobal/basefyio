"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const AUTH_MARKER_KEY = "kb_logged_in";

function getCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(
    new RegExp("(?:^|;\\s*)" + name + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function AuthNav({ appUrl }: { appUrl: string }) {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(getCookie(AUTH_MARKER_KEY) === "1");
  }, []);

  if (loggedIn) {
    return (
      <Link
        href={`${appUrl}/dashboard`}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Dashboard
      </Link>
    );
  }

  return (
    <Link
      href={appUrl}
      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      Sign In
    </Link>
  );
}
