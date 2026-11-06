import type { EquipmentListItem } from "./equipmentLists";

export type PdfPhotoImage = { dataUrl: string; width: number; height: number };
export type PhotoCatalogTable = "items" | "matrix_models" | "matrix_rows" | "units";
export type PhotoCatalogRow = { id: string; photo_url?: unknown; photo_data?: unknown; item_id?: unknown; model_id?: unknown };
type PhotoGroup = { key: string; displayName: string; items: readonly EquipmentListItem[] };
const tables: PhotoCatalogTable[] = ["items", "matrix_models", "matrix_rows", "units"];
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean(value)) ? clean(value).toLowerCase() : "";
const custom = (item: EquipmentListItem) => item.metadata?.custom_item === true || item.metadata?.custom_item === "true";
const unique = (sources: unknown[]) => Array.from(new Set(sources.map(clean).filter(Boolean)));

async function mapLimited<T>(values: readonly T[], run: (value: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; await run(values[index]); }
  }));
}

/** One export-scoped cache. Never pulls the whole inventory or changes list metadata. */
export async function prepareListPdfPhotos({ groups, readCatalog, loadPhoto, loadServerPhoto }: {
  groups: readonly PhotoGroup[];
  readCatalog: (table: PhotoCatalogTable, ids: string[]) => Promise<readonly PhotoCatalogRow[]>;
  loadPhoto: (source: string, fresh?: boolean) => Promise<PdfPhotoImage | null>;
  loadServerPhoto?: (source: string, lineId: string) => Promise<PdfPhotoImage | null>;
}) {
  const photos = new Map<string, PdfPhotoImage>();
  const images = new Map<string, Promise<PdfPhotoImage | null>>();
  const retries = new Map<string, Promise<PdfPhotoImage | null>>();
  const serverImages = new Map<string, Promise<PdfPhotoImage | null>>();
  const catalog = Object.fromEntries(tables.map(table => [table, new Map<string, PhotoCatalogRow>()])) as Record<PhotoCatalogTable, Map<string, PhotoCatalogRow>>;
  const snapshotSources = (group: PhotoGroup) => unique(group.items.flatMap(item => [item.metadata?.photo_url, item.metadata?.photo_data]));

  async function image(source: string, refresh: boolean, group: PhotoGroup) {
    let request = images.get(source);
    if (!request) {
      request = Promise.resolve().then(() => loadPhoto(source, false)).catch(() => null);
      images.set(source, request);
    }
    const result = await request;
    if (result) return result;
    // <img> can display an external photo even when browser fetch is denied by
    // CORS. Use the read-only, list-authorized server route, never the Admin
    // optimizer (which uploads another file). Share each attempt per export.
    if (loadServerPhoto && /^https?:\/\//i.test(source)) {
      let server = serverImages.get(source);
      if (!server) {
        const line = group.items.find(item => unique([item.metadata?.photo_url, item.metadata?.photo_data]).includes(source))
          ?? group.items.find(item => !custom(item));
        if (line && uuid(line.id)) {
          server = Promise.resolve().then(() => loadServerPhoto(source, line.id)).catch(() => null);
          serverImages.set(source, server);
        }
      }
      if (server) { const recovered = await server; if (recovered) return recovered; }
    }
    if (!refresh) return null;
    let retry = retries.get(source);
    if (!retry) { retry = Promise.resolve().then(() => loadPhoto(source, true)).catch(() => null); retries.set(source, retry); }
    return retry;
  }
  async function fill(group: PhotoGroup, sources: string[], refresh: boolean) {
    for (const source of sources) {
      const loaded = await image(source, refresh, group);
      if (loaded) { photos.set(group.key, loaded); return; }
    }
  }
  await mapLimited(groups, group => fill(group, snapshotSources(group), false));
  const missing = groups.filter(group => !photos.has(group.key) && group.items.some(item => !custom(item)));

  function refs() { return Object.fromEntries(tables.map(table => [table, new Set<string>()])) as Record<PhotoCatalogTable, Set<string>>; }
  function add(target: Set<string>, value: unknown) { const id = uuid(value); if (id) target.add(id); }
  async function read(requests: Record<PhotoCatalogTable, Set<string>>) {
    // Small, sequential ID batches avoid a request per line and large inline-photo payload bursts.
    for (const table of tables) {
      const ids = Array.from(requests[table]);
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        try {
          for (const row of await readCatalog(table, batch)) {
            // Ignore unrelated rows rather than associating photos by name or array index.
            const id = uuid(row.id);
            if (id && batch.includes(id)) catalog[table].set(id, row);
          }
        } catch { /* Keep the PDF usable; unresolved equipment is reported below. */ }
      }
    }
  }

  const leaf = refs();
  for (const group of missing) for (const item of group.items) {
    if (custom(item)) continue;
    if (item.inventory_record_type === "matrix_row" && (item.metadata?.matrix_source !== "generic" || !uuid(item.parent_record_id) && !uuid(item.metadata?.item_id))) add(leaf.matrix_rows, item.inventory_record_id);
    if (item.inventory_record_type === "unit" && !uuid(item.parent_record_id) && !uuid(item.metadata?.item_id)) add(leaf.units, item.inventory_record_id);
  }
  await read(leaf);
  const parents = refs();
  for (const group of missing) for (const item of group.items) {
    if (custom(item)) continue;
    if (item.inventory_record_type === "matrix_model") add(parents.matrix_models, item.inventory_record_id);
    else if (item.inventory_record_type === "matrix_row") {
      const row = catalog.matrix_rows.get(uuid(item.inventory_record_id));
      add(parents.matrix_models, uuid(item.parent_record_id) || uuid(item.metadata?.item_id) || uuid(item.metadata?.model_id) || uuid(row?.item_id) || uuid(row?.model_id));
    } else if (item.inventory_record_type === "unit") add(parents.items, uuid(item.parent_record_id) || uuid(item.metadata?.item_id) || uuid(catalog.units.get(uuid(item.inventory_record_id))?.item_id));
    else if (item.inventory_record_type === "item") add(parents.items, item.inventory_record_id);
  }
  await read(parents);

  function currentSources(group: PhotoGroup) {
    const sources: unknown[] = [];
    for (const item of group.items) {
      if (custom(item)) continue;
      if (item.inventory_record_type === "matrix_model") sources.push(catalog.matrix_models.get(uuid(item.inventory_record_id))?.photo_data);
      else if (item.inventory_record_type === "matrix_row") {
        const row = catalog.matrix_rows.get(uuid(item.inventory_record_id));
        const parent = uuid(item.parent_record_id) || uuid(item.metadata?.item_id) || uuid(item.metadata?.model_id) || uuid(row?.item_id) || uuid(row?.model_id);
        sources.push(row?.photo_data, catalog.matrix_models.get(parent)?.photo_data);
      } else if (item.inventory_record_type === "unit") {
        const parent = uuid(item.parent_record_id) || uuid(item.metadata?.item_id) || uuid(catalog.units.get(uuid(item.inventory_record_id))?.item_id);
        sources.push(catalog.items.get(parent)?.photo_url);
      } else if (item.inventory_record_type === "item") sources.push(catalog.items.get(uuid(item.inventory_record_id))?.photo_url);
    }
    return unique([...sources, ...snapshotSources(group)]);
  }
  await mapLimited(missing, group => fill(group, currentSources(group), true));
  // Custom items may intentionally have no image; do not warn about those.
  return { photos, unavailable: missing.filter(group => !photos.has(group.key)).map(group => group.displayName) };
}
