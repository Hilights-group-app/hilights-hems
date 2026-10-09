import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

/** =========================
 * ENV
 * ======================= */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing in .env.local");
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing in .env.local");

console.log("URL =", url);
console.log("SERVICE KEY = OK");

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

/** =========================
 * Helpers
 * ======================= */
function safeParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function mustSingle(res, label) {
  if (res.error) {
    throw new Error(`${label}: ${res.error.message}`);
  }
  if (!res.data) {
    throw new Error(`${label}: No data returned`);
  }
  return res.data;
}

/** =========================
 * Load export file (project root)
 * ======================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const exportPath = path.join(projectRoot, "hems-localstorage-export.json");

if (!fs.existsSync(exportPath)) {
  throw new Error(
    `Cannot find hems-localstorage-export.json at: ${exportPath}\nPut it in hems-web/ folder (project root).`
  );
}

const raw = fs.readFileSync(exportPath, "utf-8");
const data = JSON.parse(raw);

/** =========================
 * Migration
 * ======================= */
async function migrate() {
  console.log("🚀 Starting migration...");

  // 1) Catalog
  const catalog = safeParse(data["hems:v1:catalog"]);
  if (!catalog) {
    console.log("❌ No catalog found in hems:v1:catalog");
    return;
  }

  const subcategoryMap = {}; // "catSlug:subSlug" -> subcategory_id
  const categoryMap = {}; // "catSlug" -> category_id

  for (const cat of catalog.categories || []) {
    const dbCat = mustSingle(
      await supabase
        .from("categories")
        .insert({ name: cat.name, slug: cat.slug })
        .select()
        .single(),
      `Insert category ${cat.slug}`
    );

    categoryMap[cat.slug] = dbCat.id;

    for (const sub of cat.subcategories || []) {
      const dbSub = mustSingle(
        await supabase
          .from("subcategories")
          .insert({
            category_id: dbCat.id,
            name: sub.name,
            slug: sub.slug,
            type: sub.type,
          })
          .select()
          .single(),
        `Insert subcategory ${cat.slug}/${sub.slug}`
      );

      subcategoryMap[`${cat.slug}:${sub.slug}`] = dbSub.id;
    }
  }

  console.log("✅ Catalog migrated");

  // 2) Serialized Items + Units (hems:v1:items:cat:sub + hems:v1:units:cat:sub:itemId)
  for (const key of Object.keys(data)) {
    if (!key.startsWith("hems:v1:items:")) continue;

    const parts = key.split(":");
    const categorySlug = parts[3];
    const subSlug = parts[4];

    const subId = subcategoryMap[`${categorySlug}:${subSlug}`];
    if (!subId) {
      console.log(`⚠️ Skipping items for ${categorySlug}/${subSlug} (not in catalog map)`);
      continue;
    }

    const items = safeParse(data[key]) || [];

    for (const it of items) {
      const dbItem = mustSingle(
        await supabase
          .from("items")
          .insert({
            subcategory_id: subId,
            name: it.name,
            photo_url: it.photo || null,
          })
          .select()
          .single(),
        `Insert item ${it?.name ?? it?.id ?? "unknown"}`
      );

      const unitsKey = `hems:v1:units:${categorySlug}:${subSlug}:${it.id}`;
      const units = safeParse(data[unitsKey]) || [];

      for (const u of units) {
        const ins = await supabase.from("units").insert({
          item_id: dbItem.id,
          unit_no: String(u?.id ?? ""),
          serial: u?.serial || null,
          status: u?.status || "available",
          lamp_hours: u?.lamp_hours ?? null,
          notes: u?.notes ?? null,
          cert_date: u?.certificateDate || null,
          expiry_date: u?.expiryDate || null,
        });

        if (ins.error) {
          throw new Error(
            `Insert unit failed for item ${it?.name ?? it?.id ?? "unknown"}: ${ins.error.message}`
          );
        }
      }
    }
  }

  console.log("✅ Items + Units migrated");

  // 3) Matrix (hems:v1:matrix:cat:sub)
  for (const key of Object.keys(data)) {
    if (!key.startsWith("hems:v1:matrix:")) continue;

    const parts = key.split(":");
    const categorySlug = parts[3];
    const subSlug = parts[4];

    const subId = subcategoryMap[`${categorySlug}:${subSlug}`];
    if (!subId) {
      console.log(`⚠️ Skipping matrix for ${categorySlug}/${subSlug} (not in catalog map)`);
      continue;
    }

    const catId = categoryMap[categorySlug];
    if (!catId) {
      console.log(`⚠️ Skipping matrix model (no category in map): ${categorySlug}/${subSlug}`);
      continue;
    }

    const models = safeParse(data[key]) || [];

    for (const m of models) {
      const dbModel = mustSingle(
        await supabase
          .from("matrix_models")
          .insert({
            category_id: catId, // ✅ FIX: not null
            subcategory_id: subId,
            name: m.name || "Untitled",
            photo_data: m.photo || null,
          })
          .select()
          .single(),
        `Insert matrix model ${m?.name ?? m?.id ?? "unknown"}`
      );

      for (const row of m.rows || []) {
        const ins = await supabase.from("matrix_rows").insert({
          model_id: dbModel.id,
          size: row.size || "",
          qty: Number(row.qty) || 0,
        });

        if (ins.error) {
          throw new Error(
            `Insert matrix row failed for model ${m?.name ?? m?.id ?? "unknown"}: ${ins.error.message}`
          );
        }
      }
    }
  }

  console.log("🎉 Migration DONE");
}

migrate().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});