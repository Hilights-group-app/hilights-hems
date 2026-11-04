"use client";

import { Fragment, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Loader2, PackageCheck, RotateCcw, X } from "lucide-react";
import type { EquipmentList, EquipmentListItem } from "@/lib/equipmentLists";
import { activeGroupKind, activeQuantityText, activeRowCounts, activeSerialReference, activeSerialStatus,
  activeLineOutside, canReceiveActiveItem, type ActiveEquipmentGroup } from "@/lib/activeListLayout";
import ReceivedCorrectionAction from "./ReceivedCorrectionAction";
import styles from "./ActiveListEquipmentTable.module.css";

export type ActiveGroupPresentation = {
  category: string;
  photoUrl: string;
  brand: string;
  model: string;
  primaryName: string;
  cabinetDetail: string;
  description: string;
  secondary: string;
  rackContents: string;
};

type Props = {
  list: EquipmentList;
  groups: ActiveEquipmentGroup[];
  manager: boolean;
  canReceive: boolean;
  busy: boolean;
  receivingItemId: string | null;
  hiddenSerialPdfKeys: ReadonlySet<string>;
  onToggleSerialPdf: (key: string) => void;
  presentGroup: (group: ActiveEquipmentGroup) => ActiveGroupPresentation;
  onReceive: (item: EquipmentListItem) => void;
  onCorrect: (item: EquipmentListItem) => void;
};

