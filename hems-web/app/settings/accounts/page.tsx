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
      <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 text-gray-900 text-sm">
        Loading settings…
      </div>
    );
  }

  if (!ok) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 text-gray-900 text-sm">
        <h1 className="text-base font-semibold">Access denied</h1>
        <p className="mt-2 text-sm text-gray-600">
          You must be admin to access this page.
        </p>

        <div className="mt-4 flex gap-2">
          <Link
            href="/login"
            className="min-h-11 inline-flex items-center justify-center px-4 py-2 rounded-full bg-black text-white text-sm font-medium hover:opacity-90"
          >
            Login
          </Link>

          <Link
            href="/settings"
            className="min-h-11 inline-flex items-center justify-center px-4 py-2 rounded-full border text-sm font-medium hover:bg-gray-50"
          >
            Back to Settings
          </Link>
        </div>
      </div>
    );
  }

  return <AccountManagementClient />;
}