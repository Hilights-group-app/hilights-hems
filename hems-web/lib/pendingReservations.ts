export type PendingReservation = { record_type: "unit" | "matrix_model" | "matrix_row";
  record_id: string; parent_id: string | null; quantity: number; available_quantity?: number };

export function reservationIndex(rows: PendingReservation[]) {
  const records = new Map<string, number>(), parents = new Map<string, number>();
  for (const row of rows) {
    const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
    const key = `${row.record_type}:${row.record_id}`;
    records.set(key, (records.get(key) || 0) + quantity);
    if (row.parent_id) {
      const parent = `${row.record_type}:${row.parent_id}`;
      parents.set(parent, (parents.get(parent) || 0) + Math.max(0,Math.floor(Number(row.available_quantity ?? quantity) || 0)));
    }
  }
  return {
    quantity: (type: string, id: string) => records.get(`${type}:${id}`) || 0,
    parent: (type: string, id: string) => parents.get(`${type}:${id}`) || 0,
  };
}
export function availableAfterReservations(physicalAvailable: number, reserved: number, ownPending = 0) {
  return Math.max(0, physicalAvailable - Math.max(0, reserved - ownPending));
}
export function withReservedStats<T extends { available: number }>(stats: T, reserved: number) {
  return { ...stats, available: availableAfterReservations(stats.available, reserved), reserved };
}
