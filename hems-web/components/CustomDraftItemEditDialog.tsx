"use client";

import { useEffect, useState } from "react";
import { Pencil, X } from "lucide-react";

export default function CustomDraftItemEditDialog({ name: initialName, notes: initialNotes, saving, error, onClose, onSave }: {
  name: string;
  notes: string;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (input: { name: string; notes: string }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [notes, setNotes] = useState(initialNotes);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, saving]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="custom-edit-title"
      className="fixed inset-0 z-[10030] flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label="Close custom item editor" onClick={onClose} disabled={saving}
        className="absolute inset-0 bg-black/50" />
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!saving && name.trim()) onSave({ name: name.trim(), notes: notes.trim() });
      }} className="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="flex items-center justify-between gap-3">
          <h2 id="custom-edit-title" className="flex items-center gap-2 text-base font-bold text-gray-900"><Pencil size={16} />Edit Custom Item</h2>
          <button type="button" aria-label="Close" disabled={saving} onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full bg-gray-100 text-gray-600 disabled:opacity-50"><X size={14} /></button>
        </div>
        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold text-gray-500">Item Name</span>
            <input autoFocus required disabled={saving} value={name} onChange={(event) => setName(event.target.value)}
              className="h-11 w-full rounded-xl border border-gray-300 px-3 text-base text-gray-900 outline-none focus:border-black disabled:bg-gray-100 sm:text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold text-gray-500">Note</span>
            <textarea rows={4} disabled={saving} value={notes} onChange={(event) => setNotes(event.target.value)}
              className="w-full resize-y rounded-xl border border-gray-300 p-3 text-base text-gray-900 outline-none focus:border-black disabled:bg-gray-100 sm:text-xs" />
          </label>
          {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={onClose} className="min-h-11 rounded-xl border border-gray-300 px-4 text-xs font-semibold text-gray-700 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving || !name.trim()} className="min-h-11 rounded-xl bg-black px-5 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
