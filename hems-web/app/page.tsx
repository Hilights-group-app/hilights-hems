"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getUserName,
  canAccessReports,
  canAccessSettings,
} from "@/lib/authStore";

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [canReports, setCanReports] = useState(false);
  const [canSettings, setCanSettings] = useState(false);

  useEffect(() => {
    setMounted(true);
    setName(getUserName());
    setCanReports(canAccessReports());
    setCanSettings(canAccessSettings());
  }, []);

  function onSoon(label: string) {
    alert(`${label} page coming soon`);
  }

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

            {mounted && canReports && (
              <Link
                href="/equipment-report"
                className="
                  rounded-full border border-gray-300 px-4 py-3
                  text-center text-sm font-medium text-gray-700
                  transition-all
                  hover:border-red-200
                  hover:bg-red-50
                  hover:text-red-700
                  active:scale-[0.98]
                "
              >
                Equipment Report
              </Link>
            )}

            <button
              type="button"
              onClick={() => onSoon("Shipment")}
              className="
                rounded-full border border-gray-300 bg-white px-4 py-3
                text-center text-sm font-medium text-gray-700
                transition-all
                hover:border-red-200
                hover:bg-red-50
                hover:text-red-700
                active:scale-[0.98]
              "
            >
              Shipment
            </button>

            <button
              type="button"
              onClick={() => onSoon("Maintenance")}
              className="
                rounded-full border border-gray-300 bg-white px-4 py-3
                text-center text-sm font-medium text-gray-700
                transition-all
                hover:border-red-200
                hover:bg-red-50
                hover:text-red-700
                active:scale-[0.98]
              "
            >
              Maintenance
            </button>

            {mounted && canSettings && (
              <Link
                href="/settings"
                className="
                  rounded-full border border-gray-300 px-4 py-3
                  text-center text-sm font-medium text-gray-700
                  transition-all
                  hover:border-red-200
                  hover:bg-red-50
                  hover:text-red-700
                  active:scale-[0.98]
                "
              >
                Settings
              </Link>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}