"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { titleFromSlug } from "@/lib/catalogHelpers";

import SubcategoryShellClient from "@/components/SubcategoryShellClient";
import SubcategoryClientSerialized from "@/components/SubcategoryClientSerialized";
import SubcategoryClientMatrix from "@/components/SubcategoryClientMatrix";
import SubcategoryClientLedScreen from "@/components/SubcategoryClientLedScreen";
import SubcategoryClientChainHoist from "@/components/SubcategoryClientChainHoist";
import SubcategoryClientProjectors from "@/components/SubcategoryClientProjectors";
import SubcategoryClientLenses from "@/components/SubcategoryClientLenses";
import SubcategoryClientLighting from "@/components/SubcategoryClientLighting";

import type { SubcategoryType } from "@/lib/catalogStore";

type RouteInfo = {
  type: SubcategoryType;
  categoryId: string | null;
  subcategoryId: string | null;
};

function isSafeType(value: any): value is SubcategoryType {
  return (
    value === "matrix" ||
    value === "fixture_units" ||
    value === "chain_hoist_units" ||
    value === "projector_units" ||
    value === "lens_units" ||
    value === "led_screen_units"
  );
}

export default function SubcategoryRouterClient({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const supabase = useMemo(() => createClient(), []);

  const cacheKey = `hems:route:${category}:${subcategory}`;

  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(() => {
    if (typeof window === "undefined") return null;

    try {
      const cached = sessionStorage.getItem(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const cached =
          typeof window !== "undefined"
            ? sessionStorage.getItem(cacheKey)
            : null;

        if (cached) {
          const parsed = JSON.parse(cached) as RouteInfo;
          if (!cancelled) setRouteInfo(parsed);
          return;
        }

        const { data: categoryRow, error: categoryError } = await supabase
          .from("categories")
          .select("id")
          .eq("slug", category)
          .single();

        if (categoryError || !categoryRow) {
          console.error("Failed to resolve category id", categoryError);

          const fallback: RouteInfo = {
            categoryId: null,
            subcategoryId: null,
            type: "fixture_units",
          };

          if (!cancelled) setRouteInfo(fallback);
          return;
        }

        const { data: subcategoryRow, error: subcategoryError } = await supabase
          .from("subcategories")
          .select("id, type")
          .eq("slug", subcategory)
          .eq("category_id", categoryRow.id)
          .single();

        if (subcategoryError || !subcategoryRow) {
          console.error("Failed to resolve subcategory", subcategoryError);

          const fallback: RouteInfo = {
            categoryId: categoryRow.id as string,
            subcategoryId: null,
            type: "fixture_units",
          };

          if (!cancelled) setRouteInfo(fallback);
          return;
        }

        const nextInfo: RouteInfo = {
          categoryId: categoryRow.id as string,
          subcategoryId: subcategoryRow.id as string,
          type: isSafeType(subcategoryRow.type)
            ? subcategoryRow.type
            : "fixture_units",
        };

        if (typeof window !== "undefined") {
          sessionStorage.setItem(cacheKey, JSON.stringify(nextInfo));
        }

        if (!cancelled) setRouteInfo(nextInfo);
      } catch (error) {
        console.error("SubcategoryRouterClient load error", error);

        const fallback: RouteInfo = {
          categoryId: null,
          subcategoryId: null,
          type: "fixture_units",
        };

        if (!cancelled) setRouteInfo(fallback);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [category, subcategory, cacheKey, supabase]);

  const title = useMemo(() => {
    return titleFromSlug(subcategory) || "Subcategory";
  }, [subcategory]);

  if (routeInfo === null) {
    return (
      <SubcategoryShellClient title={title}>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900">
          Loading...
        </div>
      </SubcategoryShellClient>
    );
  }

  const { type, categoryId, subcategoryId } = routeInfo;

  let body =
    category === "lighting" && subcategory === "lighting-fixtures" ? (
      <SubcategoryClientLighting category={category} subcategory={subcategory} />
    ) : (
      <SubcategoryClientSerialized category={category} subcategory={subcategory} />
    );

  if (type === "matrix") {
    body = (
      <SubcategoryClientMatrix
        category={category}
        subcategory={subcategory}
      />
    );
  } else if (type === "led_screen_units") {
    body = (
      <SubcategoryClientLedScreen
        categoryId={categoryId}
        subcategoryId={subcategoryId}
      />
    );
  } else if (type === "chain_hoist_units") {
    body = (
      <SubcategoryClientChainHoist
        category={category}
        subcategory={subcategory}
      />
    );
  } else if (type === "projector_units") {
    body = (
      <SubcategoryClientProjectors
        category={category}
        subcategory={subcategory}
        subcategoryId={subcategoryId}
      />
    );
  } else if (type === "lens_units") {
    body = (
      <SubcategoryClientLenses
        category={category}
        subcategory={subcategory}
      />
    );
  }

  return <SubcategoryShellClient title={title}>{body}</SubcategoryShellClient>;
}