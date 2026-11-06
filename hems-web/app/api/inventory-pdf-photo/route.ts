import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { downloadPublicPdfPhoto, PdfPhotoDownloadError } from "@/lib/pdfPhotoDownload";
import { optimizeInventoryPhoto, readImportImageUrl } from "@/lib/optimizeInventoryPhoto";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers });

/** Read-only inventory image export. Normal user/RLS client, never Admin Storage. */
export async function POST(req: NextRequest) {
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(), 20000);
  const abort = ()=>controller.abort(); req.signal.addEventListener("abort",abort,{once:true});
  if (req.signal.aborted) controller.abort();
  try {
    const client = await createClient();
    const {data:{user},error} = await client.auth.getUser();
    if (error || !user) return fail("Sign in to export inventory photos.",401);
    if (req.headers.get("sec-fetch-site") === "cross-site") return fail("Invalid request origin.",403);
    if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type")??"")) return fail("Send a JSON request.",415);
    // Keep the URL in the bounded JSON parser. The exact record proof is in
    // validated request headers, not an arbitrary table name or proxy URL.
    const kind = req.headers.get("x-hems-photo-type"), id = req.headers.get("x-hems-photo-id")??"";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      || !["item","matrix_model","matrix_row"].includes(kind??"")) return fail("Invalid inventory photo record.",400);
    let imageUrl: string;
    try { imageUrl=await readImportImageUrl(req,controller.signal); } catch { return fail("Invalid photo request.",400); }
    const table = kind === "item" ? "items" : kind === "matrix_model" ? "matrix_models" : "matrix_rows";
    const field = kind === "item" ? "photo_url" : "photo_data";
    const result=await client.from(table).select(`id,${field}`).eq("id",id).abortSignal(controller.signal).maybeSingle();
    if (result.error) return fail("The current inventory photo could not be checked.",503);
    const row=result.data as unknown as Record<string,unknown> | null;
    if (!row) return fail("This inventory item is unavailable to you.",404);
    if (typeof row[field]!=="string" || row[field].trim()!==imageUrl) return fail("This photo is not the current image of the selected item.",403);
    const bytes=await downloadPublicPdfPhoto(imageUrl,controller.signal);
    const output=await optimizeInventoryPhoto(bytes,controller.signal);
    return new NextResponse(new Uint8Array(output),{headers:{...headers,"Content-Type":"image/webp"}});
  } catch(error:unknown) {
    if(controller.signal.aborted)return fail("Photo download timed out.",504);
    if(error instanceof PdfPhotoDownloadError)return fail(error.message,502);
    return fail("This inventory photo could not be converted.",422);
  } finally {clearTimeout(timer);req.signal.removeEventListener("abort",abort);}
}
