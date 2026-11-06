/** Server-side access checks for one PDF image. No service role or writes. */
export type PdfPhotoTable = "items" | "units" | "matrix_models" | "matrix_rows";
export type PdfPhotoRecord = Record<string, unknown>;
export type PdfPhotoLine = {
  id: string;
  inventory_record_type: string;
  inventory_record_id: string;
  parent_record_id: string | null;
  metadata: PdfPhotoRecord | null;
};
export type PdfPhotoRequest = { listId: string; lineId: string; imageUrl: string };
export const photoUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function parsePdfPhotoRequest(body: unknown): PdfPhotoRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid photo request.");
  const value = body as Record<string, unknown>;
  if (!photoUuid(value.listId) || !photoUuid(value.lineId) || typeof value.imageUrl !== "string"
    || value.imageUrl.length > 4096 || !/^https?:\/\//i.test(value.imageUrl)) throw new Error("Invalid photo request.");
  return { listId: value.listId, lineId: value.lineId, imageUrl: value.imageUrl.trim() };
}

/** Reject oversized bodies even when Content-Length was omitted or lied about. */
export async function readPdfPhotoRequest(request: Pick<Request, "body">, signal?: AbortSignal): Promise<PdfPhotoRequest> {
  if (!request.body) throw new Error("Missing photo request.");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) { cancel(); reader.releaseLock(); throw new Error("Photo request cancelled."); }
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 12288) { await reader.cancel(); throw new Error("Photo request is too large."); }
      chunks.push(part.value);
    }
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parsePdfPhotoRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

/** Only exact saved/current photos of this already RLS-authorized list line. */
export async function isPdfPhotoAllowed(line: PdfPhotoLine, imageUrl: string, read: (
  table: PdfPhotoTable, id: string, columns: string,
) => Promise<PdfPhotoRecord | null>): Promise<boolean> {
  const meta = line.metadata ?? {};
  if ([meta.photo_url, meta.photo_data].some(value => text(value) === imageUrl)) return true;
  if (meta.custom_item === true || meta.custom_item === "true") return false;
  const recordId = line.inventory_record_id;
  if (!photoUuid(recordId)) return false;
  const firstId = (...values: unknown[]) => values.find(photoUuid) as string | undefined;
  const photo = async (table: "items" | "matrix_models", id: string | undefined) => {
    if (!id) return false;
    const field = table === "items" ? "photo_url" : "photo_data";
    return text((await read(table, id, `id,${field}`))?.[field]) === imageUrl;
  };
  if (line.inventory_record_type === "matrix_model") return photo("matrix_models", recordId);
  if (line.inventory_record_type === "item") return photo("items", recordId);
  if (line.inventory_record_type === "unit") {
    const savedParent = firstId(line.parent_record_id, meta.item_id);
    const row = savedParent ? null : await read("units", recordId, "id,item_id");
    return photo("items", savedParent ?? firstId(row?.item_id));
  }
  if (line.inventory_record_type === "matrix_row") {
    const generic = meta.matrix_source === "generic";
    const savedParent = firstId(line.parent_record_id, meta.item_id, meta.model_id);
    const row = !generic || !savedParent
      ? await read("matrix_rows", recordId, generic ? "id,item_id" : "id,model_id,photo_data") : null;
    if (!generic && text(row?.photo_data) === imageUrl) return true;
    return photo("matrix_models", savedParent ?? firstId(row?.item_id, row?.model_id));
  }
  return false;
}
