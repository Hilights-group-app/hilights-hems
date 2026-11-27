import type { EquipmentListItem } from "./equipmentLists";
import { localEventLedCabinetArea } from "./activeListLayout";

type List = { list_type: string; status: string };
export type ActiveListFilter = "all" | "out" | "received" | "missing";
export const ACTIVE_LIST_FILTER_LABELS: Record<ActiveListFilter,string> = {
  all:"All",out:"Out",received:"Received",missing:"Missing",
};
export type PdfMaintenanceReceipt = { list_item_id: string; quantity: number; received_quantity: number };
export type EquipmentPdfCell = {
  content?: string; colSpan?: number; rowKind?: string;
  quantityItems?: readonly EquipmentListItem[];
  styles?: Record<string, unknown>; [key: string]: unknown;
};
const count = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0,Number(value)) : 0;
const custom = (item: EquipmentListItem) => item.inventory_record_type === "item" ||
  item.metadata?.custom_item === true || item.metadata?.custom_item === "true";
// Match ActiveListEquipmentTable.module.css exactly (#17202e/#16844a/#2254d7).
type PdfRgb = [number, number, number];
export const ACTIVE_PDF_QUANTITY_COLORS: Record<"sent" | "received" | "out" | "missing", PdfRgb> = {
  sent:[23,32,46],received:[22,132,74],out:[34,84,215],
  missing:[199,37,54],
};

export function showActivePdfColumns(list: List) {
  return list.status === "active" || list.status === "partially_returned";
}

function receiptCounts(list: List,item: EquipmentListItem,receipts: readonly PdfMaintenanceReceipt[]) {
  const requests=list.list_type === "maintenance" ? receipts.filter(row=>row.list_item_id === item.id) : [];
  const sent=count(item.approved_quantity) || (requests.length ? requests.reduce((n,row)=>n+count(row.quantity),0) : count(item.requested_quantity));
  const returned=count(item.returned_ok_quantity)+count(item.returned_maintenance_quantity);
  const received=Math.min(sent,list.list_type === "maintenance" && requests.length
    ? requests.reduce((n,row)=>n+Math.min(count(row.quantity),count(row.received_quantity)),0)
    : list.list_type === "transfer_out" ? Math.max(returned,count(item.transfer_received_quantity)) : returned);
  const missing=Math.min(Math.max(0,sent-received),count(item.missing_quantity));
  return {sent,received,missing,out:Math.max(0,sent-received-missing)};
}

/** One shared filter for the page and PDF, including serials and cable lengths. */
export function filterActiveListGroups<T extends {items: EquipmentListItem[]}>(list: List,groups: readonly T[],filter: ActiveListFilter,receipts: readonly PdfMaintenanceReceipt[] = []): T[] {
  if (!showActivePdfColumns(list) || filter === "all") return [...groups];
  return groups.flatMap(group=>{
    const items=group.items.filter(item=>!custom(item) && receiptCounts(list,item,receipts)[filter]>0);
    return items.length ? [{...group,items}] : [];
  });
}

function missingPdfQuantity(list: List,items: readonly EquipmentListItem[],receipts: readonly PdfMaintenanceReceipt[]) {
  let missing=0;const led=items.length>0 && items.every(item=>item.inventory_record_type === "matrix_row" && item.metadata?.matrix_source !== "generic" && !custom(item));
  for(const item of items){const area=led?localEventLedCabinetArea(item):1;if(!(area>0))return "Unknown SQM";
    missing+=receiptCounts(list,item,receipts).missing*area;}
  return `${Number(missing.toFixed(3))}${led?" SQM":""}`;
}

/** PDF-only snapshot. Never receives, dispatches or modifies stock. */
export function activePdfCounts(list: List, items: readonly EquipmentListItem[], receipts: readonly PdfMaintenanceReceipt[] = []) {
  const allCustom = items.length > 0 && items.every(custom);
  const led = items.length > 0 && items.every(item => item.inventory_record_type === "matrix_row" &&
    item.metadata?.matrix_source !== "generic" && !custom(item));
  const areas = led ? items.map(localEventLedCabinetArea) : items.map(()=>1);
  if (led && areas.some(area=>!(area>0))) return { sent:"Unknown SQM",received:"Unknown SQM",out:"Unknown SQM" };
  let sent=0,received=0,out=0;
  items.forEach((item,index)=>{
    const amounts=receiptCounts(list,item,receipts);
    const area=areas[index];
    sent+=amounts.sent*area;received+=amounts.received*area;out+=amounts.out*area;
  });
  const format = (n:number) => `${Number(n.toFixed(3))}${led ? " SQM" : ""}`;
  // Custom/non-inventory equipment has no warehouse receipt workflow.
  return {sent:format(sent),received:allCustom?"-":format(received),out:allCustom?"-":format(out)};
}

/** Retain the existing photos/names/details; expand only active PDF quantities. */
export function activePdfTable(list: List, body: EquipmentPdfCell[][], receipts: readonly PdfMaintenanceReceipt[] = [],filter: ActiveListFilter = "all") {
  if (!showActivePdfColumns(list)) return null;
  const keys: ("sent"|"received"|"out"|"missing")[]=filter === "all" ? ["sent","received","out"] : [filter];
  const tones=keys.map(key=>ACTIVE_PDF_QUANTITY_COLORS[key]),span=5+keys.length;
  const quantityCell = (content:string,styles:Record<string,unknown>,textColor:PdfRgb) => ({content,styles:{
    ...styles,halign:"right" as const,valign:"middle" as const,fontStyle:"bold" as const,fontSize:7.2,
    cellPadding:{top:2.8,right:2,bottom:2.8,left:1.2},
    textColor,
  }});
  const rows = body.map(row=>{
    const first=row[0];
    if (first?.rowKind === "category") return [{...first,colSpan:span}];
    if (first?.quantityItems) {
      const {quantityItems,...cell}=first;
      const values={...activePdfCounts(list,quantityItems,receipts),missing:missingPdfQuantity(list,quantityItems,receipts)};
      // A cable collection's parent is a heading, not a second quantity row.
      const headingOnly = first.rowKind === "item" && row[1]?.content === "";
      const styles=row[1]?.styles||{};
      return [{...cell,colSpan:5},...keys.map(key=>headingOnly?"":values[key]).map((value,index)=>quantityCell(value,styles,tones[index]))];
    }
    if (first?.colSpan === 5) return [{...first,colSpan:span}];
    // Serial/rack details remain full-width, so the additional quantity columns
    // cannot narrow or clip them. Existing serial visibility is preserved.
    return [{...first,content:row.map(cell=>cell.content||"").filter(Boolean).join("    |    "),colSpan:span}];
  });
  const columnStyles: Record<number,{cellWidth:number;halign?:"right"}> = filter === "all" ? {
    0:{cellWidth:36},1:{cellWidth:3},2:{cellWidth:36},3:{cellWidth:3},4:{cellWidth:38},
    5:{cellWidth:22,halign:"right"},6:{cellWidth:22,halign:"right"},7:{cellWidth:22,halign:"right"},
  } : {0:{cellWidth:50},1:{cellWidth:3},2:{cellWidth:50},3:{cellWidth:3},4:{cellWidth:50},5:{cellWidth:26,halign:"right"}};
  return {
    body:rows,
    head:[[{content:"Equipment",colSpan:5},...keys.map((key,index)=>({content:key === "sent" ? "Sent" : ACTIVE_LIST_FILTER_LABELS[key],styles:{halign:"right" as const,textColor:tones[index]}}))]],
    // A4 usable width 182mm: equipment 116mm, three quantities 22mm each.
    columnStyles,
  };
}
