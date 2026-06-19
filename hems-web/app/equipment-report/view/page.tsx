"use client";

import Link from "next/link";

const reportTypes = [
  { title: "Lighting", href: "/equipment-report/view/lighting" },
  { title: "Projectors", href: "/equipment-report/view/projectors" },
  { title: "LED Screen", href: "/equipment-report/view/led-screen" },
  { title: "Chain Hoist", href: "/equipment-report/view/chain-hoist" },
  { title: "Cables", href: "/equipment-report/view/cables" },
  { title: "Power", href: "/equipment-report/view/power" },
  { title: "Truss & Rigging", href: "/equipment-report/view/truss-rigging" },
];

export default function ViewReportPage() {
  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="mx-auto max-w-[1100px] space-y-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            <h1 className="text-[26px] font-bold leading-tight text-gray-900">
              View Report
            </h1>
          </div>

          <p className="mt-2 text-[12px] text-gray-600">
            Select equipment type to preview report before downloading PDF.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {reportTypes.map((item) => (
            <Link
              key={item.title}
              href={item.href}
              className="rounded-2xl border border-gray-200 bg-white p-6 text-gray-900 transition-all duration-150 hover:border-red-200 hover:bg-red-50 active:scale-[0.98]"
            >
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                <h2 className="text-[17px] font-semibold leading-none">
                  {item.title}
                </h2>
              </div>

              <p className="mt-2 text-[12px] text-gray-600">
                Open {item.title} report preview.
              </p>

              <div className="mt-6 rounded-full border border-gray-300 bg-white px-3 py-2 text-center text-[11px] font-medium text-gray-700">
                Open Report
              </div>
            </Link>
          ))}
        </div>

        <Link
          href="/equipment-report"
          className="inline-block rounded-full border border-gray-300 bg-white px-3 py-2 text-[11px] font-medium text-gray-700 hover:bg-red-50 hover:border-red-200 hover:text-red-700"
        >
          ← Back
        </Link>
      </div>
    </div>
  );
}