"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export default function NavigationFeedbackLink({
  href,
  children,
  loadingLabel = "Opening...",
  className = "",
  onStart,
}: {
  href: string;
  children: ReactNode;
  loadingLabel?: ReactNode;
  className?: string;
  onStart?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [opening, setOpening] = useState(false);

  useEffect(() => setOpening(false), [pathname]);
  useEffect(() => {
    if (!opening) return;
    const timer = window.setTimeout(() => setOpening(false), 10000);
    return () => window.clearTimeout(timer);
  }, [opening]);

  return (
    <Link
      href={href}
      aria-busy={opening}
      onClick={(event) => {
        event.preventDefault();
        if (opening) return;
        setOpening(true);
        onStart?.();
        const startingPath = window.location.pathname;
        router.push(href);
        // Safari occasionally drops a client navigation while its connection is
        // recovering. Keep the button reliable without forcing normal clicks to
        // reload the whole application.
        window.setTimeout(() => {
          if (window.location.pathname === startingPath) window.location.assign(href);
        }, 1400);
      }}
      className={`${className} ${opening ? "pointer-events-none opacity-80" : ""}`}
    >
      {opening ? <Loader2 size={14} className="shrink-0 animate-spin" /> : null}
      <span>{opening ? loadingLabel : children}</span>
    </Link>
  );
}
