import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient as createServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

async function requireInventoryEditor() {
  const supabase = await createServerSupabase();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "Unauthorized", status: 401 as const };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (
    profileError ||
    !profile ||
    !["admin", "warehouse_manager"].includes(profile.role)
  ) {
    return { error: "Forbidden", status: 403 as const };
  }

  return { userId: user.id };
}

function isPrivateAddress(address: string) {
  const cleanAddress = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (cleanAddress.startsWith("::ffff:")) {
    return isPrivateAddress(cleanAddress.slice(7));
  }

  if (isIP(cleanAddress) === 4) {
    const parts = cleanAddress.split(".").map(Number);
    const [a, b] = parts;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (isIP(cleanAddress) === 6) {
    return (
      cleanAddress === "::" ||
      cleanAddress === "::1" ||
      cleanAddress.startsWith("fc") ||
      cleanAddress.startsWith("fd") ||
      cleanAddress.startsWith("fe8") ||
      cleanAddress.startsWith("fe9") ||
      cleanAddress.startsWith("fea") ||
      cleanAddress.startsWith("feb") ||
      cleanAddress.startsWith("ff")
    );
  }

  return true;
}

async function validateRemoteUrl(url: URL) {
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS image URLs are allowed");
  }

  if (url.username || url.password) {
    throw new Error("Invalid image URL");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Invalid image host");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private network addresses are not allowed");
    }

    return;
  }

  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("Invalid image host");
  }
}

async function fetchRemoteImage(
  url: URL,
  redirectsLeft = MAX_REDIRECTS
): Promise<Response> {
  await validateRemoteUrl(url);

  const response = await fetch(url, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    headers: {
      "User-Agent": "Hilights-HEMS-Image-Optimizer/1.0",
      Accept: "image/jpeg,image/png,image/webp,image/avif,image/gif",
    },
  });

  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.get("location")
  ) {
    if (redirectsLeft <= 0) {
      throw new Error("Too many image redirects");
    }

    const nextUrl = new URL(
      response.headers.get("location")!,
      url
    );

    return fetchRemoteImage(nextUrl, redirectsLeft - 1);
  }

  return response;
}

async function readLimitedBody(response: Response) {
  if (!response.body) {
    throw new Error("Image response is empty");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;

    if (totalBytes > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Image is larger than 8 MB");
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function POST(req: NextRequest) {
  const guard = await requireInventoryEditor();

  if ("error" in guard) {
    return NextResponse.json(
      { error: guard.error },
      { status: guard.status }
    );
  }

  try {
    const body = await req.json();
    const imageUrl = String(body?.imageUrl ?? "").trim();

    if (!imageUrl) {
      return NextResponse.json(
        { error: "Missing imageUrl" },
        { status: 400 }
      );
    }

    if (imageUrl.length > 2048) {
      return NextResponse.json(
        { error: "Image URL is too long" },
        { status: 400 }
      );
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      return NextResponse.json(
        { error: "Invalid image URL" },
        { status: 400 }
      );
    }

    const response = await fetchRemoteImage(parsedUrl);

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to download image" },
        { status: 400 }
      );
    }

    const contentType = (
      response.headers.get("content-type") ?? ""
    )
      .split(";")[0]
      .trim()
      .toLowerCase();

    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/gif",
    ]);

    if (!allowedTypes.has(contentType)) {
      return NextResponse.json(
        { error: "Unsupported image type" },
        { status: 400 }
      );
    }

    const declaredSize = Number(
      response.headers.get("content-length") ?? "0"
    );

    if (
      Number.isFinite(declaredSize) &&
      declaredSize > MAX_IMAGE_BYTES
    ) {
      return NextResponse.json(
        { error: "Image is larger than 8 MB" },
        { status: 400 }
      );
    }

    const input = await readLimitedBody(response);

    const output = await sharp(input, {
      limitInputPixels: 40_000_000,
      animated: false,
    })
      .rotate()
      .resize(260, 260, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 72 })
      .toBuffer();

    const filePath = `items/thumbs/${guard.userId}/${randomUUID()}.webp`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("equipment-photos")
      .upload(filePath, output, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.json(
        { error: uploadError.message },
        { status: 500 }
      );
    }

    const { data } = supabaseAdmin.storage
      .from("equipment-photos")
      .getPublicUrl(filePath);

    return NextResponse.json({ url: data.publicUrl });
  } catch (error: any) {
    console.error("Optimize image error", error);

    return NextResponse.json(
      { error: error?.message || "Failed to optimize image" },
      { status: 500 }
    );
  }
}