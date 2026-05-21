import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import sharp from "sharp";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const imageUrl = String(body?.imageUrl || "");

    if (!imageUrl) {
      return NextResponse.json({ error: "Missing imageUrl" }, { status: 400 });
    }

    const res = await fetch(imageUrl);

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to download image" },
        { status: 400 }
      );
    }

    const input = Buffer.from(await res.arrayBuffer());

    const output = await sharp(input)
      .resize(260, 260, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();

    const filePath = `items/thumbs/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.webp`;

    const { error } = await supabaseAdmin.storage
      .from("equipment-photos")
      .upload(filePath, output, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const { data } = supabaseAdmin.storage
      .from("equipment-photos")
      .getPublicUrl(filePath);

    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to optimize image" },
      { status: 500 }
    );
  }
}