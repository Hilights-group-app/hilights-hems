"use client";

import { useEffect, useId, useRef, useState } from "react";
import { commonTestingDate, testingDateSummary } from "@/lib/reportTestingDate";

export default function ReportTestingDate({ values, editable, count, onSave }: {
  values: Array<string | null | undefined>;
  editable: boolean;
  count: number;
  onSave: (date: string) => Promise<void>;
}) {
  const id = useId();
  const saved = commonTestingDate(values);
  const [date, setDate] = useState(saved);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => { setDate(saved); setMessage(""); }, [saved]);

  async function save() {
    if (!editable || busy.current || !date || date === saved || count === 0) return;
    busy.current = true;
    setSaving(true); setMessage(""); setFailed(false);
    try {
      await onSave(date);
      setMessage("Testing date saved for all items in this report.");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Testing date could not be saved.");
    } finally { busy.current = false; setSaving(false); }
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5" data-report-testing-date>
      <label htmlFor={id} className="text-[11px] font-semibold text-gray-700">Testing date</label>
      {editable ? <>
        <input id={id} type="date" value={date} disabled={saving || count === 0}
          onChange={event => { setDate(event.target.value); setMessage(""); }}
          className="h-9 min-w-0 rounded-lg border border-gray-300 bg-white px-2 text-[11px] text-gray-900" />
        <button type="button" onClick={() => void save()} disabled={saving || !date || date === saved || count === 0}
          className="h-9 rounded-lg bg-gray-900 px-3 text-[10px] font-semibold text-white disabled:opacity-40">
          {saving ? "Saving…" : "Apply to all"}
        </button>
        <span className="text-[9px] text-gray-500">All {count} items in this report</span>
      </> : <span className="text-[11px] text-gray-800">{testingDateSummary(values)}</span>}
      {editable && !saved && values.some(Boolean) && !message ? <span className="w-full text-[9px] text-gray-500">Previous dates differ. Applying a date replaces them for this report only.</span> : null}
      {message ? <span role={failed ? "alert" : "status"} className={`w-full text-[10px] ${failed ? "text-red-600" : "text-green-700"}`}>{message}</span> : null}
    </div>
  );
}
