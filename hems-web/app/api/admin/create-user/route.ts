import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";
type Department = "" | "lighting" | "video" | "rigging";

async function requireAdmin() {
  const supabase = await createServerSupabase();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "Unauthorized", status: 401 as const };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== "admin") {
    return { error: "Forbidden", status: 403 as const };
  }

  return { userId: user.id };
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("error" in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const body = await req.json();

    const full_name = String(body?.full_name ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const role = String(body?.role ?? "") as UserRole;
    const departmentRaw = String(body?.department ?? "") as Department;

    if (!full_name) {
      return NextResponse.json({ error: "Full name is required." }, { status: 400 });
    }

    if (!email) {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }

    if (!password || password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    if (!["admin", "warehouse_manager", "viewer", "head"].includes(role)) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    const department =
      role === "head" && ["lighting", "video", "rigging"].includes(departmentRaw)
        ? departmentRaw
        : "";

    const { data: createdUser, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (createError || !createdUser.user) {
      return NextResponse.json(
        { error: createError?.message || "Failed to create auth user." },
        { status: 500 }
      );
    }

    const { error: profileError } = await supabaseAdmin.from("profiles").insert({
      id: createdUser.user.id,
      full_name,
      role,
      department: department || null,
    });

    if (profileError) {
      await supabaseAdmin.auth.admin.deleteUser(createdUser.user.id);

      return NextResponse.json(
        { error: profileError.message || "Failed to create profile." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      user: {
        id: createdUser.user.id,
        email: createdUser.user.email ?? email,
        full_name,
        role,
        department: department || "",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to create user." },
      { status: 500 }
    );
  }
}