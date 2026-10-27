import styles from "./EquipmentListHeader.module.css";

type Props = {
  reference: string;
  typeLabel: string;
  title: string;
  details: string;
  statusLabel: string;
  statusClassName: string;
  dates: readonly { label: string; value: string }[];
};

// Read-only phone presentation. Scheduling, permissions and actions stay in
// EquipmentListDetailsClient; desktop keeps its original header.
export default function CompactListHeading({
  reference, typeLabel, title, details, statusLabel, statusClassName, dates,
}: Props) {
  return (
    <div className={styles.mobileHeading} data-compact-list-heading>
      <div className={styles.referenceRow}>
        <span className={styles.reference}>{reference}</span>
        <span className={`${styles.status} ${statusClassName}`}>{statusLabel}</span>
      </div>
      <h1 className={styles.title}>{title}</h1>
      {title !== typeLabel ? <div className={styles.type}>{typeLabel}</div> : null}
      {details && details !== title ? <p className={styles.details}>{details}</p> : null}
      {dates.length ? (
        <dl className={styles.dates}>
          {dates.map(row => (
            <div key={row.label}>
              <dt>{row.label.replace(/ Date$/, "")}:</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
