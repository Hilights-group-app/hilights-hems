import { createClient } from "@/lib/supabase/client";
import { createBrowserId } from "@/lib/browserId";

export type PhotoPurpose = "item" | "avatar" | "report";
const SETTINGS = {
  item: { maxSide: 260, maxBytes: 80 * 1024, quality: 0.72 },
  avatar: { maxSide: 256, maxBytes: 64 * 1024, quality: 0.72 },
  report: { maxSide: 1280, maxBytes: 350 * 1024, quality: 0.8 },
};

/** Never fall back to saving the original file when compression fails. */
export async function compressEquipmentPhoto(file: File, purpose: PhotoPurpose = "item"): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024) {
    throw new Error("Choose an image smaller than 25 MB.");
  }
  const settings = SETTINGS[purpose];
  const source = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This image could not be opened. Try JPEG, PNG or WebP."));
      img.src = source;
    });
    let side = settings.maxSide;
    let quality = settings.quality;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Image compression is unavailable in this browser.");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (blob && blob.type !== "image/webp") {
        // Older Safari may silently encode PNG for an unsupported WebP request.
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      }
      if (!blob) throw new Error("Image compression failed. Please try another photo.");
      if (blob.size <= settings.maxBytes) return blob;
      side = Math.max(96, Math.round(side * 0.8));
      quality = Math.max(0.45, quality - 0.08);
    }
    throw new Error("This image is still too large after compression. Please choose a smaller photo.");
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function uploadEquipmentPhoto(file: File, purpose: PhotoPurpose = "item"): Promise<string> {
  const blob = await compressEquipmentPhoto(file, purpose);
  const folder = purpose === "report" ? "unit-reports" : purpose === "avatar" ? "avatars" : "items";
  const extension = blob.type === "image/webp" ? "webp" : "jpg";
  const path = `${folder}/thumbs/${createBrowserId()}.${extension}`;
  const client = createClient();
  const { error } = await client.storage.from("equipment-photos").upload(path, blob, {
    contentType: blob.type, cacheControl: "31536000", upsert: false,
  });
  if (error) throw new Error(error.message || "Photo upload failed.");
  return client.storage.from("equipment-photos").getPublicUrl(path).data.publicUrl;
}

/** Small preview for account forms; the protected admin API stores it in Storage. */
export async function compressedAvatarPreview(file: File): Promise<string> {
  const blob = await compressEquipmentPhoto(file, "avatar");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read the compressed photo."));
    reader.readAsDataURL(blob);
  });
}
