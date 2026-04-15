import Link from "next/link";
import { Database } from "lucide-react";

type KolaybaseLogoProps = {
  href?: string;
  className?: string;
};

/** Matches admin-ui header: gradient tile + Database icon + gradient wordmark. */
export function KolaybaseLogo({
  href = "/",
  className = "",
}: KolaybaseLogoProps) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 ${className}`}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-md">
        <Database className="h-4 w-4" aria-hidden />
      </div>
      <span className="text-lg font-bold gradient-text">Kolaybase</span>
    </Link>
  );
}
