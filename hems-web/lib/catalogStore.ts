import { supabase } from "./supabaseClient";

/* -------------------------
TYPES
--------------------------*/
export type SubcategoryType =
  | "matrix"
  | "fixture_units"
  | "lighting"
  | "chain_hoist_units"
  | "projector_units"
  | "lens_units"
  | "led_screen_units";
  
export type Category = {
  id: string;
  name: string;
  slug: string;
};

export type Subcategory = {
  id: string;
  name: string;
  slug: string;
  category_id: string;
  type: SubcategoryType | null;
};

export type CatalogCategory = Category & { subcategories: Subcategory[] };

export type Catalog = {
  categories: CatalogCategory[];
};

export const CATALOG_CACHE_KEY = "hems:catalog:v4";
export const CATALOG_CHANGED_EVENT = "hems:catalog-change";

let memoryCatalog: Catalog | null = null;
let catalogRequest: Promise<Catalog> | null = null;
let catalogRefreshStartedAt = 0;
let catalogGeneration = 0;

function readBrowserCatalogCache(): Catalog | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const categories = JSON.parse(raw) as CatalogCategory[];
    return Array.isArray(categories) ? { categories } : null;
  } catch {
    return null;
  }
}

function notifyCatalogChanged() {
  memoryCatalog = null;
  catalogRequest = null;
  catalogRefreshStartedAt = 0;
  catalogGeneration += 1;

  if (typeof window === "undefined") return;

  try {
    sessionStorage.removeItem(CATALOG_CACHE_KEY);
  } catch {
    // The live database refresh still works if storage is unavailable.
  }

  window.dispatchEvent(new Event(CATALOG_CHANGED_EVENT));
}

/* -------------------------
READ CATALOG (DB)
--------------------------*/
export async function readCatalog(): Promise<Catalog> {
  const fallback = memoryCatalog ?? readBrowserCatalogCache();
  if (fallback) memoryCatalog = fallback;
  if (catalogRequest) return fallback ?? catalogRequest;
  if (memoryCatalog && Date.now() - catalogRefreshStartedAt < 60000) return memoryCatalog;

  const generation = catalogGeneration;
  catalogRefreshStartedAt = Date.now();
  const request = (async () => {
    try {
      const [categoryResult, subcategoryResult] = await Promise.all([
        supabase.from("categories").select("*").order("name"),
        supabase.from("subcategories").select("*").order("name"),
      ]);
      if (categoryResult.error || subcategoryResult.error || !categoryResult.data || !subcategoryResult.data) {
        return fallback ?? { categories: [] };
      }
      const subByCat = new Map<string, Subcategory[]>();
      for (const sub of subcategoryResult.data as Subcategory[]) {
        const rows = subByCat.get(sub.category_id) ?? [];
        rows.push(sub); subByCat.set(sub.category_id, rows);
      }
      const result: Catalog = { categories: (categoryResult.data as Category[]).map(category => ({
        ...category, subcategories: subByCat.get(category.id) ?? [],
      })) };
      if (generation !== catalogGeneration) return memoryCatalog ?? fallback ?? result;
      memoryCatalog = result;
      if (typeof window !== "undefined") {
        try { sessionStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(result.categories)); } catch {}
        if (fallback && JSON.stringify(fallback) !== JSON.stringify(result)) {
          window.dispatchEvent(new Event(CATALOG_CHANGED_EVENT));
        }
      }
      return result;
    } catch (error) {
      console.error("readCatalog error", error);
      return fallback ?? { categories: [] };
    }
  })();
  catalogRequest = request;
  void request.finally(() => { if (catalogRequest === request) catalogRequest = null; });
  // Cached navigation is usable now; freshness checks continue quietly.
  return fallback ?? request;
}

/* -------------------------
CATEGORY CRUD
--------------------------*/
export async function addCategory(name: string, slug: string) {

  const { data, error } = await supabase
    .from("categories")
    .insert({ name, slug })
    .select()
    .single();

  if (error) throw error;
  notifyCatalogChanged();
  return data as Category;
}

export async function renameCategory(id: string, name: string, slug: string) {

  const { data, error } = await supabase
    .from("categories")
    .update({ name, slug })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  notifyCatalogChanged();
  return data as Category;
}

export async function deleteCategory(id: string) {

  const { error } = await supabase.from("categories").delete().eq("id", id);

  if (error) throw error;
  notifyCatalogChanged();
  return true;
}

/* -------------------------
SUBCATEGORY CRUD
--------------------------*/
export async function addSubcategory(
  category_id: string,
  name: string,
  slug: string,
  type: SubcategoryType | null = "fixture_units"
) {

  const { data, error } = await supabase
    .from("subcategories")
    .insert({ category_id, name, slug, type })
    .select()
    .single();

  if (error) throw error;
  notifyCatalogChanged();
  return data as Subcategory;
}

export async function renameSubcategory(
  id: string,
  name: string,
  slug: string
) {

  const { data, error } = await supabase
    .from("subcategories")
    .update({ name, slug })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  notifyCatalogChanged();
  return data as Subcategory;
}

export async function deleteSubcategory(id: string) {

  const { error } = await supabase.from("subcategories").delete().eq("id", id);

  if (error) throw error;
  notifyCatalogChanged();
  return true;
}

export async function setSubcategoryType(
  id: string,
  type: SubcategoryType | null
) {

  const { data, error } = await supabase
    .from("subcategories")
    .update({ type })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  notifyCatalogChanged();
  return data as Subcategory;
}
