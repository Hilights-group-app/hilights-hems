import type { SupabaseClient } from "@supabase/supabase-js";

export type StockRecord = Record<string, unknown>;
export type StockCounts = { total: number; available: number; reserved: number; out: number; ksa: number; repair: number; expired: number };
export type StockPhoto = { recordType: "item" | "matrix_model" | "matrix_row"; recordId: string; imageUrl: string };
export type StockRow = { key: string; block: string; name: string; description: string; detail: string;
  counts: StockCounts | null; unit: "pcs" | "SQM" | "cab"; child?: boolean; photo?: StockPhoto };
export type InventoryStockDocument = { title: string; category: string; date: string; generatedAt: string;
  fileName: string; rows: StockRow[]; notes: string[]; chainHoist: boolean };
const str = (value: unknown) => typeof value === "string" ? value.trim() : "";
const num = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const zero = (): StockCounts => ({ total: 0, available: 0, reserved: 0, out: 0, ksa: 0, repair: 0, expired: 0 });
const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const fixtures = ["Moving Head profile", "Moving Head Spot", "Moving Head Beam", "Moving Head Wash", "Lamp Profile & Fresnel", "LED Washer & Pars", "LED Pixel line", "Followspot"];
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function stockDates(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid stock date.");
  return {
    date: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" }).format(now),
    timestamp: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(now) + " Dubai",
    day: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now),
  };
}
export function stockFileName(title: string, date: string) {
  return `${title} Stock - ${date}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim() + ".pdf";
}
export function stockCabinetArea(value: unknown) {
  const size = str(value).toLowerCase().replace(/,/g, ".").replace(/[×*]/g, "x");
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!match) return 0;
  const metres = (v: number, u: string) => u === "mm" ? v / 1000 : u === "cm" ? v / 100 : u === "m" ? v : v > 100 ? v / 1000 : v > 2 ? v / 100 : v;
  return metres(Number(match[1]), match[2] || match[4] || "") * metres(Number(match[3]), match[4] || match[2] || "");
}
type StockInput = { title: string; category: string; type: string; items: StockRecord[]; units: StockRecord[];
  models: StockRecord[]; matrixRows: StockRecord[]; reservations: StockRecord[]; order?: StockRecord | null; now?: Date };

/** Pure display snapshot; no item/status/quantity writes. */
export function buildInventoryStock(input: StockInput): InventoryStockDocument {
  const dates = stockDates(input.now), chain = input.type === "chain_hoist_units";
  const records = new Map<string, number>(), parents = new Map<string, number>();
  for (const row of input.reservations) {
    const key = `${row.record_type}:${row.record_id}`, parent = `${row.record_type}:${row.parent_id}`;
    records.set(key, (records.get(key) ?? 0) + num(row.quantity));
    if (row.parent_id) parents.set(parent, (parents.get(parent) ?? 0) + num(row.available_quantity ?? row.quantity));
  }
  const reserved = (type: string, id: string) => records.get(`${type}:${id}`) ?? 0;
  const counts = (row: StockRecord, total: unknown, reservation: number): StockCounts => {
    const c = { ...zero(), total: num(total), reserved: reservation, out: num(row.in_use_qty), ksa: num(row.in_ksa_qty), repair: num(row.maintenance_qty) };
    c.available = Math.max(0, c.total - c.out - c.ksa - c.repair - c.reserved); return c;
  };
  const photo = (type: StockPhoto["recordType"], row: StockRecord, field: string): StockPhoto | undefined => str(row[field])
    ? { recordType: type, recordId: str(row.id), imageUrl: str(row[field]) } : undefined;
  const rows: StockRow[] = [], notes = ["Available excludes Pending reservations. Quantities are a read-only stock snapshot at export time."];
  if (input.type === "matrix" || input.type === "led_screen_units") {
    const isLed = input.type === "led_screen_units";
    const models = [...input.models];
    const blockOrder = Array.isArray(input.order?.block_order) ? input.order.block_order.filter((v): v is string => typeof v === "string") : [];
    const itemOrder = input.order?.item_order_by_block && typeof input.order.item_order_by_block === "object"
      ? input.order.item_order_by_block as Record<string, unknown> : {};
    const block = (m: StockRecord) => isLed ? str(m.name).split(" - ")[0] || "LED Screens" : str(m.block_name) || str(m.name).split(" - ")[0] || "Other";
    const rank = (values: string[], value: string) => values.includes(value) ? values.indexOf(value) : values.length;
    models.sort((a, b) => {
      if (isLed) return (Number(a.sort_order ?? 1e9) - Number(b.sort_order ?? 1e9)) || compare(str(a.name), str(b.name));
      const ba = block(a), bb = block(b), saved = Array.isArray(itemOrder[ba]) ? itemOrder[ba] as string[] : [];
      return rank(blockOrder, ba) - rank(blockOrder, bb) || compare(ba, bb) || rank(saved, str(a.id)) - rank(saved, str(b.id)) || compare(str(a.name), str(b.name));
    });
    for (const m of models) {
      const id = str(m.id), name = str(m.name), type = str(m.item_type);
      const details = input.matrixRows.filter(row => str(row[isLed ? "model_id" : "item_id"]) === id).sort((a,b) => isLed
        ? Number(a.sort_order ?? 1e9) - Number(b.sort_order ?? 1e9) || compare(str(a.size), str(b.size))
        : compare(str(a.cable_length), str(b.cable_length)));
      const grouped = isLed || type === "cable" && details.length > 0;
      rows.push({ key: `model:${id}`, block: block(m), name, description: str(m.description), detail: isLed ? "LED cabinet stock · SQM" : "",
        counts: grouped ? null : counts(m, m.total_qty, reserved("matrix_model", id)), unit: "pcs", photo: isLed ? undefined : photo("matrix_model", m, "photo_data") });
      if (isLed || type === "cable" || type === "rack") for (const row of details) {
        const rid = str(row.id), area = isLed ? stockCabinetArea(row.size) : 1;
        const raw = type === "rack" && !isLed ? null : counts(row, isLed ? row.qty : row.total_qty, reserved("matrix_row", rid));
        const converted = raw && isLed && area > 0 ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value * area])) as StockCounts : raw;
        rows.push({ key: `row:${rid}`, block: block(m), name: isLed ? [str(row.cabinet_model), str(row.size)].filter(Boolean).join(" · ") || "Cabinet" : str(row.cable_length) || "Item",
          description: "", detail: type === "rack" && !isLed ? `${num(row.total_qty)} per rack` : isLed && !(area > 0) ? "Size unknown: counts shown as cabinets, not SQM" : "",
          counts: converted, unit: isLed ? area > 0 ? "SQM" : "cab" : "pcs", child: true, photo: isLed ? photo("matrix_row", row, "photo_data") : undefined });
      }
    }
    if (isLed) notes.push("LED quantities are SQM. Unknown cabinet dimensions are explicitly shown as cabinet counts (cab).");
  } else {
    const stat = new Map<string, StockCounts>(), unknown = new Map<string, number>();
    for (const item of input.items) stat.set(str(item.id), zero());
    for (const u of input.units) {
      const id = str(u.item_id), c = stat.get(id); if (!c) continue;
      const status = str(u.status) || "available", expiry = str(u.expiry_date).slice(0, 10);
      const expired = chain && !["maintenance", "failed"].includes(status) && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && Number.isFinite(Date.parse(expiry)) && expiry < dates.day;
      c.total++; if (expired) c.expired++;
      if (status === "available") { if (!expired) c.available++; }
      else if (status === "in_use") c.out++;
      else if (status === "in_ksa") c.ksa++;
      else if (["maintenance", "failed"].includes(status)) c.repair++;
      else unknown.set(id, (unknown.get(id) ?? 0) + 1);
    }
    for (const item of input.items) {
      const id = str(item.id), c = stat.get(id) ?? zero();
      c.reserved = parents.get(`unit:${id}`) ?? 0; c.available = Math.max(0, c.available - c.reserved);
      const parts = str(item.name).split(" - ").map(s=>s.trim()), legacy = chain && !str(item.fixture_type) && parts.length >= 4;
      rows.push({ key: `item:${id}`, block: str(item.fixture_type) || (legacy ? parts.at(-1) : "") || "Unassigned", name: legacy ? parts.slice(0,-1).join(" - ") : str(item.name),
        description: str(item.description), detail: unknown.get(id) ? `${unknown.get(id)} units have an unrecognized status.` : "", counts: c, unit: "pcs", photo: photo("item", item, "photo_url") });
    }
    rows.sort((a,b) => {
      const lighting = input.type === "lighting";
      return (lighting ? (fixtures.includes(a.block) ? fixtures.indexOf(a.block) : fixtures.length) - (fixtures.includes(b.block) ? fixtures.indexOf(b.block) : fixtures.length) : 0)
        || (a.block === "Unassigned" ? 1 : 0) - (b.block === "Unassigned" ? 1 : 0) || compare(a.block,b.block) || compare(a.name,b.name);
    });
    if (chain && rows.some(row=>num(row.counts?.expired)>0)) notes.push("Expired is a certificate flag and can overlap Out/KSA. Failed hoists are not counted as expired.");
  }
  return { title: input.title, category: input.category, date: dates.date, generatedAt: dates.timestamp,
    fileName: stockFileName(input.title, dates.date), rows, notes, chainHoist: chain };
}

/** Fresh, paginated reads only when Download PDF is pressed. No subscriptions. */
export async function readInventoryStock(client: SupabaseClient, subcategoryId: string, signal: AbortSignal, now = new Date(), expectedPath = "") {
  if (!uuid(subcategoryId)) throw new Error("Open a subcategory before exporting stock.");
  const meta = await client.from("subcategories").select("id,name,type,category_id,slug").eq("id", subcategoryId).abortSignal(signal).maybeSingle();
  if (meta.error || !meta.data) throw new Error("This subcategory is unavailable or could not be loaded.");
  const sub = meta.data as StockRecord;
  const cat = await client.from("categories").select("name,slug").eq("id", str(sub.category_id)).abortSignal(signal).maybeSingle();
  if (cat.error || !cat.data) throw new Error("The inventory category could not be loaded.");
  const category = cat.data as StockRecord;
  if (expectedPath && expectedPath !== `/inventory/${str(category.slug)}/${str(sub.slug)}`) throw new Error("The page is still changing. Wait for this subcategory to open, then export again.");
  async function all(table: string, columns: string, field: string, ids: string[], size = 500): Promise<StockRecord[]> {
    const result: StockRecord[] = [];
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100); let after = "";
      while (true) {
        let query = client.from(table).select(columns).in(field, batch).order("id").limit(size).abortSignal(signal);
        if (after) query = query.gt("id", after);
        const page = await query;
        if (page.error) throw new Error(`Could not read all ${table} rows. No partial stock PDF was created.`);
        const rows = (page.data ?? []) as unknown as StockRecord[];
        result.push(...rows);
        if (result.length > 100000) throw new Error("This stock export is too large. Export a smaller subcategory.");
        if (rows.length < size) break;
        const next = str(rows.at(-1)?.id);
        if (!next || next <= after) throw new Error("Stock pagination failed. Retry the export.");
        after = next;
      }
    }
    return result;
  }
  const type = str(sub.type), matrix = ["matrix", "led_screen_units"].includes(type), led = type === "led_screen_units";
  if (type && !["matrix","led_screen_units","fixture_units","lighting","chain_hoist_units","projector_units","lens_units"].includes(type)) throw new Error("This inventory type is not supported for stock export.");
  const items = matrix ? [] : await all("items", "id,name,description,fixture_type,photo_url", "subcategory_id", [subcategoryId], 100);
  const models = !matrix ? [] : await all("matrix_models", led ? "id,name,description,sort_order" : "id,name,description,photo_data,item_type,block_name,total_qty,in_use_qty,maintenance_qty,in_ksa_qty", "subcategory_id", [subcategoryId], 100);
  const units = matrix ? [] : await all("units", type === "chain_hoist_units" ? "id,item_id,status,expiry_date" : "id,item_id,status", "item_id", items.map(row=>str(row.id)));
  const matrixRows = !matrix ? [] : await all("matrix_rows", led ? "id,model_id,size,cabinet_model,qty,in_use_qty,maintenance_qty,in_ksa_qty,photo_data,sort_order"
    : "id,item_id,cable_length,total_qty,in_use_qty,maintenance_qty,in_ksa_qty", led ? "model_id" : "item_id", models.map(row=>str(row.id)), led ? 100 : 500);
  const reservations = await client.rpc("hems_pending_reservations").abortSignal(signal);
  if (reservations.error || !Array.isArray(reservations.data)) throw new Error("Reservations could not be verified. Retry online; no misleading Available counts were exported.");
  let order: StockRecord | null = null;
  if (type === "matrix") {
    const result = await client.from("matrix_manual_orders").select("block_order,item_order_by_block").eq("subcategory_id", subcategoryId).abortSignal(signal).maybeSingle();
    if (result.error) throw new Error("The saved Matrix order could not be loaded. Retry the export.");
    order = result.data as StockRecord | null;
  }
  return buildInventoryStock({ title: str(sub.name), category: str(category.name), type: str(sub.slug) === "lighting-fixtures" && str(category.slug) === "lighting" ? "lighting" : type,
    items, units, models, matrixRows, reservations: reservations.data as StockRecord[], order, now });
}
