import jsPDF from "jspdf";

export async function getImageDataUrl(src?: string | null) {
  if (!src) return null;

  try {
    const res = await fetch(src);
    const blob = await res.blob();

    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function addPdfTopHeader(pdf: jsPDF) {
  const logo = await getImageDataUrl("/logo-icon.png");

  if (logo) {
    pdf.addImage(logo, "PNG", 14, 8, 28, 28);
  }

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.setTextColor(17, 24, 39);
  pdf.text("Hilights Equipment Management System", 50, 16);

  pdf.setFontSize(22);
  pdf.setTextColor(239, 68, 68);
  pdf.text("Equipment Report", 50, 28);

  pdf.setDrawColor(239, 68, 68);
  pdf.setLineWidth(0.6);
  pdf.line(14, 42, 283, 42);

  pdf.setFontSize(9);
  pdf.setTextColor(55, 65, 81);
  pdf.text(`Generated: ${new Date().toLocaleDateString()}`, 230, 14);
  pdf.text("Version: 1.0", 230, 22);
}

export async function addProductHero({
  pdf,
  title,
  category,
  photoUrl,
}: {
  pdf: jsPDF;
  title: string;
  category: string;
  photoUrl?: string | null;
}) {
  const y = 50;

  pdf.setDrawColor(229, 231, 235);
  pdf.roundedRect(14, y, 269, 55, 3, 3);

  const photo = await getImageDataUrl(photoUrl);

  if (photo) {
    pdf.addImage(photo, "PNG", 20, y + 6, 45, 43, undefined, "FAST");
  } else {
    pdf.setTextColor(156, 163, 175);
    pdf.setFontSize(9);
    pdf.text("No photo", 33, y + 30);
  }

  pdf.setDrawColor(239, 68, 68);
  pdf.line(75, y + 8, 75, y + 47);

  pdf.setFont("helvetica", "bold");
  pdf.setTextColor(17, 24, 39);
  pdf.setFontSize(20);
  pdf.text(title, 84, y + 18);

  pdf.setFillColor(239, 68, 68);
  pdf.roundedRect(84, y + 25, 50, 8, 2, 2, "F");

  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(8);
  pdf.text(category.toUpperCase(), 88, y + 30.5);

  pdf.setTextColor(55, 65, 81);
  pdf.setFontSize(10);
  pdf.setFont("helvetica", "normal");
  pdf.text(`Category: ${category}`, 84, y + 43);
}

export function addSummaryCards({
  pdf,
  stats,
  startY = 112,
}: {
  pdf: jsPDF;
  stats: {
    total: number;
    available: number;
    inUse?: number;
    inuse?: number;
    maintenance: number;
    inKsa?: number;
    ksa?: number;
    expired?: number;
  };
  startY?: number;
}) {
  const cards = [
    ["Total", stats.total],
    ["Available", stats.available],
    ["In Use", stats.inUse ?? stats.inuse ?? 0],
    ["Maintenance", stats.maintenance],
    ["In KSA", stats.inKsa ?? stats.ksa ?? 0],
  ];

  const w = 50;
  const gap = 4;

  cards.forEach(([label, value], i) => {
    const x = 14 + i * (w + gap);

    pdf.setDrawColor(229, 231, 235);
    pdf.roundedRect(x, startY, w, 20, 3, 3);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(55, 65, 81);
    pdf.text(String(label), x + 5, startY + 7);

    pdf.setFontSize(16);
    pdf.setTextColor(17, 24, 39);
    pdf.text(String(value), x + 5, startY + 16);
  });
}

export function addFooter(pdf: jsPDF) {
  const pageCount = pdf.getNumberOfPages();

  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);

    pdf.setDrawColor(239, 68, 68);
    pdf.line(14, 198, 283, 198);

    pdf.setFontSize(8);
    pdf.setTextColor(75, 85, 99);
    pdf.text("Hilights Equipment Management System (HEMS)", 14, 204);
    pdf.text(`Page ${i} / ${pageCount}`, 260, 204);
  }
}