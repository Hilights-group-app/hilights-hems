"use client";

import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type ReportVariant = "serialized" | "projector" | "chain_hoist";

type SummaryItem = {
  label: string;
  value: number | string;
};

type UnitRow = {
  id: string;
  unit_no: string | number | null;
  serial: string | null;
  status: string | null;
  notes: string | null;
  testing_date: string | null;
  lamp_hours: number | null;
  cert_date: string | null;
  expiry_date: string | null;
  damage_photos: string[] | string | null;
};

type PdfImageAsset = {
  dataUrl: string;
  width: number;
  height: number;
};

function cleanFileName(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Equipment Report"
  );
}

function statusLabel(value: string | null) {
  if (value === "in_use") return "In Use";
  if (value === "in_ksa") return "In KSA";
  if (value === "maintenance") return "Maintenance";
  return "Available";
}

function normalizePhotos(value: UnitRow["damage_photos"]) {
  if (Array.isArray(value)) {
    return value.filter(
      (photo): photo is string =>
        typeof photo === "string" && photo.trim().length > 0,
    );
  }

  if (typeof value !== "string" || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (photo): photo is string =>
            typeof photo === "string" && photo.trim().length > 0,
        )
      : [value];
  } catch {
    return [value];
  }
}

async function loadPdfImage(
  source: string | null | undefined,
  maxSide = 1200,
): Promise<PdfImageAsset | null> {
  if (!source?.trim()) return null;

  try {
    let dataUrl = source;

    if (!source.startsWith("data:image/")) {
      const response = await fetch(source, { cache: "force-cache" });
      if (!response.ok) return null;

      const blob = await response.blob();
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read image."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(blob);
      });
    }

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onerror = () => reject(new Error("Failed to load image."));
      nextImage.onload = () => resolve(nextImage);
      nextImage.src = dataUrl;
    });

    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    if (!originalWidth || !originalHeight) return null;

    const scale = Math.min(
      1,
      maxSide / Math.max(originalWidth, originalHeight),
    );
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) return null;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.88),
      width,
      height,
    };
  } catch (error) {
    console.warn("Report PDF image could not be loaded", error);
    return null;
  }
}

function containedImageSize(
  image: PdfImageAsset,
  maxWidth: number,
  maxHeight: number,
) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  return {
    width: image.width * scale,
    height: image.height * scale,
  };
}

function reportTitle(variant: ReportVariant) {
  if (variant === "chain_hoist") return "CHAIN HOIST REPORT";
  if (variant === "projector") return "PROJECTOR REPORT";
  return "EQUIPMENT REPORT";
}

function unitTable(variant: ReportVariant, rows: UnitRow[]) {
  if (variant === "chain_hoist") {
    return {
      head: [["ID", "Serial", "Status", "Cert", "Expiry", "Note", "Photos"]],
      body: rows.map((row) => [
        String(row.unit_no ?? "-"),
        row.serial || "-",
        statusLabel(row.status),
        row.cert_date || "-",
        row.expiry_date || "-",
        row.notes || "-",
        String(normalizePhotos(row.damage_photos).length),
      ]),
      widths: {
        0: { cellWidth: 12 },
        1: { cellWidth: 28 },
        2: { cellWidth: 24 },
        3: { cellWidth: 22 },
        4: { cellWidth: 22 },
        6: { cellWidth: 13, halign: "center" as const },
      },
    };
  }

  if (variant === "projector") {
    return {
      head: [["ID", "Serial", "Status", "Lamp", "Test Date", "Note", "Photos"]],
      body: rows.map((row) => [
        String(row.unit_no ?? "-"),
        row.serial || "-",
        statusLabel(row.status),
        String(row.lamp_hours ?? 0),
        row.testing_date || "-",
        row.notes || "-",
        String(normalizePhotos(row.damage_photos).length),
      ]),
      widths: {
        0: { cellWidth: 12 },
        1: { cellWidth: 29 },
        2: { cellWidth: 24 },
        3: { cellWidth: 15, halign: "center" as const },
        4: { cellWidth: 23 },
        6: { cellWidth: 13, halign: "center" as const },
      },
    };
  }

  return {
    head: [["ID", "Serial", "Status", "Test Date", "Note", "Photos"]],
    body: rows.map((row) => [
      String(row.unit_no ?? "-"),
      row.serial || "-",
      statusLabel(row.status),
      row.testing_date || "-",
      row.notes || "-",
      String(normalizePhotos(row.damage_photos).length),
    ]),
    widths: {
      0: { cellWidth: 12 },
      1: { cellWidth: 31 },
      2: { cellWidth: 25 },
      3: { cellWidth: 24 },
      5: { cellWidth: 13, halign: "center" as const },
    },
  };
}

