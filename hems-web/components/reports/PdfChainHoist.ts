import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  addFooter,
  addPdfTopHeader,
  addProductHero,
  addSummaryCards,
} from "./PdfHeader";

export type PdfChainStats = {
  total: number;
  available: number;
  inuse: number;
  maintenance: number;
  ksa: number;
  expired: number;
};

export type PdfChainUnit = {
  unit_no?: string | number | null;
  serial?: string | null;
  status?: string | null;
  cert_date?: string | null;
  expiry_date?: string | null;
  notes?: string | null;
};

export async function generateChainHoistPdf({
  title,
  photoUrl,
  stats,
  units,
}: {
  title: string;
  photoUrl?: string | null;
  stats: PdfChainStats;
  units: PdfChainUnit[];
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
    category: "Chain Hoist",
    photoUrl,
  });

  addSummaryCards({ pdf, stats, startY: 112 });

  autoTable(pdf, {
    startY: 140,
    theme: "striped",
    head: [["Unit", "Serial", "Status", "Cert Date", "Expiry Date", "Notes"]],
    body: units.map((u) => [
      u.unit_no ?? "-",
      u.serial ?? "-",
      statusLabel(u.status),
      u.cert_date ?? "-",
      u.expiry_date ?? "-",
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
      3: { cellWidth: 35 },
      4: { cellWidth: 35 },
      5: { cellWidth: 108 },
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
