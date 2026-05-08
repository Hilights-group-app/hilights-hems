import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q");

  if (!query) {
    return NextResponse.json(
      { error: "Missing query" },
      { status: 400 }
    );
  }

  try {
    const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(
      query
    )}&api_key=${process.env.SERPAPI_KEY}`;

    const res = await fetch(url);

    const data = await res.json();

    const images =
      data.images_results?.map((img: any) => ({
        title: img.title,
        image: img.original,
        thumbnail: img.thumbnail,
      })) || [];

    return NextResponse.json(images);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch images" },
      { status: 500 }
    );
  }
}