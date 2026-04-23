"use client";

import Link from "next/link";

export default function SettingsClient() {
  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-gray-600 mt-1">
          Manage system configuration and administration pages.
        </p>
      </div>

      {/* SETTINGS CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/settings/catalog"
          className="bg-white border rounded-2xl p-6 text-gray-900 hover:bg-gray-50 transition"
        >
          <div className="text-lg font-semibold">Manage Categories & Subcategories</div>
          <div className="text-sm text-gray-500 mt-1">
            Create, rename, delete and manage inventory structure.
          </div>
        </Link>

        <Link
          href="/settings/accounts"
          className="bg-white border rounded-2xl p-6 text-gray-900 hover:bg-gray-50 transition"
        >
          <div className="text-lg font-semibold">Account Management</div>
          <div className="text-sm text-gray-500 mt-1">
            Create users and manage roles and permissions.
          </div>
        </Link>
      </div>
    </div>
  );
}