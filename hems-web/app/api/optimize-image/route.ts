import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { randomUUID } from "node:crypto";
import { downloadPublicPdfPhoto, PdfPhotoDownloadError } from "@/lib/pdfPhotoDownload";
import { isInventoryStoragePhoto } from "@/lib/inventoryImportPhotos";
import { optimizeInventoryPhoto, readImportImageUrl, INVENTORY_PHOTO_MAX_BYTES } from "@/lib/optimizeInventoryPhoto";

export const runtime = "nodejs";
export const maxDuration = 30;
const noCache = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noCache });

export async function POST(req: NextRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  const abort = () => controller.abort();
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) controller.abort();
  try {
    // This route writes with the service role, which bypasses Storage policies.
    // Authorize before reading the body, downloading or uploading an image.
    const supabase = await createServerSupabase();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return failure("Sign in as Admin to save inventory photos.", 401);
    }
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (profileError) return failure("Admin permission could not be checked. Retry later.", 503);
    if (profile?.role !== "admin") return failure("Only Admin can save inventory photos.", 403);
    if (req.headers.get("sec-fetch-site") === "cross-site") return failure("Invalid photo request origin.", 403);
    if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? "")) return failure("Send a JSON photo request.", 415);
    let imageUrl: string;
    try { imageUrl = await readImportImageUrl(req, controller.signal); }
    catch { return failure("Invalid or oversized photo request.", 400); }
    const input = await downloadPublicPdfPhoto(imageUrl, controller.signal);
    let output: Buffer;
    try { output = await optimizeInventoryPhoto(input, controller.signal); }
    catch { return failure("The photo could not be compressed. Upload another image from your device.", 422); }
    if (controller.signal.aborted) return failure("Photo request timed out. Retry later.", 504);
    // Existing small thumbnails already belong to our Storage bucket. Verify
    // they download/decode, then reuse rather than uploading another copy.
    if (input.length <= INVENTORY_PHOTO_MAX_BYTES && isInventoryStoragePhoto(imageUrl, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
      return NextResponse.json({ url: imageUrl }, { headers: noCache });
    }
    const filePath = `items/thumbs/${randomUUID()}.webp`;

    const { error } = await supabaseAdmin.storage
      .from("equipment-photos")
      .upload(filePath, output, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      return failure("The photo could not be saved to Supabase Storage. Upload it from your device later.", 500);
    }

    const { data } = supabaseAdmin.storage
      .from("equipment-photos")
      .getPublicUrl(filePath);

    return NextResponse.json({ url: data.publicUrl }, { headers: noCache });
  } catch (error: unknown) {
    if (controller.signal.aborted) return failure("Photo download timed out. Upload it from your device later.", 504);
    if (error instanceof PdfPhotoDownloadError) return failure(error.message, 502);
    return failure("The photo could not be saved. Upload it from your device later.", 500);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
  }
}
