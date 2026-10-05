"use client";

import { useEffect, useState } from "react";

export type OnlineImageSearchResult = {
  title?: string;
  image?: string;
  original?: string;
  thumbnail?: string;
};

export default function OnlineImageSearchPanel({
  initialQuery,
  results,
  searching,
  onSearch,
  onSelect,
  onClose,
  className = "",
}: {
  initialQuery: string;
  results: OnlineImageSearchResult[];
  searching: boolean;
  onSearch: (query: string) => void | Promise<void>;
  onSelect: (image: OnlineImageSearchResult) => void | Promise<void>;
  onClose: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  function submitSearch() {
    const clean = query.trim();
    if (!clean || searching) return;
    void onSearch(clean);
  }

  return (
    <div
      className={`rounded-2xl border border-gray-200 bg-white p-3 shadow-sm ${className}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-gray-900">
          Search Photo Online
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-red-500 hover:text-black"
        >
          Close
        </button>
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitSearch();
            }
          }}
          placeholder="Search image..."
          className="h-10 min-w-0 flex-1 rounded-xl border border-gray-300 px-3 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
        />
        <button
          type="button"
          onClick={submitSearch}
          disabled={searching || !query.trim()}
          className="h-10 rounded-xl bg-black px-3 text-[11px] font-medium text-white disabled:opacity-40"
        >
          {searching ? "..." : "Search"}
        </button>
      </div>

      {searching ? (
        <div className="mt-3 text-[11px] text-gray-500">
          Searching images...
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {results.map((image, index) => {
            const imageUrl =
              image.original || image.image || image.thumbnail;
            const thumbnail = image.thumbnail || imageUrl;
            if (!imageUrl || !thumbnail) return null;

            return (
              <button
                key={`${imageUrl}-${index}`}
                type="button"
                onClick={() => void onSelect(image)}
                className="overflow-hidden rounded-xl border border-gray-200 hover:border-black"
                title={image.title || "Select photo"}
              >
                <img
                  src={thumbnail}
                  alt={image.title || "Online image"}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full object-cover"
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
