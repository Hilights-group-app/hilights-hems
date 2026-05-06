"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readCatalog } from "@/lib/catalogStore";

type Category = {
  id: string;
  name: string;
  slug: string;
  subcategories: {
    id: string;
    name: string;
    slug: string;
  }[];
};

export default function InventoryClient() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSub, setLoadingSub] = useState<string | null>(null);

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function loadCatalog() {
    try {
      const data = await readCatalog();
      setCategories(data.categories || []);
    } catch (e) {
      console.error("Inventory load error:", e);
      setCategories([]);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="mx-auto max-w-[1100px] space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-gray-200 bg-white px-4 py-4 shadow-sm">
              <div className="mb-4 h-4 w-32 animate-pulse rounded bg-gray-200" />
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className="h-9 animate-pulse rounded-xl bg-gray-200 sm:h-7 sm:w-24 sm:rounded-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="mx-auto max-w-[1100px] space-y-3">
        {categories.map((cat) => (
          <div
            key={cat.id}
            className="rounded-2xl border border-gray-200 bg-white px-4 py-4 shadow-sm sm:rounded-xl sm:px-3 sm:py-2"
          >
            <div className="mb-3 flex items-center justify-between sm:mb-1.5">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-red-500 sm:h-1.5 sm:w-1.5" />
                <h2 className="text-[15px] font-bold leading-none text-gray-900 sm:text-sm sm:font-semibold">
                  {cat.name}
                </h2>
              </div>

              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 sm:hidden">
                {cat.subcategories.length}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-1.5">
              {cat.subcategories.map((sub) => (
                <Link
                  key={sub.id}
                  href={`/inventory/${cat.slug}/${sub.slug}`}
                  onClick={() => setLoadingSub(sub.id)}
                  className={`
                    relative flex min-h-[42px] items-center justify-center overflow-hidden rounded-xl border px-3 py-2 text-center text-[12px] font-semibold shadow-sm transition-all duration-200
                    sm:min-h-0 sm:rounded-full sm:px-3 sm:py-1.5 sm:text-[11px] sm:font-medium sm:shadow-none
                    ${
                      loadingSub === sub.id
                        ? "scale-95 border-red-200 bg-red-100 text-red-700 shadow-inner"
                        : "border-gray-200 bg-white text-gray-800 active:scale-95 active:bg-red-100 sm:border-gray-300 sm:text-gray-700 sm:hover:border-red-200 sm:hover:bg-red-50 sm:hover:text-red-700 sm:hover:shadow-sm"
                    }
                  `}
                >
                  {loadingSub === sub.id ? "Loading..." : sub.name}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}