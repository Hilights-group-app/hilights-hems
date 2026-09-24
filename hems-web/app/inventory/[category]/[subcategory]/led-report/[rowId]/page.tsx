// app/inventory/[category]/[subcategory]/led-report/[rowId]/page.tsx
import { use } from "react";
import LedScreenReportClient from "@/components/LedScreenReportClient";

type ParamsObj = {
  category: string;
  subcategory: string;
  rowId: string;
};

export default function Page({
  params,
}: {
  params: ParamsObj | Promise<ParamsObj>;
}) {
  const p = (params as any)?.then
    ? use(params as Promise<ParamsObj>)
    : (params as ParamsObj);

  return (
    <LedScreenReportClient
      category={p.category}
      subcategory={p.subcategory}
      rowId={p.rowId}
    />
  );
}
