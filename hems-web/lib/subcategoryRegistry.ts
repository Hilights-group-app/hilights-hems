import type { SubcategoryType } from "@/lib/catalogStore";
import { readCatalog } from "@/lib/catalogStore";

export async function getSubcategoryType(
  categorySlug: string,
  subSlug: string
): Promise<SubcategoryType> {
  if (typeof window === "undefined") {
    return "fixture_units";
  }

  const catalog = await readCatalog();
  const cats = catalog?.categories ?? [];

  const cat = cats.find((c) => c.slug === categorySlug);
  const sub = (cat?.subcategories ?? []).find((s) => s.slug === subSlug);

  const t = sub?.type;

  if (
    t === "matrix" ||
    t === "fixture_units" ||
    t === "chain_hoist_units" ||
    t === "projector_units" ||
    t === "lens_units" ||
    t === "led_screen_units"
  ) {
    return t;
  }

  return "fixture_units";
}