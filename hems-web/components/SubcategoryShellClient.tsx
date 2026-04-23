"use client";

import Link from "next/link";
import { ReactNode } from "react";
import SubcategoryHeader from "@/components/SubcategoryHeader";

export default function SubcategoryShellClient({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <SubcategoryHeader
        title={title}
        right={
          <Link
            href="/inventory"
            className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
          >
            Back to Inventory
          </Link>
        }
      />

      {children}
    </div>
  );
}