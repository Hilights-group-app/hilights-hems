import { createClient } from "@/lib/supabase/server";
import type { Category, Subcategory, Catalog, CatalogCategory } from "@/lib/catalogStore";

export async function readCatalogServer(): Promise<Catalog> {
  try {
    const supabase = await createClient();

    const { data: cats, error: catErr } = await supabase
      .from("categories")
      .select("*")
      .order("name");

    if (catErr || !cats) {
      console.error("readCatalogServer categories error", catErr);
      return { categories: [] };
    }

    const { data: subs, error: subErr } = await supabase
      .from("subcategories")
      .select("*")
      .order("name");

    if (subErr || !subs) {
      console.error("readCatalogServer subcategories error", subErr);
      return {
        categories: (cats as Category[]).map((c) => ({
          ...c,
          subcategories: [],
        })),
      };
    }

    const subByCat = new Map<string, Subcategory[]>();

    for (const s of subs as Subcategory[]) {
      const arr = subByCat.get(s.category_id) ?? [];
      arr.push(s);
      subByCat.set(s.category_id, arr);
    }

    const categories: CatalogCategory[] = (cats as Category[]).map((c) => ({
      ...c,
      subcategories: subByCat.get(c.id) ?? [],
    }));

    return { categories };
  } catch (err) {
    console.error("readCatalogServer fatal error", err);
    return { categories: [] };
  }
}