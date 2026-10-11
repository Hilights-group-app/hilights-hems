"use client";

import Link from "next/link";
import { ArrowRight, LayoutGrid, Users } from "lucide-react";
import SettingsFrame from "@/components/SettingsFrame";
import styles from "@/components/SettingsStyles.module.css";

const sections = [
  { href: "/settings/catalog", title: "Categories & Subcategories", description: "Organize inventory categories, subcategories and equipment types.", action: "Manage catalog", icon: LayoutGrid },
  { href: "/settings/accounts", title: "Account Management", description: "Create accounts and manage user roles, departments and profile photos.", action: "Manage accounts", icon: Users },
];

export default function SettingsClient() {
  return (
    <SettingsFrame title="Settings" description="Manage your inventory workspace." status="Admin">
      <div className={styles.cards}>
        {sections.map(({ href, title, description, action, icon: Icon }) => (
          <Link key={href} href={href} className={styles.card}>
            <span className={styles.icon}><Icon size={19} strokeWidth={1.8} aria-hidden="true" /></span>
            <h2>{title}</h2>
            <p>{description}</p>
            <span className={styles.cardAction}>{action}<ArrowRight size={13} aria-hidden="true" /></span>
          </Link>
        ))}
      </div>
    </SettingsFrame>
  );
}
