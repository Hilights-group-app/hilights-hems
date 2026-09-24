import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  addFooter,
  addPdfTopHeader,
  addProductHero,
  addSummaryCards,
} from "./PdfHeader";
import type { PdfStats } from "./PdfLighting";

export type PdfLedIssue = {
  problem_type?: string | null;
  qty?: number | null;
  team_name?: string | null;
  event_name?: string | null;
  event_date?: string | null;
  note?: string | null;
};

export async function generateLedScreenPdf({
  title,
  cabinetSize,
  photoUrl,
  stats,
  issues,
}: {
  title: string;
  cabinetSize: string;
  photoUrl?: string | null;
  stats: PdfStats;
  issues: PdfLedIssue[];
}) {
  const pdf = new jsPDF({
  orientation: "portrait",
  unit: "mm",
  format: "a4",
});

  await addPdfTopHeader(pdf);
  await addProductHero({
    pdf,
    title,
    category: `LED Screen / ${cabinetSize}`,
    photoUrl,
  });

  addSummaryCards({ pdf, stats, startY: 112 });

  autoTable(pdf, {
    startY: 140,
    theme: "striped",
    head: [["Problem", "Qty", "Team", "Event", "Date", "Note"]],
    body:
      issues.length > 0
        ? issues.map((i) => [
            formatProblem(i.problem_type),
            i.qty ?? 0,
            i.team_name ?? "-",
            i.event_name ?? "-",
            i.event_date ?? "-",
            i.note ?? "-",
          ])
        : [["No issues found", "-", "-", "-", "-", "-"]],
    styles: {
      fontSize: 8,
      cellPadding: 2,
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: [239, 68, 68],
      textColor: [255, 255, 255],
      fontStyle: "bold",
    },
    alternateRowStyles: {
      fillColor: [245, 245, 245],
    },
    columnStyles: {
      0: { cellWidth: 48 },
      1: { cellWidth: 20 },
      2: { cellWidth: 42 },
      3: { cellWidth: 55 },
      4: { cellWidth: 32 },
      5: { cellWidth: 90 },
    },
    margin: { left: 14, right: 14 },
  });

  addFooter(pdf);
  pdf.save(`${safeName(title)}_${safeName(cabinetSize)}.pdf`);
}

function formatProblem(value?: string | null) {
  if (!value) return "-";
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeName(name: string) {
  return name.replace(/[^\w\-]+/g, "_");
}
