import type { EquipmentListItem } from "@/lib/equipmentLists";
import { listReturnQuantities } from "@/lib/listReturnQuantities";

/** Read-only return progress beside the existing Received action. */
export default function ActiveListQuantity({items, squareMetres = false, compact = false}: {
  items: readonly EquipmentListItem[];
  squareMetres?: boolean;
  compact?: boolean;
}) {
  const amounts = listReturnQuantities(items);
  const format = (quantity: number) => squareMetres
    ? `${Number(quantity.toFixed(3))} SQM`
    : `${quantity} ${quantity === 1 ? "Unit" : "Units"}`;
  const sent = squareMetres ? amounts.sentSquareMetres : amounts.sent;
  const received = squareMetres ? amounts.receivedSquareMetres : amounts.received;
  const outside = squareMetres ? amounts.outsideSquareMetres : amounts.outside;
  const description = `Sent: ${format(sent)} · Received: ${format(received)} · Out: ${format(outside)}`;

  return (
    <div data-active-return-quantity role="group" aria-label={description} title={description}
      className="flex flex-col items-end gap-0.5 text-right tabular-nums">
      <span data-return-outside className={`whitespace-nowrap font-bold ${amounts.outside > 0 ? "text-blue-700" : "text-gray-400"} ${compact ? "text-[9px] sm:text-[10px]" : "text-[11px] sm:text-[12px]"}`}>
        {format(outside)} <span className="text-[8px] font-semibold">Out</span>
      </span>
      {amounts.received > 0 ? (
        <span data-return-received className={`whitespace-nowrap font-semibold text-green-700 ${compact ? "text-[7px] sm:text-[8px]" : "text-[8px] sm:text-[9px]"}`}>
          {Number(received.toFixed(3))} / {Number(sent.toFixed(3))}{squareMetres ? " SQM" : ""} Received
        </span>
      ) : null}
    </div>
  );
}
