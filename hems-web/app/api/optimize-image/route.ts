import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import sharp from "sharp";

export async function POST(req: NextRequest) {
  try {
    // This route writes with the service role, which bypasses Storage policies.
    // Authorize before reading the body, downloading or uploading an image.
    const supabase = await createServerSupabase();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError || profile?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
