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

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const { data: authData, error: authListError } =
      await supabaseAdmin.auth.admin.listUsers();

    if (authListError) {
      console.error("listUsers error:", authListError);
      return NextResponse.json(
        { error: authListError.message || "Failed to list auth users." },
        { status: 500 }
      );
    }

    const authUsers = authData?.users ?? [];
    const ids = authUsers.map((u) => u.id);

    if (ids.length === 0) {
      return NextResponse.json({ users: [] });
    }

    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, role, department")
      .in("id", ids);

    if (profilesError) {
      console.error("profiles fetch error:", profilesError);
      return NextResponse.json(
        { error: profilesError.message || "Failed to load profiles." },
        { status: 500 }
      );
    }

    const profileMap = new Map(
      (profiles ?? []).map((p: any) => [p.id, p])
    );

    const users = authUsers
      .map((u) => {
        const p: any = profileMap.get(u.id);

        return {
          id: u.id,
          email: u.email ?? "",
          created_at: u.created_at ?? "",
          full_name: p?.full_name ?? "",
          role: (p?.role ?? "viewer") as UserRole,
          department: (p?.department ?? "") as Department | "",
        };
      })
      .sort((a, b) => {
        const ad = new Date(a.created_at || 0).getTime();
        const bd = new Date(b.created_at || 0).getTime();
        return bd - ad;
      });

    return NextResponse.json({ users });
  } catch (error: any) {
    console.error("GET /api/admin/users fatal error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to load users." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if ("error" in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const body = await req.json();

    const id = String(body?.id ?? "");
    const full_name = String(body?.full_name ?? "").trim();
    const role = String(body?.role ?? "") as UserRole;
    const departmentRaw = String(body?.department ?? "") as Department;

    if (!id) {
      return NextResponse.json({ error: "Missing user id." }, { status: 400 });
    }

    if (!full_name) {
      return NextResponse.json({ error: "Full name is required." }, { status: 400 });
    }

    if (!["admin", "warehouse_manager", "viewer", "head"].includes(role)) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    const department =
      role === "head" && ["lighting", "video", "rigging"].includes(departmentRaw)
        ? departmentRaw
        : "";

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({
        full_name,
        role,
        department: department || null,
      })
      .eq("id", id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("PATCH /api/admin/users error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update user." },
      { status: 500 }
    );
  }
}