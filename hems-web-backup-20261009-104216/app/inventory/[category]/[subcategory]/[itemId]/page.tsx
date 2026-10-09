// app/inventory/[category]/[subcategory]/[itemId]/page.tsx
import { use } from "react";
import ItemEditRouterClient from "@/components/ItemEditRouterClient";

type ParamsObj = { category: string; subcategory: string; itemId: string };

export default function Page({
  params,
}: {
  params: ParamsObj | Promise<ParamsObj>;
}) {
  const p = (params as any)?.then ? use(params as Promise<ParamsObj>) : (params as ParamsObj);

  return (
    <ItemEditRouterClient
      category={p.category}
      subcategory={p.subcategory}
      itemId={p.itemId}
    />
  );
}   