"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { setUserDepartment, setUserName, setUserRole } from "@/lib/authStore";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);

    try {
      const supabase = createClient();
      const cleanEmail = email.trim().toLowerCase();

      const { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });

      if (error) {
        setErr(error.message);
        return;
      }

      const userId = data.user?.id;
      if (!userId) {
        setErr("User not found after login.");
        return;
      }

      const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("full_name, role, department")
        .eq("id", userId)
        .maybeSingle();

      if (profileErr) {
        setErr(profileErr.message);
        return;
      }

      if (!profile) {
        setErr("No profile found for this user.");
        return;
      }

      setUserRole(profile.role ?? "viewer");
      setUserName(profile.full_name ?? "");
      setUserDepartment(profile.department ?? "");

      router.replace("/");
      router.refresh();
    } catch (error: any) {
      setErr(error?.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <h1 className="text-2xl font-bold">Login</h1>
        <p className="text-sm text-gray-600 mt-1">
          Sign in with your account.
        </p>

        <form onSubmit={onLogin} className="space-y-4 mt-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-black"
              placeholder="Enter your email"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-black"
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </div>

          {err && <div className="text-sm text-red-600">{err}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full px-5 py-2 rounded-full bg-black text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Login"}
          </button>
        </form>

        <div className="mt-4">
          <Link href="/" className="text-sm text-gray-600 hover:text-black">
            Back Home
          </Link>
        </div>
      </div>
    </div>
  );
}