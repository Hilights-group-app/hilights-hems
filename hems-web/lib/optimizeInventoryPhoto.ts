import sharp from "sharp";
export const INVENTORY_PHOTO_MAX_BYTES = 80 * 1024;

/** Enforce the same small inventory-photo budget as device uploads. Never
 * upload an uncompressed original when conversion cannot meet the limit. */
export async function optimizeInventoryPhoto(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  let side = 260, quality = 72;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal?.aborted) throw new Error("Photo conversion cancelled.");
    const output = await sharp(input, { limitInputPixels: 32 * 1024 * 1024, pages: 1 })
      .rotate().resize(side, side, { fit: "inside", withoutEnlargement: true })
      .webp({ quality }).timeout({ seconds: 3 }).toBuffer();
    if (signal?.aborted) throw new Error("Photo conversion cancelled.");
    if (output.length <= INVENTORY_PHOTO_MAX_BYTES) return output;
    side = Math.max(96, Math.round(side * 0.8));
    quality = Math.max(45, quality - 8);
  }
  throw new Error("The photo is still too large after compression.");
}

export async function readImportImageUrl(request: Pick<Request, "body">, signal: AbortSignal): Promise<string> {
  if (!request.body || signal.aborted) throw new Error("Invalid photo request.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 12288) { await reader.cancel(); throw new Error("Photo request is too large."); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const source = value && typeof value === "object" ? (value as Record<string, unknown>).imageUrl : undefined;
  if (typeof source !== "string" || source.length > 4096 || !/^https?:\/\//i.test(source.trim())) throw new Error("Invalid image URL.");
  return source.trim();
}
