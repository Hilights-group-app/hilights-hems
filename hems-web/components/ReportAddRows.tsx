"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { MAX_REPORT_ROW_BATCH, reportRowCount } from "@/lib/reportRowBatch";

export default function ReportAddRows({ onAdd, disabled = false }: {
  onAdd: (count: number) => Promise<number>;
  disabled?: boolean;
}) {
  const id = useId();
  const busy = useRef(false);
  const [count, setCount] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || busy.current) return;
    setError(""); setMessage("");
    let quantity: number;
    try { quantity = reportRowCount(count); }
    catch (validationError) { setError((validationError as Error).message); return; }
    busy.current = true; setSaving(true);
    try {
      const added = await onAdd(quantity);
      setCount("1");
      setMessage(`${added} row${added === 1 ? "" : "s"} added. Serial numbers are blank.`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Rows could not be added. Please try again.");
    } finally { busy.current = false; setSaving(false); }
  }
  return <form onSubmit={event => void submit(event)} className="mt-8 space-y-2 pb-4" aria-label="Add report rows">
    <div className="flex flex-wrap items-end gap-2">
      <label className="block" htmlFor={id}>
        <span className="mb-1 block text-[9px] font-semibold text-gray-500">Number of rows</span>
        <input id={id} type="text" inputMode="numeric" pattern="[0-9]*" value={count}
          disabled={disabled || saving} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={Boolean(error)}
          onChange={event => { setCount(event.target.value); setError(""); setMessage(""); }}
          className="h-9 w-20 rounded-lg border border-gray-300 bg-white px-2.5 text-xs text-gray-900 outline-none focus:border-red-400 disabled:opacity-50" />
      </label>
      <button type="submit" disabled={disabled || saving}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-40">
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        {saving ? "Adding…" : count.trim() === "1" ? "Add Row" : "Add Rows"}
      </button>
    </div>
    <p id={`${id}-hint`} className="text-[9px] text-gray-400">1–{MAX_REPORT_ROW_BATCH} rows per batch.</p>
    {error ? <p id={`${id}-error`} role="alert" className="text-[10px] text-red-600">{error}</p> : null}
    {message ? <p role="status" className="text-[10px] text-green-700">{message}</p> : null}
  </form>;
}
