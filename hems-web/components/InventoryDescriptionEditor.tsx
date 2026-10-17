"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function InventoryDescriptionEditor({
  table,
  recordId,
  value,
  disabled = false,
  onSaved,
}: {
  table: "items" | "matrix_models";
  recordId: string;
  value?: string | null;
  disabled?: boolean;
  onSaved: (description: string | null) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDraft(value ?? "");
    setMessage("");
  }, [recordId, value]);

  const clean = draft.trim() || null;
  const original = value?.trim() || null;
  const changed = clean !== original;

  async function save() {
    if (disabled || saving || !changed) return;
    setSaving(true);
    setMessage("");
    const { error } = await supabase
      .from(table)
      .update({ description: clean })
      .eq("id", recordId);
    if (error) {
      console.error("description update error", error);
      setMessage(error.message || "Description could not be saved.");
      setSaving(false);
      return;
    }
    onSaved(clean);
    setMessage("Saved");
    setSaving(false);
    window.setTimeout(() => setMessage((current) => current === "Saved" ? "" : current), 1600);
  }

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 p-2.5">
      <label className="block text-[9px] font-bold uppercase tracking-wide text-gray-500">
        Description <span className="font-normal normal-case text-gray-400">(optional)</span>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={4}
          disabled={disabled || saving}
          placeholder={"One detail per line\ne.g. 6 x Socapex out\n2 x 32A 3ph out"}
          className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-gray-300 bg-white px-3 py-2 text-[10px] font-normal normal-case leading-5 text-gray-900 outline-none placeholder:text-gray-400 focus:border-black disabled:bg-gray-100"
        />
      </label>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={`text-[9px] ${message === "Saved" ? "text-green-700" : "text-red-600"}`}>
          {message}
        </span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={disabled || saving || !changed}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-gray-900 px-3 text-[9px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-35"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : null}
          {saving ? "Saving..." : "Save Description"}
        </button>
      </div>
    </div>
  );
}
