"use client";

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
  const [type, setType] = useState<SubcategoryType>("fixture_units");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const t = await getSubcategoryType(category, subcategory);
      if (!cancelled) setType(t ?? "fixture_units");
    })();

    return () => {
      cancelled = true;
    };
  }, [category, subcategory]);

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