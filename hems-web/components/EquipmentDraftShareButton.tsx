"use client";

import { Loader2, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getUserId } from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import { canShareEquipmentDraft, EQUIPMENT_LISTS_EVENT, type EquipmentList } from "@/lib/equipmentLists";

type ShareUser = { id: string; full_name: string; role: string; department: string };

function userRoleLabel(user: ShareUser) {
  const department = user.department.charAt(0).toUpperCase() + user.department.slice(1);
  return user.role === "head" && department
    ? `Head of ${department}`
    : user.role.replace(/_/g, " ");
}

export default function EquipmentDraftShareButton({ list, onSaved }: {
  list: EquipmentList;
  onSaved: (userIds: string[]) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<ShareUser[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setUsersLoaded(false);
    setUsers([]);
    setError("");
    setSearch("");
    setSelected([]);
    async function loadUsers() {
      const result = await supabase.rpc("hems_draft_share_users", { p_list_id: list.id });
      if (cancelled) return;
      if (result.error) {
        setUsers([]);
        setError("Could not load users for this draft. Close and try again.");
      } else {
        const available = (result.data ?? []) as ShareUser[];
        const ids = new Set(available.map(user => user.id));
        setUsers(available);
        setUsersLoaded(true);
        setSelected((list.shared_with ?? []).filter(id => ids.has(id)));
      }
      setLoading(false);
    }
    void loadUsers().catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError("Could not load users for this draft. Close and try again.");
      }
    });
    return () => { cancelled = true; };
    // The modal takes a snapshot of recipients when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, list.id, supabase]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, saving]);

  async function saveSharing() {
    const userId = getUserId();
    if (!usersLoaded || loading || saving || !canShareEquipmentDraft(list, userId)) return;
    setSaving(true);
    setError("");
    try {
      const { data, error: saveError } = await supabase.from("equipment_lists")
        .update({ shared_with: Array.from(new Set(selected)), updated_at: new Date().toISOString() })
        .eq("id", list.id).eq("status", "draft").eq("created_by", userId!)
        .select("shared_with").maybeSingle();
      if (saveError || !data) throw saveError || new Error("This draft is no longer available for sharing.");
      onSaved(data.shared_with as string[]);
      window.dispatchEvent(new CustomEvent(EQUIPMENT_LISTS_EVENT, {
        detail: { listId: list.id, action: "sharing_updated" },
      }));
      setOpen(false);
    } catch (saveError: any) {
      setError(saveError?.message || "Could not save sharing. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const visibleUsers = users.filter(user =>
    `${user.full_name} ${userRoleLabel(user)}`.toLowerCase().includes(search.trim().toLowerCase()));

  return <>
    <button type="button" onClick={() => setOpen(true)}
      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[10px] font-semibold text-gray-700 hover:border-black">
      <Users size={13} /> Share draft{list.shared_with?.length ? ` (${list.shared_with.length})` : ""}
    </button>
    {open ? (
      <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-3" role="dialog" aria-modal="true" aria-labelledby="draft-share-title">
        <div className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
          <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-4">
            <div>
              <h2 id="draft-share-title" className="text-sm font-bold text-gray-900">Share draft {list.reference}</h2>
              <p className="mt-1 text-xs text-gray-500">Selected users can add and edit equipment. Only you can submit this draft.</p>
            </div>
            <button type="button" aria-label="Close draft sharing" disabled={saving} onClick={() => setOpen(false)} className="rounded-lg p-1 text-gray-500 disabled:opacity-40"><X size={18} /></button>
          </div>
          <div className="p-4 pb-2">
            <input aria-label="Search users" placeholder="Search name or department…" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-xs text-gray-900" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
            {loading ? <div className="py-6 text-center text-xs text-gray-500">Loading users…</div> : visibleUsers.length === 0 ? <div className="py-6 text-center text-xs text-gray-500">No matching users.</div> : visibleUsers.map(user => (
              <label key={user.id} className="mb-2 flex cursor-pointer items-center gap-3 rounded-xl border border-gray-200 px-3 py-3">
                <input type="checkbox" checked={selected.includes(user.id)} disabled={saving} onChange={event => {
                  const checked = event.target.checked;
                  setSelected(current => checked ? [...current, user.id] : current.filter(id => id !== user.id));
                }} className="h-4 w-4 accent-black" />
                <span><span className="block text-xs font-semibold text-gray-900">{user.full_name || "Unnamed user"}</span><span className="mt-0.5 block text-[10px] capitalize text-gray-500">{userRoleLabel(user)}</span></span>
              </label>
            ))}
          </div>
          <div className="border-t border-gray-200 p-4">
            {error ? <div role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</div> : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">{selected.length} selected</span>
              <button type="button" onClick={() => void saveSharing()} disabled={!usersLoaded || loading || saving} className="inline-flex items-center gap-2 rounded-xl bg-black px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />} {saving ? "Saving…" : "Save sharing"}
              </button>
            </div>
          </div>
        </div>
      </div>
    ) : null}
  </>;
}
