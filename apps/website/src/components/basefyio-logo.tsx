import Link from "next/link";
import { Database } from "lucide-react";
import { isBeta, RELEASE_LABEL } from "@/lib/release-stage";

type BasefyioLogoProps = {
  href?: string;
  className?: string;
};

/**
 * Matches admin-ui header: gradient tile + Database icon + gradient wordmark,
 * with the "beta" pill next to it while the product is in beta (one switch
 * removes it everywhere: NEXT_PUBLIC_RELEASE_STAGE=ga at build time).
 */
export function BasefyioLogo({
  href = "/",
  className = "",
}: BasefyioLogoProps) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 ${className}`}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-md">
        <Database className="h-4 w-4" aria-hidden />
      </div>
      <span className="text-lg font-bold gradient-text">basefyio</span>
      {isBeta() && (
        <span
          aria-label="beta release"
          className="inline-flex shrink-0 items-center rounded-full bg-blue-500/10 px-1.5 py-px text-[10px] font-semibold leading-4 tracking-wide text-blue-700 ring-1 ring-blue-500/30 whitespace-nowrap dark:text-blue-300"
        >
          {RELEASE_LABEL}
        </span>
      )}
    </Link>
  );
}
