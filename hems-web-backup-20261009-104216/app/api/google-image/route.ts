import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";

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

export async function GET(req: NextRequest) {
  const guard = await requireInventoryEditor();

  if ("error" in guard) {
    return NextResponse.json(
      { error: guard.error },
      { status: guard.status },
    );
  }

  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }

  if (query.length > 120) {
    return NextResponse.json(
      { error: "Search query is too long" },
      { status: 400 },
    );
  }

  const apiKey = process.env.SERPAPI_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Image search is not configured" },
      { status: 500 },
    );
  }

  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_images");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", apiKey);

    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Image search service failed" },
        { status: 502 },
      );
    }

    const data = await res.json();

    const images = Array.isArray(data?.images_results)
      ? data.images_results.slice(0, 24).map((img: any) => ({
          title: String(img?.title ?? ""),
          image: String(img?.original ?? ""),
          thumbnail: String(img?.thumbnail ?? ""),
        }))
      : [];

    return NextResponse.json(images);
  } catch (error: any) {
    console.error("Google image search error", error);

    const timedOut =
      error?.name === "TimeoutError" || error?.code === "UND_ERR_ABORTED";

    return NextResponse.json(
      {
        error: timedOut
          ? "Image search timed out. Please try again."
          : "Failed to fetch images",
      },
      { status: timedOut ? 504 : 500 },
    );
  }
}
