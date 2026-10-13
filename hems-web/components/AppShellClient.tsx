"use client";

import { type ReactNode } from "react";
import { useAppLayout } from "@/lib/useAppLayout";
import { usePathname } from "next/navigation";
import EquipmentListsSidebar from "@/components/EquipmentListsSidebar";
import HomeRightSidebar from "@/components/HomeRightSidebar";
import MaintenanceRequestBanner from "@/components/MaintenanceRequestBanner";

export default function AppShellClient({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const desktopLayout = useAppLayout() === "desktop";

  if (isLoginPage) {
    return (
      <main className="min-h-[calc(100vh-48px)] w-full bg-white px-2 py-2">
        {children}
      </main>
    );
  }

  return (
    <div className="flex w-full items-start border-t border-gray-300 bg-white hems-desktop:h-[calc(100vh-48px)] hems-desktop:items-stretch hems-desktop:overflow-hidden">
      <aside className="hidden w-[clamp(180px,20vw,280px)] shrink-0 overflow-y-auto border-r border-gray-300 bg-white hems-desktop:block">
        {desktopLayout ? <EquipmentListsSidebar /> : null}
      </aside>

      <main data-hems-main className="min-h-screen min-w-0 flex-1 px-2 py-2 hems-desktop:h-full hems-desktop:min-h-0 hems-desktop:overflow-y-auto hems-desktop:bg-white hems-desktop:[&>*]:!bg-white">
        <MaintenanceRequestBanner />
        {children}
      </main>

      <aside className="hidden w-[clamp(180px,20vw,280px)] shrink-0 overflow-y-auto border-l border-gray-300 bg-white hems-desktop:block">
        {desktopLayout ? <HomeRightSidebar /> : null}
      </aside>
    </div>
  );
}
