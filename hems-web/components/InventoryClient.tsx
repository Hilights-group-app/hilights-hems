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

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function loadCatalog() {
    const data = await readCatalog();
    setCategories(data.categories || []);
  }

  return (
    <div className="p-3 space-y-2 bg-gray-50 min-h-screen">
      {categories.map((cat) => (
        <div
          key={cat.id}
          className="bg-white border border-gray-200 rounded-xl px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
            <h2 className="text-sm font-semibold text-gray-900 leading-none">
              {cat.name}
            </h2>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {cat.subcategories.map((sub) => (
              <Link
                key={sub.id}
                href={`/inventory/${cat.slug}/${sub.slug}`}
                className="
                  px-2.5 py-1
                  rounded-full
                  border border-gray-300
                  text-[11px] font-medium text-gray-700
                  bg-white
                  transition-all duration-150 ease-out
                  hover:bg-red-50
                  hover:border-red-200
                  hover:text-red-700
                  hover:shadow-sm
                  active:scale-[0.98]
                "
              >
                {sub.name}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}