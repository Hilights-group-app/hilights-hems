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

import type { SubcategoryType } from "@/lib/catalogStore";

export default function SubcategoryRouterClient({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const supabase = createClient();

  const [type, setType] = useState<SubcategoryType>("fixture_units");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { data: categoryRow, error: categoryError } = await supabase
          .from("categories")
          .select("id")
          .eq("slug", category)
          .single();

        if (categoryError || !categoryRow) {
          console.error("Failed to resolve category id", categoryError);
          if (!cancelled) {
            setCategoryId(null);
            setSubcategoryId(null);
            setType("fixture_units");
          }
          return;
        }

        if (!cancelled) {
          setCategoryId(categoryRow.id as string);
        }

        const { data: subcategoryRow, error: subcategoryError } = await supabase
          .from("subcategories")
          .select("id, type")
          .eq("slug", subcategory)
          .eq("category_id", categoryRow.id)
          .single();

        if (subcategoryError || !subcategoryRow) {
          console.error("Failed to resolve subcategory", subcategoryError);
          if (!cancelled) {
            setSubcategoryId(null);
            setType("fixture_units");
          }
          return;
        }

        const dbType = subcategoryRow.type;

        const safeType: SubcategoryType =
          dbType === "matrix" ||
          dbType === "fixture_units" ||
          dbType === "chain_hoist_units" ||
          dbType === "projector_units" ||
          dbType === "lens_units" ||
          dbType === "led_screen_units"
            ? dbType
            : "fixture_units";

        if (!cancelled) {
          setSubcategoryId(subcategoryRow.id as string);
          setType(safeType);
        }
      } catch (error) {
        console.error("SubcategoryRouterClient load error", error);
        if (!cancelled) {
          setCategoryId(null);
          setSubcategoryId(null);
          setType("fixture_units");
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [category, subcategory, supabase]);

  const title = useMemo(() => {
    return titleFromSlug(subcategory) || "Subcategory";
  }, [subcategory]);

  let body = (
    <SubcategoryClientSerialized category={category} subcategory={subcategory} />
  );

  if (type === "matrix") {
    body = (
      <SubcategoryClientMatrix
        categoryId={categoryId}
        subcategoryId={subcategoryId}
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