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
  if (memoryCatalog) return memoryCatalog;
  if (catalogRequest) return catalogRequest;

  const fallback = readBrowserCatalogCache();

  catalogRequest = (async () => {
    try {

      const { data: cats, error: catErr } = await supabase
        .from("categories")
        .select("*")
        .order("name");

      if (catErr || !cats) {
        console.error("readCatalog categories error", catErr);
        return fallback ?? { categories: [] };
      }

      const { data: subs, error: subErr } = await supabase
        .from("subcategories")
        .select("*")
        .order("name");

      if (subErr || !subs) {
        console.error("readCatalog subcategories error", subErr);

        return fallback ?? {
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

      const result = { categories };
      memoryCatalog = result;

      if (typeof window !== "undefined") {
        try {
          sessionStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(categories));
        } catch {
          // Keep the in-memory cache when browser storage is unavailable.
        }
      }

      return result;
    } catch (err) {
      console.error("readCatalog fatal error", err);
      return fallback ?? { categories: [] };
    } finally {
      catalogRequest = null;
    }
  })();

  return catalogRequest;
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
