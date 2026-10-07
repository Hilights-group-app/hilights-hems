"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getUserName } from "@/lib/authStore";

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    setName(getUserName());
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="mx-auto w-full rounded-xl border border-gray-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] sm:p-5">
        {/* Header */}
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight text-gray-900 sm:text-xl">
            Equipment Management System
          </h1>

          <p className="mt-1 text-xs text-gray-600 sm:text-sm">
            {mounted && name
              ? `Welcome, ${name}.`
              : "Welcome to the system dashboard."}
          </p>
        </div>

        {/* Main card */}
        <div className="mt-5 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap">
            <Link
              href="/inventory"
              className="
                rounded-full bg-black px-4 py-3
                text-center text-sm font-medium text-white
                transition-all hover:opacity-90 active:scale-[0.98]
              "
            >
              Go to Inventory
            </Link>

          </div>
        </div>
      </div>
    </div>
  );
}
