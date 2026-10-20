import "server-only";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Called only after the admin API's existing authorization check. */
export async function storeAvatarPhoto(input: string): Promise<string> {
  if (!input || !input.startsWith("data:")) return input;
  if (input.length > 20 * 1024 * 1024) throw new Error("Avatar is too large. Choose a smaller photo.");
  const match = /^data:image\/(?:webp|jpeg|jpg|png);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(input);
  if (!match) throw new Error("Choose a JPEG, PNG or WebP avatar.");
  const output = await sharp(Buffer.from(match[1], "base64"), { limitInputPixels: 60000000 })
    .rotate().resize(256, 256, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
  if (output.length > 100 * 1024) throw new Error("Avatar is too large after compression.");
  const path = `avatars/thumbs/${randomUUID()}.webp`;
  const { error } = await supabaseAdmin.storage.from("equipment-photos").upload(path, output, {
    contentType: "image/webp", cacheControl: "31536000", upsert: false,
  });
  if (error) throw new Error(error.message);
  return supabaseAdmin.storage.from("equipment-photos").getPublicUrl(path).data.publicUrl;
}
