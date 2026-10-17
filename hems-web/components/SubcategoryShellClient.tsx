"use client";

import { ReactNode } from "react";
import SubcategoryHeader from "@/components/SubcategoryHeader";
import NavigationFeedbackLink from "@/components/NavigationFeedbackLink";
import { ArrowLeft } from "lucide-react";

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
        <NavigationFeedbackLink
          href="/inventory"
          loadingLabel={<span className="hidden hems-wide:inline">Opening...</span>}
          className="inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-2 text-[10px] font-semibold text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 active:scale-[0.98] hems-wide:px-3"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          <span className="hidden hems-wide:inline">Back to Inventory</span>
        </NavigationFeedbackLink>
        }
      />

      {children}
    </div>
  );
}
