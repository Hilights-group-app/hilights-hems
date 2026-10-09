"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { isAdmin } from "@/lib/authStore";
import AccountManagementClient from "@/components/AccountManagementClient";

export default function SettingsAccountsPage() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    setOk(isAdmin());
  }, []);

  if (ok === null) {
    return (
      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        Loading...
      </div>
    );
  }

  if (!ok) {
    return (
      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <h1 className="text-xl font-bold">Access denied</h1>
        <p className="mt-2 text-sm text-gray-600">
          You must be admin to access this page.
        </p>

        <div className="mt-4 flex gap-2">
          <Link
            href="/login"
            className="px-5 py-2 rounded-full bg-black text-white text-sm font-medium hover:opacity-90"
          >
            Login
          </Link>

          <Link
            href="/settings"
            className="px-5 py-2 rounded-full border text-sm font-medium hover:bg-gray-50"
          >
            Back to Settings
          </Link>
        </div>
      </div>
    );
  }

  return <AccountManagementClient />;
}