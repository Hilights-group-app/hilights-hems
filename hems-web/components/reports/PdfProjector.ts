import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  addFooter,
  addPdfTopHeader,
  addProductHero,
  addSummaryCards,
} from "./PdfHeader";
import type { PdfStats } from "./PdfLighting";

export type PdfProjectorUnit = {
  unit_no?: string | number | null;
  serial?: string | null;
  status?: string | null;
  lamp_hours?: number | null;
  notes?: string | null;
  testing_date?: string | null;
};

export async function generateProjectorPdf({
  title,
  photoUrl,
  stats,
  units,
}: {
  title: string;
  photoUrl?: string | null;
  stats: PdfStats;
  units: PdfProjectorUnit[];
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
    category: "Projectors",
    photoUrl,
  });

  addSummaryCards({ pdf, stats, startY: 112 });

  autoTable(pdf, {
    startY: 140,
    theme: "striped",
    head: [["Unit", "Serial", "Status", "Lamp Hours", "Test Date", "Notes"]],
    body: units.map((u) => [
      u.unit_no ?? "-",
      u.serial ?? "-",
      statusLabel(u.status),
      u.lamp_hours ?? 0,
      u.testing_date ?? "-",
      u.notes ?? "-",
    ]),
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
      0: { cellWidth: 24 },
      1: { cellWidth: 50 },
      2: { cellWidth: 35 },
      3: { cellWidth: 28 },
      4: { cellWidth: 35 },
      5: { cellWidth: 115 },
    },
    margin: { left: 14, right: 14 },
  });

  addFooter(pdf);
  pdf.save(`${safeName(title)}.pdf`);
}

function statusLabel(status?: string | null) {
  if (status === "in_use") return "In Use";
  if (status === "in_ksa") return "In KSA";
  if (status === "maintenance") return "Maintenance";
  return "Available";
}

function safeName(name: string) {
  return name.replace(/[^\w\-]+/g, "_");
}