export default function UnitReportPdfButton({
  variant,
  itemId,
  itemName,
  itemPhotoUrl,
  summary,
}: {
  variant: ReportVariant;
  itemId: string;
  itemName: string;
  itemPhotoUrl?: string | null;
  summary: SummaryItem[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [exporting, setExporting] = useState(false);

  async function downloadPdf() {
    if (exporting) return;
    setExporting(true);

    try {
      const [{ data, error }, { jsPDF }, { autoTable }, logo, itemPhoto] =
        await Promise.all([
          supabase
            .from("units")
            .select(
              "id,unit_no,serial,status,notes,testing_date,lamp_hours,cert_date,expiry_date,damage_photos",
            )
            .eq("item_id", itemId)
            .order("unit_no", { ascending: true }),
          import("jspdf"),
          import("jspdf-autotable"),
          loadPdfImage("/logo.png", 1600),
          loadPdfImage(itemPhotoUrl, 1000),
        ]);

      if (error) throw error;

      const rows = (data ?? []) as UnitRow[];
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;

      function drawHeader() {
        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, pageWidth, 25, "F");

        if (logo) {
          const size = containedImageSize(logo, 43, 9);
          pdf.addImage(
            logo.dataUrl,
            "JPEG",
            margin,
            7,
            size.width,
            size.height,
          );
        } else {
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(12);
          pdf.setTextColor(20, 20, 20);
          pdf.text("HILIGHTS GROUP", margin, 13);
        }

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        pdf.setTextColor(25, 25, 25);
        pdf.text(reportTitle(variant), pageWidth - margin, 11, {
          align: "right",
        });
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7);
        pdf.setTextColor(110, 110, 110);
        pdf.text(itemName, pageWidth - margin, 17, {
          align: "right",
          maxWidth: 92,
        });
        pdf.setDrawColor(225, 225, 225);
        pdf.line(margin, 23, pageWidth - margin, 23);
      }

      drawHeader();

      const cardY = 29;
      const cardHeight = 22;
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(225, 225, 225);
      pdf.roundedRect(margin, cardY, pageWidth - margin * 2, cardHeight, 3, 3, "FD");

      let textX = margin + 5;
      if (itemPhoto) {
        const box = 16;
        const size = containedImageSize(itemPhoto, box, box);
        pdf.addImage(
          itemPhoto.dataUrl,
          "JPEG",
          margin + 3 + (box - size.width) / 2,
          cardY + 3 + (box - size.height) / 2,
          size.width,
          size.height,
        );
        textX = margin + 23;
      }

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11);
      pdf.setTextColor(25, 25, 25);
      const titleLines = pdf.splitTextToSize(itemName, 82).slice(0, 2);
      pdf.text(titleLines, textX, cardY + 7);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(6.8);
      pdf.setTextColor(120, 120, 120);
      pdf.text(`Generated: ${new Date().toLocaleString()}`, textX, cardY + 17);

      let summaryX = pageWidth - margin - 4;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(7);
      [...summary].reverse().forEach((item) => {
        const label = `${item.label}: ${item.value}`;
        const width = Math.min(34, pdf.getTextWidth(label) + 6);
        summaryX -= width;
        pdf.setFillColor(243, 244, 246);
        pdf.roundedRect(summaryX, cardY + 8, width, 6, 1.5, 1.5, "F");
        pdf.setTextColor(55, 65, 81);
        pdf.text(label, summaryX + width / 2, cardY + 12, { align: "center" });
        summaryX -= 2;
      });

      const table = unitTable(variant, rows);
      autoTable(pdf, {
        head: table.head,
        body: table.body,
        startY: cardY + cardHeight + 4,
        margin: { top: 29, right: margin, bottom: 15, left: margin },
        theme: "grid",
        styles: {
          font: "helvetica",
          fontSize: 7.2,
          cellPadding: 2,
          overflow: "linebreak",
          valign: "middle",
          lineColor: [229, 231, 235],
          lineWidth: 0.15,
          textColor: [45, 45, 45],
        },
        headStyles: {
          fillColor: [31, 41, 55],
          textColor: [255, 255, 255],
          fontStyle: "bold",
          fontSize: 7,
        },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        columnStyles: table.widths as unknown as Record<
          number,
          { cellWidth: number; halign?: "center" }
        >,
        willDrawPage: () => drawHeader(),
      });

      let cursorY = ((pdf as any).lastAutoTable?.finalY || 29) + 8;
      const unitsWithPhotos = rows
        .map((row) => ({ row, photos: normalizePhotos(row.damage_photos).slice(0, 3) }))
        .filter((entry) => entry.photos.length > 0);

      if (unitsWithPhotos.length > 0) {
        if (cursorY > pageHeight - 30) {
          pdf.addPage();
          drawHeader();
          cursorY = 31;
        }

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        pdf.setTextColor(25, 25, 25);
        pdf.text("Damage Photos", margin, cursorY);
        cursorY += 6;

        for (const entry of unitsWithPhotos) {
          const assets = (
            await Promise.all(entry.photos.map((photo) => loadPdfImage(photo, 900)))
          ).filter((asset): asset is PdfImageAsset => Boolean(asset));
          if (assets.length === 0) continue;

          const rowHeight = 36;
          if (cursorY + rowHeight > pageHeight - 14) {
            pdf.addPage();
            drawHeader();
            cursorY = 31;
          }

          pdf.setFillColor(249, 250, 251);
          pdf.setDrawColor(229, 231, 235);
          pdf.roundedRect(margin, cursorY, pageWidth - margin * 2, rowHeight, 2, 2, "FD");
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(7.5);
          pdf.setTextColor(45, 45, 45);
          pdf.text(
            `Unit ${entry.row.unit_no ?? "-"}${entry.row.serial ? ` · ${entry.row.serial}` : ""}`,
            margin + 4,
            cursorY + 6,
            { maxWidth: 43 },
          );

          const imageX = margin + 48;
          const imageBoxWidth = 39;
          const imageBoxHeight = 27;
          assets.forEach((asset, index) => {
            const boxX = imageX + index * (imageBoxWidth + 3);
            const size = containedImageSize(asset, imageBoxWidth, imageBoxHeight);
            pdf.addImage(
              asset.dataUrl,
              "JPEG",
              boxX + (imageBoxWidth - size.width) / 2,
              cursorY + 4 + (imageBoxHeight - size.height) / 2,
              size.width,
              size.height,
            );
          });

          cursorY += rowHeight + 3;
        }
      }

      const pages = pdf.getNumberOfPages();
      for (let page = 1; page <= pages; page += 1) {
        pdf.setPage(page);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        pdf.setTextColor(135, 135, 135);
        pdf.text(`Page ${page} of ${pages}`, pageWidth - margin, pageHeight - 7, {
          align: "right",
        });
      }

      pdf.save(`${cleanFileName(itemName)} Report.pdf`);
    } catch (error) {
      console.error("download report PDF error", error);
      alert("PDF download failed. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void downloadPdf()}
      disabled={exporting}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[9px] font-medium text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-wait disabled:opacity-50 sm:text-[10px]"
    >
      <Download size={11} />
      <span className="sm:hidden">{exporting ? "..." : "PDF"}</span>
      <span className="hidden sm:inline">
        {exporting ? "Preparing..." : "Download PDF"}
      </span>
    </button>
  );
}
