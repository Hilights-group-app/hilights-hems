import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";

type ImageResult = { title: string; image: string; thumbnail: string };
type SearchResult =
  | { images: ImageResult[] }
  | { error: string; status: number };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function searchQueries(query: string): string[] {
  // Keep model names, including words such as LED/Profile and models without digits.
  const simplified = query
    .replace(
      /\b(equipment|system|professional|lighting|fixture|luminaire|accessory|accessories)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const fallback =
    simplified && simplified.toLowerCase() !== query.toLowerCase()
      ? simplified
      : `${query} product`;

  return fallback.length <= 120 ? [query, fallback] : [query];
}

function providerFailure(status: number, message: string): SearchResult {
  if (
    status === 429 ||
    /quota|rate limit|too many requests|run out of searches|ran out of searches|search(?:es)? limit|credits? (?:exhausted|depleted)/i.test(
      message,
    )
  ) {
    return {
      error: "Image search limit reached. Please upload a photo or try again later.",
      status: 429,
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    /invalid.*api.?key|api.?key.*(?:invalid|missing)|unauthorized|authentication/i.test(
      message,
    )
  ) {
    return {
      error: "Image search is not configured correctly. Please contact an administrator.",
      status: 503,
    };
  }

  return {
    error: "Image search is temporarily unavailable. Please try again or upload a photo.",
    status: 502,
  };
}

async function fetchImages(
  query: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchResult> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, { cache: "no-store", signal });
  // A response body can contain an error even when its HTTP status is 200.
  const data = record(
    await response.json().catch((error) => {
      if (signal.aborted) throw error;
      return null;
    }),
  );
  const message = typeof data?.error === "string" ? data.error : "";

  if (!response.ok) return providerFailure(response.status, message);

  const emptySearch =
    /^Google(?: Images)? hasn['’]t returned any results for this query\.?$/i.test(
      message.trim(),
    );
  const metadata = record(data?.search_metadata);

  if ((message && !emptySearch) || metadata?.status === "Error") {
    return providerFailure(response.status, message);
  }

  const rawImages = data?.images_results;
  if (!Array.isArray(rawImages)) {
    if (emptySearch) return { images: [] };
    return {
      error: "Image search returned an incomplete response. Please try again.",
      status: 502,
    };
  }

  const images: ImageResult[] = [];
  const seen = new Set<string>();

  for (const value of rawImages) {
    const image = record(value);
    if (!image) continue;
    const original =
      typeof image?.original === "string" && /^https?:\/\//i.test(image.original)
        ? image.original
        : "";
    const thumbnail =
      typeof image?.thumbnail === "string" && /^https?:\/\//i.test(image.thumbnail)
        ? image.thumbnail
        : "";
    const imageUrl = original || thumbnail;
    if (!imageUrl || seen.has(imageUrl)) continue;

    seen.add(imageUrl);
    images.push({
      title: typeof image?.title === "string" ? image.title : "",
      image: imageUrl,
      thumbnail: thumbnail || imageUrl,
    });
    if (images.length === 24) break;
  }

  if (rawImages.length > 0 && images.length === 0) {
    return {
      error: "Image search returned no usable photos. Please try again.",
      status: 502,
    };
  }

  return { images };
}

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

  const query = (req.nextUrl.searchParams.get("q") ?? "")
    .replace(/\s+/g, " ")
    .trim();

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
    // At most two searches, within one deadline. Retry only a genuine empty search.
    const signal = AbortSignal.timeout(20_000);
    for (const candidate of searchQueries(query)) {
      const result = await fetchImages(candidate, apiKey, signal);
      if ("error" in result) {
        return NextResponse.json(
          { error: result.error },
          { status: result.status },
        );
      }
      if (result.images.length > 0) return NextResponse.json(result.images);
    }

    return NextResponse.json([]);
  } catch (error: any) {
    // Fetch errors can contain the URL (including the key), so log only the type.
    console.error("Google image search error", { name: error?.name });

    const timedOut =
      error?.name === "TimeoutError" ||
      error?.name === "AbortError" ||
      error?.code === "UND_ERR_ABORTED";

    return NextResponse.json(
      {
        error: timedOut
          ? "Image search timed out. Please try again."
          : "Image search is temporarily unavailable. Please try again or upload a photo.",
      },
      { status: timedOut ? 504 : 502 },
    );
  }
}
