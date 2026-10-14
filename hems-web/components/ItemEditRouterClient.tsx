"use client";

import InventoryRouteLoading from "@/components/InventoryRouteLoading";
import { useEffect, useState } from "react";
import type { SubcategoryType } from "@/lib/catalogStore";
import { getSubcategoryType } from "@/lib/subcategoryRegistry";

import ItemEditClientSerializedUnits from "@/components/ItemEditClientSerializedUnits";
import ItemEditClientChainHoistUnits from "@/components/ItemEditClientChainHoistUnits";
import ItemEditClientProjectorUnits from "@/components/ItemEditClientProjectorUnits";

export default function ItemEditRouterClient({
  category,
  subcategory,
  itemId,
}: {
  category: string;
  subcategory: string;
  itemId: string;
}) {
  const routeKey = `${category}:${subcategory}:${itemId}`;
  const [resolvedRoute, setResolvedRoute] = useState<{ key: string; type: SubcategoryType } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function resolveReportType() {
      try {
        const type = await getSubcategoryType(category, subcategory);
        if (!cancelled) {
          setError(null);
          setResolvedRoute({ key: routeKey, type });
        }
      } catch {
        if (!cancelled) setError({ key: routeKey, message: "The report could not be loaded. Please retry." });
      }
    }
    void resolveReportType();

    return () => {
      cancelled = true;
    };
  }, [category, subcategory, routeKey, attempt]);

  if (error?.key === routeKey) {
    return <div role="alert" className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
      {error.message}
      <button type="button" className="ml-3 underline" onClick={() => { setError(null); setAttempt(value => value + 1); }}>Retry</button>
    </div>;
  }
  if (resolvedRoute?.key !== routeKey) return <InventoryRouteLoading />;
  const type = resolvedRoute.type;

  if (type === "chain_hoist_units") {
    return (
      <ItemEditClientChainHoistUnits
        category={category}
        subcategory={subcategory}
        itemId={itemId}
      />
    );
  }

  if (type === "projector_units") {
    return (
      <ItemEditClientProjectorUnits
        category={category}
        subcategory={subcategory}
        itemId={itemId}
      />
    );
  }

    return (
  <ItemEditClientSerializedUnits
    category={category}
    subcategory={subcategory}
    itemId={itemId}
  />
);
}