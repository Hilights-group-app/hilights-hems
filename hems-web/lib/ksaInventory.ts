export type KsaInventoryGroup = {
  record_type: "unit" | "matrix_model" | "matrix_row";
  record_id: string;
  parent_record_id: string;
  display_name: string;
  serial_number: string | null;
  block_name: string | null;
  metadata: Record<string, unknown> | null;
  in_ksa_quantity: number;
  reserved_quantity: number;
  selectable_quantity: number;
};
export type KsaUnitChoice = {id:string;unit_no:number|null;serial:string|null;selectable:boolean};

export function ksaRequestedQuantity(value:number,mode:"units"|"sqm",area:number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (mode === "sqm") return Number.isFinite(area) && area > 0 ? Math.ceil(value/area-0.0000001) : 0;
  return Number.isInteger(value) ? value : 0;
}
