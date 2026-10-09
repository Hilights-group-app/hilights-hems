"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";
type Department = "" | "lighting" | "video" | "rigging";

type ManagedUser = {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  department: Department | "";
  avatar_url?: string | null;
  created_at: string;
};

async function safeJsonResponse(res: Response) {
  const text = await res.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    console.error("Non-JSON response:", text);
    throw new Error("Session expired or server returned invalid response. Please login again.");
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function roleLabel(role: UserRole, department?: Department | "") {
  if (role === "admin") return "Admin";
  if (role === "warehouse_manager") return "Warehouse Manager";
  if (role === "viewer") return "Viewer";
  if (role === "head") {
    if (department === "lighting") return "Head of Lighting";
    if (department === "video") return "Head of Video";
    if (department === "rigging") return "Head of Rigging";
    return "Head";
  }
  return role;
}

export default function AccountManagementClient() {
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [department, setDepartment] = useState<Department>("");
  const [avatarUrl, setAvatarUrl] = useState("");

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadUsers() {
    setLoadingUsers(true);
    setErr(null);

    try {
      const res = await fetch("/api/admin/users", {
        method: "GET",
        cache: "no-store",
        credentials: "include",
      });

      const json = await safeJsonResponse(res);

      if (!res.ok) {
        setErr(json?.error || "Failed to load users.");
        setUsers([]);
        return;
      }

      setUsers(json?.users || []);
    } catch (e: any) {
      setErr(e?.message || "Failed to load users.");
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function updateLocalUser(id: string, patch: Partial<ManagedUser>) {
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }

  async function onPickCreateAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const dataUrl = await fileToDataUrl(file);
      setAvatarUrl(dataUrl);
    } catch {
      setErr("Failed to read image.");
    } finally {
      e.target.value = "";
    }
  }

  async function updateUserAvatar(userId: string, file: File | null) {
    if (!file) return;

    try {
      const dataUrl = await fileToDataUrl(file);
      updateLocalUser(userId, { avatar_url: dataUrl });
      setMsg("Photo selected. Click Save to update user.");
      setErr(null);
    } catch {
      setErr("Failed to read image.");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setMsg(null);
    setErr(null);

    try {
      const res = await fetch("/api/admin/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          full_name: fullName,
          email,
          password,
          role,
          department: role === "head" ? department : "",
          avatar_url: avatarUrl,
        }),
      });

      const json = await safeJsonResponse(res);

      if (!res.ok) {
        setErr(json?.error || "Failed to create user.");
        return;
      }

      setMsg("User created successfully.");
      setFullName("");
      setEmail("");
      setPassword("");
      setRole("viewer");
      setDepartment("");
      setAvatarUrl("");

      await loadUsers();
    } catch (e: any) {
      setErr(e?.message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveUser(user: ManagedUser) {
    setSavingId(user.id);
    setErr(null);
    setMsg(null);

    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id: user.id,
          full_name: user.full_name,
          role: user.role,
          department: user.role === "head" ? user.department : "",
          avatar_url: user.avatar_url || "",
        }),
      });

      const json = await safeJsonResponse(res);

      if (!res.ok) {
        setErr(json?.error || "Failed to update user.");
        return;
      }

      setMsg("User updated successfully.");
      await loadUsers();
    } catch (e: any) {
      setErr(e?.message || "Failed to update user.");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteUser(id: string) {
    if (!confirm("Delete this account?")) return;

    setDeletingId(id);
    setErr(null);
    setMsg(null);

    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const json = await safeJsonResponse(res);

      if (!res.ok) {
        setErr(json?.error || "Failed to delete user.");
        return;
      }

      setMsg("User deleted successfully.");
      await loadUsers();
    } catch (e: any) {
      setErr(e?.message || "Failed to delete user.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Account Management</h1>
            <p className="text-sm text-gray-600 mt-1">
              Create users and manage roles, departments and photos.
            </p>
          </div>

          <Link
            href="/settings"
            className="px-4 py-2 rounded-full border text-sm font-medium hover:bg-gray-50"
          >
            Back
          </Link>
        </div>
      </div>

      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <h2 className="text-sm font-bold text-gray-900 mb-4">Create User</h2>

        <form onSubmit={onSubmit} className="space-y-4 max-w-2xl">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickCreateAvatar}
          />

          <div className="flex items-center gap-4 rounded-2xl border border-gray-100 bg-gray-50 p-3">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="h-16 w-16 overflow-hidden rounded-full bg-white border shadow-sm flex items-center justify-center text-sm font-bold text-gray-700 hover:ring-2 hover:ring-black/10 transition"
              title="Upload user photo"
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="Avatar" className="h-full w-full object-cover" />
              ) : (
                initials(fullName || "User")
              )}
            </button>

            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900">User Photo</div>
              <div className="text-xs text-gray-500 mt-1">
                Tap the circle to upload profile photo.
              </div>

              {avatarUrl ? (
                <button
                  type="button"
                  onClick={() => setAvatarUrl("")}
                  className="mt-2 text-xs text-red-500 hover:text-black"
                >
                  Remove photo
                </button>
              ) : null}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full Name
            </label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Ahmed Ali"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="e.g. ahmed@company.com"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-black"
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
              placeholder="Enter temporary password"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => {
                  const nextRole = e.target.value as UserRole;
                  setRole(nextRole);
                  if (nextRole !== "head") setDepartment("");
                }}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 bg-white outline-none focus:ring-2 focus:ring-black"
              >
                <option value="admin">Admin</option>
                <option value="warehouse_manager">Warehouse Manager</option>
                <option value="viewer">Viewer</option>
                <option value="head">Head</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Department
              </label>
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value as Department)}
                disabled={role !== "head"}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 bg-white outline-none focus:ring-2 focus:ring-black disabled:bg-gray-50"
              >
                <option value="">None</option>
                <option value="lighting">Lighting</option>
                <option value="video">Video</option>
                <option value="rigging">Rigging</option>
              </select>
            </div>
          </div>

          {msg && <div className="text-sm text-green-600">{msg}</div>}
          {err && <div className="text-sm text-red-600">{err}</div>}

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-full bg-black text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create User"}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white border rounded-2xl p-6 text-gray-900">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-bold text-gray-900">Existing Accounts</h2>

          <button
            type="button"
            onClick={loadUsers}
            className="px-4 py-2 rounded-full border text-sm font-medium hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {loadingUsers ? (
          <div className="text-sm text-gray-600">Loading accounts...</div>
        ) : users.length === 0 ? (
          <div className="text-sm text-gray-600">No accounts found.</div>
        ) : (
          <div className="space-y-3">
            {users.map((user) => (
              <div key={user.id} className="border rounded-2xl p-4">
                <input
                  id={`avatar-${user.id}`}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    void updateUserAvatar(user.id, e.target.files?.[0] || null);
                    e.target.value = "";
                  }}
                />

                <div className="flex items-center gap-3 mb-4">
                  <button
                    type="button"
                    onClick={() => document.getElementById(`avatar-${user.id}`)?.click()}
                    className="h-12 w-12 rounded-full overflow-hidden bg-gray-100 border flex items-center justify-center text-sm font-bold text-gray-700 shrink-0 hover:ring-2 hover:ring-black/20 transition"
                    title="Change photo"
                  >
                    {user.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt={user.full_name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      initials(user.full_name || "User")
                    )}
                  </button>

                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">
                      {user.full_name || "Unnamed User"}
                    </div>
                    <div className="text-xs text-gray-500">
                      {roleLabel(user.role, user.department)}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      Click photo to change, then Save.
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-3">
                    <label className="block text-xs text-gray-500 mb-1">
                      Full Name
                    </label>
                    <input
                      value={user.full_name ?? ""}
                      onChange={(e) =>
                        updateLocalUser(user.id, { full_name: e.target.value })
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <label className="block text-xs text-gray-500 mb-1">
                      Email
                    </label>
                    <input
                      value={user.email}
                      readOnly
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-gray-50 text-gray-600"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">
                      Role
                    </label>
                    <select
                      value={user.role}
                      onChange={(e) => {
                        const nextRole = e.target.value as UserRole;
                        updateLocalUser(user.id, {
                          role: nextRole,
                          department: nextRole === "head" ? user.department : "",
                        });
                      }}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 bg-white text-sm outline-none focus:ring-2 focus:ring-black"
                    >
                      <option value="admin">Admin</option>
                      <option value="warehouse_manager">Warehouse Manager</option>
                      <option value="viewer">Viewer</option>
                      <option value="head">Head</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">
                      Department
                    </label>
                    <select
                      value={user.department ?? ""}
                      disabled={user.role !== "head"}
                      onChange={(e) =>
                        updateLocalUser(user.id, {
                          department: e.target.value as Department,
                        })
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 bg-white text-sm outline-none focus:ring-2 focus:ring-black disabled:bg-gray-50"
                    >
                      <option value="">None</option>
                      <option value="lighting">Lighting</option>
                      <option value="video">Video</option>
                      <option value="rigging">Rigging</option>
                    </select>
                  </div>

                  <div className="md:col-span-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => saveUser(user)}
                      disabled={savingId === user.id}
                      className="flex-1 px-4 py-2 rounded-full bg-black text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
                    >
                      {savingId === user.id ? "Saving..." : "Save"}
                    </button>

                    <button
                      type="button"
                      onClick={() => deleteUser(user.id)}
                      disabled={deletingId === user.id}
                      className="flex-1 px-4 py-2 rounded-full border text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                    >
                      {deletingId === user.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>

                <div className="mt-2 text-xs text-gray-500">
                  Created:{" "}
                  {user.created_at
                    ? new Date(user.created_at).toLocaleString()
                    : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}