"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LayoutGrid, Settings2, Users } from "lucide-react";
import styles from "@/components/SettingsStyles.module.css";

const pages = [
  { href: "/settings", label: "Overview", icon: Settings2 },
  { href: "/settings/catalog", label: "Catalog", icon: LayoutGrid },
  { href: "/settings/accounts", label: "Accounts", icon: Users },
];

export default function SettingsFrame({ title, description, status, children }: {
  title: string;
  description: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.dot} aria-hidden="true" />
          <div className="min-w-0">
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
        </div>
        {status ? <div className={styles.status} role="status">{status}</div> : null}
      </header>
      <nav className={styles.nav} aria-label="Settings pages">
        {pages.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link key={href} href={href} className={active ? styles.activeTab : styles.tab}
              aria-current={active ? "page" : undefined}>
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
