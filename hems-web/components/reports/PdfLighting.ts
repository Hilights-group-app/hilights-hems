import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  addFooter,
  addPdfTopHeader,
  addProductHero,
  addSummaryCards,
} from "./PdfHeader";

export type PdfUnit = {
  unit_no?: string | number | null;
  serial?: string | null;
  status?: string | null;
  notes?: string | null;
  testing_date?: string | null;
};

export type PdfStats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

export async function generateLightingPdf({
  title,
  category,
  photoUrl,
  stats,
  units,
}: {
  title: string;
  category: string;
  photoUrl?: string | null;
  stats: PdfStats;
  units: PdfUnit[];
}) {
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  await addPdfTopHeader(pdf);
  await addProductHero({ pdf, title, category, photoUrl });
  addSummaryCards({ pdf, stats, startY: 112 });

  autoTable(pdf, {
    startY: 142,
    theme: "striped",
    head: [["Unit", "Serial", "Status", "Test Date", "Notes"]],
    body: units.map((u) => [
      u.unit_no ?? "-",
      u.serial ?? "-",
      statusLabel(u.status),
      u.testing_date ?? "-",
      u.notes ?? "-",
    ]),
    styles: {
      fontSize: 7.5,
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
    margin: {
      top: 18,
      bottom: 20,
      left: 14,
      right: 14,
    },
    columnStyles: {
      0: { cellWidth: 25 },
      1: { cellWidth: 38 },
      2: { cellWidth: 35 },
      3: { cellWidth: 35 },
      4: { cellWidth: 65 },
    },
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