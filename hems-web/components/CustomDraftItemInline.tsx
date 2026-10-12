"use client";

import { useEffect, useRef, useState } from "react";

type Text = { name: string; notes: string };
export default function CustomDraftItemInline({ name, notes, disabled, onSave }: Text & {
  disabled: boolean;
  onSave: (value: Text) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Text>({ name, notes });
  const draftRef = useRef(draft);
  const saved = useRef<Text>({ name, notes });
  const pending = useRef<Text | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  useEffect(() => {
    const old = saved.current;
    const current = draftRef.current;
    const next = {
      name: current.name === old.name ? name : current.name,
      notes: current.notes === old.notes ? notes : current.notes,
    };
    saved.current = { name, notes };
    draftRef.current = next;
    setDraft(next);
  }, [name, notes]);
  function change(key: keyof Text, value: string) {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    setError("");
  }
  async function save() {
    const value = { name: draftRef.current.name.trim(), notes: draftRef.current.notes.trim() };
    if (disabled) return;
    if (!value.name) { setError("Enter an item name."); return; }
    pending.current = value;
    if (running.current) return;
    running.current = true;
    setSaving(true);
    try {
      while (pending.current && mounted.current) {
        const next = pending.current;
        pending.current = null;
        if (next.name === saved.current.name && next.notes === saved.current.notes) continue;
        await onSave(next);
        if (!mounted.current) return;
        saved.current = next;
        setError("");
      }
    } catch (saveError: any) {
      if (mounted.current) setError(saveError?.message || "Could not save. Tap the text and try again.");
      pending.current = null;
    } finally {
      running.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function cancel() {
    pending.current = null;
    draftRef.current = saved.current;
    setDraft(saved.current);
    setError("");
  }
  return <div className="min-w-0">
    <input aria-label="Custom item name" value={draft.name} disabled={disabled}
      onChange={(event) => change("name", event.target.value)} onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
      }}
      className="w-full min-w-0 rounded border border-transparent bg-transparent px-0.5 text-[12px] font-semibold text-gray-900 outline-none hover:border-gray-200 focus:border-gray-300 focus:bg-white focus:text-base sm:text-[13px] sm:focus:text-[13px]" />
    <textarea aria-label="Custom item note" rows={1} value={draft.notes} placeholder="Add a note…" disabled={disabled}
      onChange={(event) => { change("notes", event.target.value); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
      }}
      ref={(element) => { if (element) { element.style.height = "auto"; element.style.height = `${element.scrollHeight}px`; } }}
      className="mt-0.5 block w-full min-w-0 resize-none overflow-hidden rounded border border-transparent bg-transparent px-0.5 text-[9px] leading-4 text-gray-500 outline-none hover:border-gray-200 focus:border-gray-300 focus:bg-white focus:text-base sm:focus:text-[9px]" />
    {saving ? <span role="status" className="sr-only">Saving custom item</span> : null}
    {error ? <div role="alert" className="mt-1 text-[10px] text-red-600">{error}</div> : null}
  </div>;
}
