export type EquipmentListType =
  | "dry_hire"
  | "local_event"
  | "transfer_out"
  | "transfer_in"
  | "internal_use"
  | "maintenance";

export type EquipmentListStatus =
  | "draft"
  | "pending"
  | "active"
  | "partially_returned"
  | "closed"
  | "cancelled";

export type InventoryLocation = {
  id: string;
  code: string;
  name: string;
};

export type EquipmentList = {
  id: string;
  reference: string;
  list_type: EquipmentListType;
  status: EquipmentListStatus;
  client_company: string | null;
  event_name: string | null;
  venue: string | null;
  purpose: string | null;
  assigned_to: string | null;
  from_location_name: string | null;
  destination_name: string | null;
  pickup_date: string | null;
  return_date: string | null;
  setup_date: string | null;
  dismantling_date: string | null;
  loading_date: string | null;
  receiving_date: string | null;
  repair_company: string | null;
  maintenance_sent_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type EquipmentListItem = {
  id: string;
  list_id: string;
  inventory_record_type: "item" | "unit" | "matrix_model" | "matrix_row";
  inventory_record_id: string;
  parent_record_id: string | null;
  display_name: string;
  serial_number: string | null;
  block_name: string | null;
  requested_quantity: number;
  approved_quantity: number;
  returned_ok_quantity: number;
  returned_maintenance_quantity: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export const ACTIVE_EQUIPMENT_LIST_KEY = "hems:active-equipment-list-id";
export const ACTIVE_EQUIPMENT_LIST_EVENT =
  "hems:active-equipment-list-change";
export const EQUIPMENT_LISTS_EVENT = "hems:equipment-lists-change";
export const EQUIPMENT_LIST_ITEMS_EVENT =
  "hems:equipment-list-items-change";

export const EQUIPMENT_LIST_TYPE_OPTIONS: Array<{
  value: EquipmentListType;
  label: string;
  shortLabel: string;
}> = [
  { value: "dry_hire", label: "Dry Hire", shortLabel: "DH" },
  { value: "local_event", label: "Local Event", shortLabel: "EV" },
  { value: "transfer_out", label: "Transfer Out", shortLabel: "TO" },
  { value: "internal_use", label: "Internal Use", shortLabel: "IU" },
  {
    value: "maintenance",
    label: "Send for Maintenance",
    shortLabel: "MR",
  },
];

export function equipmentListTypeLabel(type: EquipmentListType) {
  return (
    EQUIPMENT_LIST_TYPE_OPTIONS.find((option) => option.value === type)
      ?.label ?? type
  );
}

export function equipmentListStatusLabel(status: EquipmentListStatus) {
  if (status === "partially_returned") return "Partial Return";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function equipmentListSummary(list: EquipmentList) {
  if (list.list_type === "dry_hire") {
    return list.client_company || "Dry Hire";
  }

  if (list.list_type === "local_event") {
    return [list.event_name, list.venue].filter(Boolean).join(" · ") || "Event";
  }

  if (list.list_type === "transfer_out" || list.list_type === "transfer_in") {
    return [list.from_location_name, list.destination_name]
      .filter(Boolean)
      .join(" → ");
  }

  if (list.list_type === "maintenance") {
    return list.repair_company
      ? `At ${list.repair_company} for Repair`
      : "External Repair";
  }

  return [list.purpose, list.assigned_to].filter(Boolean).join(" · ") || "Internal Use";
}
