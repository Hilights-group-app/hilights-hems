"use client";

import type { ReactNode } from "react";
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

  if (isLoginPage) {
    return (
      <main className="min-h-[calc(100vh-48px)] w-full bg-white px-2 py-2">
        {children}
      </main>
    );
  }

  return (
    <div className="flex w-full items-start border-t border-gray-300 bg-white xl:h-[calc(100vh-48px)] xl:items-stretch xl:overflow-hidden">
      <aside className="hidden w-[280px] shrink-0 overflow-y-auto border-r border-gray-300 bg-white xl:block">
        <EquipmentListsSidebar />
      </aside>

      <main className="min-h-screen min-w-0 flex-1 px-2 py-2 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:bg-white xl:[&>*]:!bg-white">
        <MaintenanceRequestBanner />
        {children}
      </main>

      <aside className="hidden w-[280px] shrink-0 overflow-y-auto border-l border-gray-300 bg-white xl:block">
        <HomeRightSidebar />
      </aside>
    </div>
  );
}
