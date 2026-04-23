"use client";

import Link from "next/link";

function formatName(slug: string) {
  return (slug || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SubcategoryClientLenses({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const title = formatName(subcategory);

  return (
    <div className="space-y-4">
      <div className="bg-white border rounded-2xl p-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          <p className="text-sm text-gray-500 mt-1">Type: Lens Units</p>
        </div>
        <Link href="/inventory" className="px-4 py-2 rounded-xl border hover:bg-gray-50">
          Back
        </Link>
      </div>

      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <p className="text-sm text-gray-700">
          ✅ Placeholder Lenses page. Next: build fields (Lens type, Throw ratio, Serial, Status...)
        </p>
      </div>
    </div>
  );
}