/** Presentation only: all mutations still use the existing parent dialogs/RPCs. */
export default function ActiveListEquipmentTable(props: Props) {
  const { list, groups, manager, canReceive, busy, receivingItemId, onReceive, onCorrect } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [receivingGroupKey, setReceivingGroupKey] = useState<string | null>(null);
  const receivingGroup = groups.find(group => group.key === receivingGroupKey);

  function toggleSerials(key: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function receiveGroup(items: EquipmentListItem[]) {
    if (!canReceive || busy) return;
    const eligible = items.filter(canReceiveActiveItem);
    if (eligible.length === 1) onReceive(eligible[0]);
    else if (eligible.length > 1) {
      const group = groups.find(candidate => candidate.items.some(item => item.id === eligible[0].id));
      if (group) setReceivingGroupKey(group.key);
    }
  }

  function actionCells(items: EquipmentListItem[], iconOnly = false) {
    const eligible = items.filter(canReceiveActiveItem);
    const working = items.some(item => item.id === receivingItemId);
    const complete = !eligible.length && items.some(item => Number(item.returned_ok_quantity) + Number(item.returned_maintenance_quantity) > 0);
    return <div className={iconOnly ? styles.serialActions : styles.actions}>
      <span className={styles.correctionSlot}>
        <ReceivedCorrectionAction list={list} items={items} manager={manager} disabled={busy}
          onOpen={onCorrect} iconOnly />
      </span>
      {canReceive && eligible.length > 0 ? <button type="button" disabled={busy}
        className={iconOnly ? styles.receiveIcon : styles.receiveButton}
        onClick={() => receiveGroup(items)} title={iconOnly ? "Receive this serial unit" : "Receive returned equipment"}
        aria-label={`Receive ${items[0]?.display_name || "equipment"}${iconOnly ? ` · ID ${activeSerialReference(items[0]).id}` : ""}`}>
        {working ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
        {!iconOnly ? <span>Received</span> : null}
      </button> : complete ? <span className={styles.complete} title="All equipment on this line has returned"><Check size={14} /><span className={styles.srOnly}>Returned</span></span> : <span />}
    </div>;
  }

  function metricCells(items: EquipmentListItem[]) {
    const numbers = activeRowCounts(items);
    const format = (value: number) => activeQuantityText(value, numbers.squareMetres);
    return <>
      <td className={styles.metric} data-label="Sent"><span className={styles.mobileLabel}>Sent</span><span>{format(numbers.sent)}</span></td>
      <td className={`${styles.metric} ${styles.received}`} data-label="Received">
        <span className={styles.mobileLabel}>Received</span><span>{numbers.custom ? "—" : format(numbers.received)}</span>
        {numbers.maintenance > 0 ? <small className={styles.repairNote}>{numbers.maintenance} to repair</small> : null}
      </td>
      <td className={`${styles.metric} ${styles.out}`} data-label="Out"><span className={styles.mobileLabel}>Out</span><span>{numbers.custom ? "—" : format(numbers.outside)}</span></td>
    </>;
  }

  function serialTable(group: ActiveEquipmentGroup) {
    return <tr className={styles.detailsRow} id={`active-serials-${list.id}-${group.key}`}>
      <td colSpan={5} className={styles.detailsCell}>
        <div className={styles.serialPanel}>
          <div className={styles.serialToolbar}>
            <span>Serial / Unit ID</span>
            <label className={styles.pdfPreference}>
              <input type="checkbox" checked={!props.hiddenSerialPdfKeys.has(group.key)} onChange={() => props.onToggleSerialPdf(group.key)} />
              IDs / serials in PDF
            </label>
          </div>
          <table className={styles.serialTable} aria-label={`${group.displayName} serial units`}>
            <colgroup><col className={styles.serialIdCol} /><col /><col className={styles.serialStatusCol} /><col className={styles.serialActionCol} /></colgroup>
            <thead><tr><th scope="col">ID</th><th scope="col">Serial</th><th scope="col">Status</th><th scope="col" className={styles.actionHeading}>Actions</th></tr></thead>
            <tbody>{group.items.map(item => {
              const reference = activeSerialReference(item), status = activeSerialStatus(item);
              return <tr key={item.id} data-serial-item={item.id}>
                <td>{reference.id}</td><td className={styles.serialNumber}>{reference.serial}</td>
                <td><span className={styles[status.tone]}>{status.label}</span></td>
                <td>{actionCells([item], true)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </td>
    </tr>;
  }

  return <div className={styles.root} data-active-equipment-table>
    <table className={styles.equipmentTable} aria-label="Active list equipment and returns">
      <colgroup><col /><col className={styles.quantityCol} /><col className={styles.quantityCol} /><col className={styles.quantityCol} /><col className={styles.actionCol} /></colgroup>
      <thead className={styles.equipmentHead}><tr><th scope="col">Equipment</th><th scope="col">Sent</th><th scope="col">Received</th><th scope="col">Out</th><th scope="col" className={styles.actionHeading}>Actions</th></tr></thead>
      <tbody>{groups.map((group, index) => {
        const first = group.items[0];
        if (!first) return null;
        const presentation = props.presentGroup(group), kind = activeGroupKind(group);
        const previousCategory = index > 0 ? props.presentGroup(groups[index - 1]).category : "";
        const open = expanded.has(group.key);
        return <Fragment key={group.key}>
          {presentation.category !== previousCategory ? <tr className={styles.categoryRow}><th colSpan={5} scope="rowgroup">{presentation.category}</th></tr> : null}
          <tr className={`${styles.equipmentRow} ${kind === "lengths" ? styles.lengthHeading : ""}`} data-active-equipment-group={group.key}>
            <td className={styles.identityCell}>
              <div className={styles.identity}>
                {presentation.photoUrl ? <img src={presentation.photoUrl} alt="" className={styles.photo} loading="lazy" />
                  : <span className={styles.photoPlaceholder}><PackageCheck size={19} /></span>}
                <div className={styles.nameBlock}>
                  <div className={styles.itemName}>{presentation.brand ? <><strong>{presentation.brand}</strong>{presentation.model ? ` ${presentation.model}` : ""}</> : <strong>{presentation.primaryName}</strong>}</div>
                  {presentation.description ? <p className={styles.description}>{presentation.description}</p> : null}
                  {presentation.cabinetDetail ? <p className={styles.secondary}>{presentation.cabinetDetail}</p> : null}
                  {presentation.secondary ? <p className={styles.secondary}>{presentation.secondary}</p> : null}
                  {presentation.rackContents ? <p className={styles.secondary}>{presentation.rackContents}</p> : null}
                  {kind === "serial" ? <button type="button" className={styles.disclosure}
                    aria-expanded={open} aria-controls={`active-serials-${list.id}-${group.key}`} onClick={() => toggleSerials(group.key)}>
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {group.items.length} {group.items.length === 1 ? "serial" : "serials"}
                  </button> : null}
                </div>
              </div>
            </td>
            {kind === "lengths" ? <><td className={styles.emptyMetric} /><td className={styles.emptyMetric} /><td className={styles.emptyMetric} /></> : metricCells(group.items)}
            <td className={styles.actionCell}>{kind === "lengths" || kind === "custom" ? null : actionCells(group.items)}</td>
          </tr>
          {kind === "lengths" ? group.items.map((item, itemIndex) => <tr key={item.id} className={`${styles.equipmentRow} ${styles.lengthRow}`} data-active-length={item.id}>
            <td className={styles.identityCell}><div className={styles.lengthLabel}>{String(item.metadata?.row_label || `Line ${itemIndex + 1}`)}</div></td>
            {metricCells([item])}<td className={styles.actionCell}>{actionCells([item])}</td>
          </tr>) : null}
          {kind === "serial" && open ? serialTable(group) : null}
        </Fragment>;
      })}</tbody>
    </table>

    {receivingGroup && typeof document !== "undefined" ? createPortal(
      <div className={styles.pickerOverlay} role="dialog" aria-modal="true" aria-label="Choose equipment to receive"
        onKeyDown={event => {
          if (event.key === "Escape" && !busy) setReceivingGroupKey(null);
          if (event.key === "Tab") {
            const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
            const first = buttons.item(0), last = buttons.item(buttons.length - 1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <button type="button" className={styles.pickerBackdrop} aria-label="Close serial picker" disabled={busy} onClick={() => setReceivingGroupKey(null)} />
        <div className={styles.picker}>
          <div className={styles.pickerHeading}><div><h2>Receive equipment</h2><p>{receivingGroup.displayName}</p></div>
            <button type="button" autoFocus className={styles.closeButton} aria-label="Close" disabled={busy} onClick={() => setReceivingGroupKey(null)}><X size={17} /></button>
          </div>
          <p className={styles.pickerHelp}>Choose the exact returned equipment. Nothing changes until you confirm Received.</p>
          <div className={styles.pickerRows}>
            {receivingGroup.items.filter(canReceiveActiveItem).map((item, index) => {
              const reference = activeSerialReference(item);
              const serialGroup = activeGroupKind(receivingGroup) === "serial";
              return <div key={item.id} className={styles.pickerRow}><div>
                <strong>{serialGroup ? `ID ${reference.id}` : String(item.metadata?.row_label || `Delivery ${index + 1}`)}</strong>
                <span>{serialGroup ? reference.serial : `${activeLineOutside(item)} units Out`}</span>
              </div>
                <button type="button" disabled={busy || !canReceive} className={styles.receiveButton} onClick={() => {
                  if (busy || !canReceive || !canReceiveActiveItem(item)) return;
                  setReceivingGroupKey(null); onReceive(item);
                }}><RotateCcw size={14} /><span>Received</span></button>
              </div>;
            })}
            {!receivingGroup.items.some(canReceiveActiveItem) ? <p className={styles.pickerHelp}>All equipment in this group has already returned.</p> : null}
          </div>
        </div>
      </div>, document.body) : null}
  </div>;
}
