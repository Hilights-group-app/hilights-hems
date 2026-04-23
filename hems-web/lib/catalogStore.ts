import { supabase } from "./supabaseClient";

/* -------------------------
TYPES
--------------------------*/
export type SubcategoryType =
  | "matrix"
  | "fixture_units"
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

/* -------------------------
READ CATALOG (DB)
--------------------------*/
export async function readCatalog(): Promise<Catalog> {
  const { data: cats, error: catErr } = await supabase
    .from("categories")
    .select("*")
    .order("name");

  if (catErr || !cats) {
    console.error("readCatalog categories error", catErr);
    return { categories: [] };
  }

  const { data: subs, error: subErr } = await supabase
    .from("subcategories")
    .select("*")
    .order("name");

  if (subErr || !subs) {
    console.error("readCatalog subcategories error", subErr);
    return { categories: cats.map((c) => ({ ...c, subcategories: [] })) };
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
  return data as Category;
}

export async function deleteCategory(id: string) {
  // مهم: إذا عندك FK cascade في DB يكفي هذا
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw error;
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
  return data as Subcategory;
}

export async function deleteSubcategory(id: string) {
  const { error } = await supabase.from("subcategories").delete().eq("id", id);
  if (error) throw error;
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
  return data as Subcategory;
}