import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPdfPhotoAllowed, readPdfPhotoRequest, type PdfPhotoLine, type PdfPhotoRecord } from "@/lib/pdfPhotoAccess";
import { downloadPublicPdfPhoto, PdfPhotoDownloadError } from "@/lib/pdfPhotoDownload";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 30;
const noCache = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error: string, status: number, code: string) => NextResponse.json({ error, code }, { status, headers: noCache });

/** Read-only photo conversion for a list the signed-in user can SELECT.
 * Deliberately separate from the Admin optimizer: no Storage uploads, service
 * role, role changes, inventory updates, or persistent photo copies. */
export async function POST(req: NextRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  const abort = () => controller.abort();
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) controller.abort();
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return failure("Sign in to export equipment photos.", 401, "UNAUTHORIZED");
    if (req.headers.get("sec-fetch-site") === "cross-site") return failure("Invalid photo request origin.", 403, "FORBIDDEN");
    if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? "")) {
      return failure("Send a JSON photo request.", 415, "INVALID_CONTENT_TYPE");
    }
    let input;
    try { input = await readPdfPhotoRequest(req, controller.signal); }
    catch {
      if (controller.signal.aborted) return failure("Photo request timed out. Retry the export.", 504, "PHOTO_TIMEOUT");
      return failure("Invalid or oversized photo request.", 400, "INVALID_REQUEST");
    }
    const visible = await supabase.from("equipment_lists").select("id").eq("id", input.listId)
      .abortSignal(controller.signal).maybeSingle();
    if (visible.error) return failure("The list could not be checked. Retry the export.", 503, "LIST_CHECK_FAILED");
    if (!visible.data) return failure("This list is not available to you.", 404, "LIST_UNAVAILABLE");
    const record = await supabase.from("equipment_list_items")
      .select("id,inventory_record_type,inventory_record_id,parent_record_id,metadata")
      .eq("id", input.lineId).eq("list_id", input.listId).abortSignal(controller.signal).maybeSingle();
    if (record.error) return failure("The equipment photo could not be checked. Retry the export.", 503, "ITEM_CHECK_FAILED");
    if (!record.data) return failure("This equipment line is not available in the list.", 404, "ITEM_UNAVAILABLE");
    const allowed = await isPdfPhotoAllowed(record.data as unknown as PdfPhotoLine, input.imageUrl, async (table, id, columns) => {
      const result = await supabase.from(table).select(columns).eq("id", id).abortSignal(controller.signal).maybeSingle();
      if (result.error) throw new Error("The current inventory photo could not be checked.");
      return result.data as unknown as PdfPhotoRecord | null;
    });
    if (!allowed) return failure("This photo does not belong to the selected equipment line.", 403, "PHOTO_NOT_ALLOWED");
    const bytes = await downloadPublicPdfPhoto(input.imageUrl, controller.signal);
    let output: Buffer;
    try {
      output = await sharp(bytes, { limitInputPixels: 32 * 1024 * 1024, pages: 1 })
        .rotate().resize(240, 240, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).timeout({ seconds: 5 }).toBuffer();
    } catch { return failure("The downloaded photo could not be converted.", 422, "PHOTO_DECODE_FAILED"); }
    if (controller.signal.aborted) return failure("Photo download timed out. Retry the export.", 504, "PHOTO_TIMEOUT");
    return new NextResponse(new Uint8Array(output), { headers: { ...noCache, "Content-Type": "image/jpeg" } });
  } catch (error: unknown) {
    if (controller.signal.aborted) return failure("Photo download timed out. Retry the export.", 504, "PHOTO_TIMEOUT");
    if (error instanceof PdfPhotoDownloadError) return failure(error.message, 502, error.code);
    return failure("The PDF photo could not be downloaded. Retry the export.", 502, "PHOTO_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
  }
}
