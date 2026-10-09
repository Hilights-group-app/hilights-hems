"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload, X } from "lucide-react";
import * as XLSX from "xlsx-js-style";
import { createClient } from "@/lib/supabase/client";
import { canImportInventory } from "@/lib/authStore";

type Category = {
  id: string;
  name: string;
  slug: string;
  subcategories: { id: string; name: string; slug: string }[];
};

type ImportKind =
  | "serialized"
  | "lighting"
  | "projectors"
  | "chain-hoists"
  | "led-screens"
  | "matrix-items";

type ImportRow = {
  key: string;
  sheet: string;
  rowNumber: number;
  kind: ImportKind;
  values: Record<string, string>;
  errors: string[];
};

type Result = { imported: number; skipped: number; failed: number };

type SheetDefinition = {
  name: string;
  kind: ImportKind;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  subcategoryId: string;
  subcategoryName: string;
  subcategorySlug: string;
  headers: string[];
};

const HEADERS_BY_KIND: Record<ImportKind, string[]> = {
  serialized: ["block_name", "brand", "model", "quantity", "photo_url"],
  lighting: ["fixture_type", "brand", "model", "quantity", "photo_url"],
  projectors: ["block_name", "brand", "model", "quantity", "photo_url"],
  "chain-hoists": ["block_name", "brand", "model", "capacity", "chain_length", "quantity", "photo_url"],
  "led-screens": ["brand", "model", "cabinet_size", "cabinet_model", "quantity", "photo_url"],
  "matrix-items": ["item_type", "brand", "model", "cable_rack_name", "quantity", "block_name", "new_block_name", "photo_url"],
};

const FIELD_LABELS: Record<string, string> = {
  fixture_type: "Fixture Type",
  block_name: "Block Name",
  new_block_name: "New Block Name",
  brand: "Brand",
  model: "Model",
  cable_rack_name: "Cable / Rack Name",
  capacity: "Capacity",
  chain_length: "Chain Length",
  quantity: "Quantity",
  cabinet_size: "Cabinet Size",
  cabinet_model: "Cabinet Model",
  item_type: "Item Type (unit / cable / rack)",
  photo_url: "Photo URL (Optional)",
};

function kindFromType(type: string | null | undefined, categorySlug: string, subcategorySlug: string): ImportKind {
  // The database type is authoritative. Some matrix subcategories, such as
  // LED Screen Accessories, also contain "led-screen" in their slug.
  if (type === "matrix") return "matrix-items";
  if (type === "chain_hoist_units") return "chain-hoists";
  if (type === "projector_units") return "projectors";
  if (type === "led_screen_units") return "led-screens";
  if (categorySlug === "lighting" && subcategorySlug.includes("fixture")) return "lighting";

  // Slug checks are only fallbacks for older catalog rows without a type.
  if (!type && subcategorySlug.includes("chain-hoist")) return "chain-hoists";
  if (!type && subcategorySlug.includes("projector")) return "projectors";
  if (!type && subcategorySlug.includes("led-screen")) return "led-screens";
  return "serialized";
}

