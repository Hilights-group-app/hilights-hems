import { ReactNode } from "react";

export default function SubcategoryHeader({
  title,
  right,
}: {
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6">
      <div className="flex justify-between items-start gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "9999px",
              backgroundColor: "#ef4444",
              flexShrink: 0,
            }}
          />

          <h1 className="text-lg sm:text-xl font-bold text-gray-900 truncate">
  {title}
</h1>
        </div>

        {right ? <div className="flex gap-2 shrink-0">{right}</div> : null}
      </div>
    </div>
  );
}