function safeSheetName(value: string, used: Set<string>) {
  const base = value.replace(/[\\/?*:[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Items";
  let name = base;
  let index = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` ${index++}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function importHeaderKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeImportValues(
  raw: Record<string, unknown>,
  headers: string[],
): Record<string, string> {
  const aliases = new Map(
    headers.flatMap((header) => [
      [importHeaderKey(header), header] as const,
      [importHeaderKey(FIELD_LABELS[header] ?? header), header] as const,
    ]),
  );
  const values = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      const normalizedKey = importHeaderKey(key);
      return [aliases.get(normalizedKey) ?? normalizedKey, clean(value)];
    }),
  );
  if (values.item_type !== undefined) {
    values.item_type = values.item_type.toLowerCase();
  }
  return values;
}

function positiveInt(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function itemName(row: ImportRow) {
  if (row.kind === "matrix-items" && row.values.item_type !== "unit") {
    return clean(row.values.cable_rack_name);
  }
  const parts = [row.values.brand, row.values.model];
  if (row.kind === "chain-hoists") {
    parts.push(row.values.capacity, row.values.chain_length);
  }
  return parts.map(clean).filter(Boolean).join(" - ");
}

function serialList(row: ImportRow) {
  return clean(row.values.serials)
    .split(/[;,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function InventoryImportClient({
  categories,
}: {
  categories: Category[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const importingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [parseError, setParseError] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const editable = canImportInventory();

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("hems:open-inventory-import", show);
    return () => window.removeEventListener("hems:open-inventory-import", show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importing) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, importing]);

  function reset() {
    setRows([]);
    setFileName("");
    setParseError("");
    setProgress("");
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function buildSheetDefinitions(): Promise<SheetDefinition[]> {
    const subcategories = categories.flatMap((category) =>
      category.subcategories.map((subcategory) => ({ category, subcategory })),
    );
    const ids = subcategories.map(({ subcategory }) => subcategory.id);
    const typeById = new Map<string, string>();

    if (ids.length > 0) {
      const result = await supabase
        .from("subcategories")
        .select("id,type")
        .in("id", ids);
      if (!result.error) {
        for (const row of result.data ?? []) {
          typeById.set(String(row.id), clean(row.type));
        }
      }
    }

    const usedNames = new Set<string>(["instructions", "_hems_map"]);
    return subcategories.map(({ category, subcategory }) => {
      const kind = kindFromType(
        typeById.get(subcategory.id),
        category.slug,
        subcategory.slug,
      );
      return {
        name: safeSheetName(subcategory.name, usedNames),
        kind,
        categoryId: category.id,
        categoryName: category.name,
        categorySlug: category.slug,
        subcategoryId: subcategory.id,
        subcategoryName: subcategory.name,
        subcategorySlug: subcategory.slug,
        headers: HEADERS_BY_KIND[kind],
      };
    });
  }

  async function downloadTemplate() {
    setProgress("Preparing a template from your current subcategories…");
    const definitions = await buildSheetDefinitions();
    const workbook = XLSX.utils.book_new();

    const instructions = XLSX.utils.aoa_to_sheet([
      ["HEMS INVENTORY IMPORT"],
      ["Easy equipment upload template"],
      ["1", "Open the tab named after the required subcategory."],
      ["2", "Add one equipment model per row using the same fields found in Add Items."],
      ["3", "Do not rename, delete or add tabs and columns."],
      ["4", "Add serial numbers later from the item's report page."],
      ["5", "Photo URL is optional. You can upload/search the photo later in the app."],
      ["6", "Save as .xlsx, upload it in Inventory, review and confirm."],
    ]);
    instructions["!cols"] = [{ wch: 8 }, { wch: 82 }];
    instructions["!rows"] = [{ hpt: 28 }, { hpt: 22 }];
    instructions["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } },
    ];
    instructions.A1.s = {
      fill: { fgColor: { rgb: "111827" } },
      font: { color: { rgb: "FFFFFF" }, bold: true, sz: 16 },
      alignment: { vertical: "center" },
    };
    instructions.A2.s = {
      fill: { fgColor: { rgb: "DC2626" } },
      font: { color: { rgb: "FFFFFF" }, bold: true, sz: 11 },
    };
    for (let row = 2; row < 8; row += 1) {
      const numberCell = instructions[XLSX.utils.encode_cell({ r: row, c: 0 })];
      const textCell = instructions[XLSX.utils.encode_cell({ r: row, c: 1 })];
      numberCell.s = {
        fill: { fgColor: { rgb: "FEE2E2" } },
        font: { color: { rgb: "B91C1C" }, bold: true },
        alignment: { horizontal: "center" },
      };
      textCell.s = {
        fill: { fgColor: { rgb: row % 2 ? "FFFFFF" : "F9FAFB" } },
        font: { color: { rgb: "374151" } },
      };
    }
    XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");

    for (const definition of definitions) {
      const displayHeaders = definition.headers.map(
        (header) => FIELD_LABELS[header] ?? header,
      );
      const blankRows = Array.from({ length: 100 }, () =>
        Array(definition.headers.length).fill(""),
      );
      const sheet = XLSX.utils.aoa_to_sheet([
        [`${definition.subcategoryName} — Inventory Import`],
        [`Category: ${definition.categoryName}`],
        ["Fill one equipment model per row. Required fields are marked with *. Serial numbers are added later from the report page."],
        [],
        displayHeaders,
        ...blankRows,
      ]);
      const lastColumn = definition.headers.length - 1;
      sheet["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: lastColumn } },
      ];
      sheet["!cols"] = definition.headers.map((header) => ({
        wch:
          header === "photo_url"
            ? 34
            : header === "item_type"
              ? 27
              : Math.max(18, (FIELD_LABELS[header] ?? header).length + 4),
      }));
      sheet["!rows"] = [{ hpt: 28 }, { hpt: 21 }, { hpt: 24 }, { hpt: 8 }, { hpt: 25 }];
      sheet["!autofilter"] = {
        ref: XLSX.utils.encode_range({ s: { r: 4, c: 0 }, e: { r: 104, c: lastColumn } }),
      };

      sheet.A1.s = {
        fill: { fgColor: { rgb: "111827" } },
        font: { color: { rgb: "FFFFFF" }, bold: true, sz: 15 },
        alignment: { vertical: "center" },
      };
      sheet.A2.s = {
        fill: { fgColor: { rgb: "DC2626" } },
        font: { color: { rgb: "FFFFFF" }, bold: true, sz: 10 },
      };
      sheet.A3.s = {
        fill: { fgColor: { rgb: "F3F4F6" } },
        font: { color: { rgb: "6B7280" }, italic: true, sz: 9 },
        alignment: { wrapText: true, vertical: "center" },
      };

      for (let column = 0; column <= lastColumn; column += 1) {
        const headerCell = sheet[XLSX.utils.encode_cell({ r: 4, c: column })];
        headerCell.s = {
          fill: { fgColor: { rgb: "1F2937" } },
          font: { color: { rgb: "FFFFFF" }, bold: true, sz: 10 },
          alignment: { horizontal: "center", vertical: "center", wrapText: true },
          border: {
            right: { style: "thin", color: { rgb: "FFFFFF" } },
            bottom: { style: "medium", color: { rgb: "DC2626" } },
          },
        };
      }

      for (let row = 5; row < 105; row += 1) {
        for (let column = 0; column <= lastColumn; column += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          cell.s = {
            fill: { fgColor: { rgb: row % 2 ? "FFFFFF" : "F9FAFB" } },
            font: { color: { rgb: "111827" }, sz: 10 },
            alignment: { vertical: "center" },
            border: {
              bottom: { style: "thin", color: { rgb: "E5E7EB" } },
            },
          };
        }
      }
      XLSX.utils.book_append_sheet(workbook, sheet, definition.name);
    }

    const mapSheet = XLSX.utils.json_to_sheet(
      definitions.map((definition) => ({
        sheet_name: definition.name,
        kind: definition.kind,
        category_id: definition.categoryId,
        category_name: definition.categoryName,
        category_slug: definition.categorySlug,
        subcategory_id: definition.subcategoryId,
        subcategory_name: definition.subcategoryName,
        subcategory_slug: definition.subcategorySlug,
      })),
    );
    XLSX.utils.book_append_sheet(workbook, mapSheet, "_HEMS_MAP");
    workbook.Workbook = {
      Sheets: workbook.SheetNames.map((name) => ({
        Hidden: name === "_HEMS_MAP" ? 1 : 0,
      })),
    };
    XLSX.writeFile(workbook, "HEMS_Inventory_Import_Template.xlsx");
    setProgress("");
  }

  async function readFile(file: File) {
    reset();
    setFileName(file.name);

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const nextRows: ImportRow[] = [];
      const mapSheet = workbook.Sheets._HEMS_MAP;

      if (!mapSheet) {
        setParseError(
          "This is an old template. Download the new template from the app and use its subcategory tabs.",
        );
        return;
      }

      const definitions = XLSX.utils
        .sheet_to_json<Record<string, unknown>>(mapSheet, { defval: "", raw: false })
        .map((raw): SheetDefinition => {
          const kind = clean(raw.kind) as ImportKind;
          return {
            name: clean(raw.sheet_name),
            kind,
            categoryId: clean(raw.category_id),
            categoryName: clean(raw.category_name),
            categorySlug: clean(raw.category_slug),
            subcategoryId: clean(raw.subcategory_id),
            subcategoryName: clean(raw.subcategory_name),
            subcategorySlug: clean(raw.subcategory_slug),
            headers: HEADERS_BY_KIND[kind] ?? HEADERS_BY_KIND.serialized,
          };
        })
        .filter((definition) => definition.name && definition.subcategoryId);

      for (const definition of definitions) {
        const sheet = workbook.Sheets[definition.name];
        if (!sheet) continue;

        const values = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: "",
          raw: false,
          range: 4,
        });

        values.forEach((raw, index) => {
          const normalized = normalizeImportValues(raw, definition.headers);
          if (!Object.values(normalized).some(Boolean)) return;

          const row: ImportRow = {
            key: `${definition.name}-${index + 6}`,
            sheet: definition.name,
            rowNumber: index + 6,
            kind: definition.kind,
            values: {
              ...normalized,
              _category_id: definition.categoryId,
              _category_name: definition.categoryName,
              _category_slug: definition.categorySlug,
              _subcategory_id: definition.subcategoryId,
              _subcategory_name: definition.subcategoryName,
              _subcategory_slug: definition.subcategorySlug,
            },
            errors: [],
          };

          const category = categories.find(
            (entry) => entry.id === definition.categoryId,
          );
          const subcategory = category?.subcategories.find(
            (entry) => entry.id === definition.subcategoryId,
          );

          if (!category) row.errors.push("Category no longer exists");
          else if (!subcategory) row.errors.push("Subcategory no longer exists");
          const matrixNamedItem =
            definition.kind === "matrix-items" &&
            ["cable", "rack"].includes(normalized.item_type);
          if (!matrixNamedItem && !normalized.brand) {
            row.errors.push("Brand is required");
          }
          if (!matrixNamedItem && !normalized.model) {
            row.errors.push("Model is required");
          }
          if (definition.kind === "lighting" && !normalized.fixture_type) {
            row.errors.push("Fixture type is required");
          }
          if (definition.kind === "led-screens") {
            if (!normalized.cabinet_size) row.errors.push("Cabinet size is required");
            if (!normalized.cabinet_model) row.errors.push("Cabinet model is required");
          }
          if (definition.kind === "matrix-items") {
            if (!['unit', 'cable', 'rack'].includes(normalized.item_type?.toLowerCase())) {
              row.errors.push("Item type must be unit, cable or rack");
            }
            if (matrixNamedItem && !normalized.cable_rack_name) {
              row.errors.push("Cable / Rack Name is required");
            }
          }

          nextRows.push(row);
        });
      }

      if (nextRows.length === 0) {
        setParseError("No equipment rows found. Fill at least one subcategory tab.");
      }
      setRows(nextRows);
    } catch (error: any) {
      setParseError(error?.message || "Could not read this Excel file.");
    }
  }

  function resolveLocation(row: ImportRow) {
    const category = categories.find(
      (entry) => entry.id === row.values._category_id,
    );
    const subcategory = category?.subcategories.find(
      (entry) => entry.id === row.values._subcategory_id,
    );
    if (!category || !subcategory) throw new Error("Category or subcategory not found");
    return { category, subcategory };
  }

  async function importUnitRow(row: ImportRow) {
    const { subcategory } = resolveLocation(row);
    const name = itemName(row);
    const blockOrType =
      row.kind === "lighting" ? row.values.fixture_type : row.values.block_name || null;

    const existingResult = await supabase
      .from("items")
      .select("id,name")
      .eq("subcategory_id", subcategory.id);
    if (existingResult.error) throw existingResult.error;

    let item = (existingResult.data ?? []).find(
      (entry: any) => clean(entry.name).toLowerCase() === name.toLowerCase(),
    );

    if (!item) {
      const inserted = await supabase
        .from("items")
        .insert({
          subcategory_id: subcategory.id,
          name,
          fixture_type: blockOrType,
          photo_url: row.values.photo_url || null,
        })
        .select("id,name")
        .single();
      if (inserted.error) throw inserted.error;
      item = inserted.data;
    }

    const unitResult = await supabase
      .from("units")
      .select("unit_no,serial")
      .eq("item_id", item.id);
    if (unitResult.error) throw unitResult.error;

    const existingUnits = unitResult.data ?? [];
    const existingSerials = new Set(
      existingUnits.map((unit: any) => clean(unit.serial).toLowerCase()).filter(Boolean),
    );
    const requestedSerials = serialList(row);
    const newSerials = requestedSerials.filter(
      (serial) => !existingSerials.has(serial.toLowerCase()),
    );
    const requestedQuantity = positiveInt(row.values.quantity, requestedSerials.length || 1);
    const quantity = Math.max(requestedQuantity, requestedSerials.length);
    const blankCount = Math.max(0, quantity - requestedSerials.length);
    const serialsToAdd = [...newSerials, ...Array.from({ length: blankCount }, () => "")];
    const firstUnitNo =
      Math.max(0, ...existingUnits.map((unit: any) => Number(unit.unit_no) || 0)) + 1;

    if (serialsToAdd.length === 0) return false;

    const payload = serialsToAdd.map((serial, index) => ({
      item_id: item.id,
      unit_no: firstUnitNo + index,
      serial: serial || null,
      status: "available",
      ...(row.kind === "chain-hoists"
        ? { cert_date: null, expiry_date: null, notes: "", damage_photos: [] }
        : {}),
      ...(row.kind === "projectors" ? { notes: "", lamp_hours: 0 } : {}),
    }));
    const insertedUnits = await supabase.from("units").insert(payload);
    if (insertedUnits.error) throw insertedUnits.error;
    return true;
  }

  async function importLedRow(row: ImportRow) {
    const { category, subcategory } = resolveLocation(row);
    const name = [row.values.brand, row.values.model].map(clean).filter(Boolean).join(" - ");
    const modelsResult = await supabase
      .from("matrix_models")
      .select("id,name")
      .eq("subcategory_id", subcategory.id);
    if (modelsResult.error) throw modelsResult.error;

    let model = (modelsResult.data ?? []).find(
      (entry: any) => clean(entry.name).toLowerCase() === name.toLowerCase(),
    );
    if (!model) {
      const inserted = await supabase
        .from("matrix_models")
        .insert({ category_id: category.id, subcategory_id: subcategory.id, name })
        .select("id,name")
        .single();
      if (inserted.error) throw inserted.error;
      model = inserted.data;
    }

    const quantity = Math.max(1, positiveInt(row.values.quantity, 1));
    const rowsResult = await supabase
      .from("matrix_rows")
      .select(
        "id,size,cabinet_model,qty,available_qty,in_use_qty,maintenance_qty,in_ksa_qty,photo_data,sort_order",
      )
      .eq("model_id", model.id);
    if (rowsResult.error) throw rowsResult.error;

    const wantedSize = clean(row.values.cabinet_size).toLowerCase();
    const wantedCabinetModel = clean(row.values.cabinet_model).toLowerCase();
    const existingRow = (rowsResult.data ?? []).find(
      (entry: any) =>
        clean(entry.size).toLowerCase() === wantedSize &&
        clean(entry.cabinet_model).toLowerCase() === wantedCabinetModel,
    );

    if (existingRow) {
      const updatedRow = await supabase
        .from("matrix_rows")
        .update({
          qty: (Number(existingRow.qty) || 0) + quantity,
          available_qty:
            (Number(existingRow.available_qty) || 0) + quantity,
          ...(!existingRow.photo_data && row.values.photo_url
            ? { photo_data: row.values.photo_url }
            : {}),
        })
        .eq("id", existingRow.id);
      if (updatedRow.error) throw updatedRow.error;
      return true;
    }

    const insertedRow = await supabase.from("matrix_rows").insert({
      model_id: model.id,
      size: row.values.cabinet_size,
      cabinet_model: row.values.cabinet_model,
      qty: quantity,
      available_qty: quantity,
      in_use_qty: 0,
      maintenance_qty: 0,
      in_ksa_qty: 0,
      photo_data: row.values.photo_url || null,
      sort_order: (rowsResult.data ?? []).length,
    });
    if (insertedRow.error) throw insertedRow.error;
    return true;
  }

  async function importMatrixRow(row: ImportRow) {
    const { category, subcategory } = resolveLocation(row);
    const itemType = row.values.item_type.toLowerCase();
    const name =
      itemType === "unit"
        ? [row.values.brand, row.values.model].map(clean).filter(Boolean).join(" - ")
        : clean(row.values.cable_rack_name);
    const quantity = positiveInt(row.values.quantity, itemType === "unit" ? 1 : 0);
    const list = await supabase
      .from("matrix_models")
      .select("id,name,total_qty,item_type")
      .eq("subcategory_id", subcategory.id);
    if (list.error) throw list.error;

    let item = (list.data ?? []).find(
      (entry: any) => clean(entry.name).toLowerCase() === name.toLowerCase(),
    );
    if (!item) {
      const inserted = await supabase
        .from("matrix_models")
        .insert({
          category_id: category.id,
          subcategory_id: subcategory.id,
          name,
          item_type: itemType,
          block_name:
            row.values.new_block_name ||
            row.values.block_name ||
            (itemType === "unit" ? row.values.brand : itemType === "rack" ? "Racks" : "Cables"),
          photo_data: row.values.photo_url || null,
          total_qty: quantity,
          in_use_qty: 0,
          maintenance_qty: 0,
          in_ksa_qty: 0,
        })
        .select("id,name,total_qty,item_type")
        .single();
      if (inserted.error) throw inserted.error;
      item = inserted.data;
    } else if (quantity > 0) {
      const updated = await supabase
        .from("matrix_models")
        .update({ total_qty: (Number(item.total_qty) || 0) + quantity })
        .eq("id", item.id);
      if (updated.error) throw updated.error;
    }

    return true;
  }

  async function confirmImport() {
    if (!editable || importingRef.current || importing || rows.length === 0) return;
    const validRows = rows.filter((row) => row.errors.length === 0);
    if (validRows.length === 0) return;

    importingRef.current = true;
    setImporting(true);
    setResult(null);
    const next: Result = { imported: 0, skipped: rows.length - validRows.length, failed: 0 };

    for (let index = 0; index < validRows.length; index += 1) {
      const row = validRows[index];
      setProgress(`Importing ${index + 1} of ${validRows.length} — ${row.sheet} row ${row.rowNumber}`);
      try {
        const changed =
          row.kind === "led-screens"
            ? await importLedRow(row)
            : row.kind === "matrix-items"
              ? await importMatrixRow(row)
              : await importUnitRow(row);
        if (changed) next.imported += 1;
        else next.skipped += 1;
      } catch (error) {
        console.error(`Import failed at ${row.sheet} row ${row.rowNumber}`, error);
        next.failed += 1;
      }
    }

    sessionStorage.removeItem("hems:catalog:v4");
    setResult(next);
    setProgress("");
    setImporting(false);
    importingRef.current = false;

    const message = `Import complete: ${next.imported} imported, ${next.skipped} skipped, ${next.failed} failed.`;
    setOpen(false);
    reset();
    window.setTimeout(() => window.alert(message), 0);
  }

  const invalidCount = rows.filter((row) => row.errors.length > 0).length;
  const previewRows = rows.slice(0, 100);

  if (!editable) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-xs font-semibold text-gray-800 shadow-sm hover:border-red-200 hover:bg-red-50 hover:text-red-700"
      >
        <FileSpreadsheet size={15} /> Import Excel
      </button>

      {open ? (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-5">
          <div className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-2xl">
            <div className="flex items-start justify-between border-b border-gray-200 px-4 py-4 sm:px-6">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Import Inventory from Excel</h2>
                <p className="mt-1 text-xs text-gray-500">Download the template, fill it, then preview before saving.</p>
              </div>
              <button
                type="button"
                disabled={importing}
                onClick={() => setOpen(false)}
                className="rounded-full p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void downloadTemplate()}
                  className="flex items-center justify-center gap-2 rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-800 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                >
                  <Download size={17} /> Download Template
                </button>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="flex items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white hover:bg-gray-800"
                >
                  <Upload size={17} /> {fileName || "Choose Excel File"}
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                  }}
                />
              </div>

              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
                Open the tab named after the required subcategory and add one equipment model per row. Do not rename tabs or columns. Photo URL is optional. Add serial numbers later from the item report page.
              </div>

              {parseError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{parseError}</div>
              ) : null}

              {rows.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                    <span className="rounded-full bg-gray-100 px-3 py-1.5 text-gray-700">{rows.length} rows</span>
                    <span className="rounded-full bg-green-100 px-3 py-1.5 text-green-700">{rows.length - invalidCount} ready</span>
                    {invalidCount > 0 ? <span className="rounded-full bg-red-100 px-3 py-1.5 text-red-700">{invalidCount} need attention</span> : null}
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="px-3 py-2">Sheet / Row</th>
                          <th className="px-3 py-2">Category</th>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Qty</th>
                          <th className="px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {previewRows.map((row) => (
                          <tr key={row.key} className={row.errors.length ? "bg-red-50" : "bg-white"}>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-700">{row.sheet} #{row.rowNumber}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-600">{row.values._category_name} / {row.values._subcategory_name}</td>
                            <td className="px-3 py-2 text-gray-900">{itemName(row)}</td>
                            <td className="px-3 py-2 text-gray-600">{row.values.quantity || row.values.detail_quantity || "—"}</td>
                            <td className="px-3 py-2">
                              {row.errors.length ? <span className="text-red-700">{row.errors.join(" · ")}</span> : <span className="text-green-700">Ready</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {rows.length > 100 ? <p className="text-xs text-gray-500">Showing the first 100 rows. All valid rows will be imported.</p> : null}
                </>
              ) : null}

              {progress ? <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm font-medium text-gray-700">{progress}</div> : null}
              {result ? (
                <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                  Import complete: {result.imported} imported, {result.skipped} skipped, {result.failed} failed.
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-4 sm:px-6">
              <button type="button" disabled={importing} onClick={reset} className="text-xs font-semibold text-gray-500 hover:text-gray-900 disabled:opacity-40">Clear</button>
              <button
                type="button"
                disabled={!editable || importing || rows.length === 0 || rows.length === invalidCount}
                onClick={() => void confirmImport()}
                className="rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {importing ? "Importing…" : `Confirm Import (${rows.length - invalidCount})`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
