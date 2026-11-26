export type PendingReservation = { record_type: "unit" | "matrix_model" | "matrix_row";
  record_id: string; parent_id: string | null; quantity: number; available_quantity?: number };

export type PlanningRow = { record_type: string; record_id: string; parent_id: string | null;
  available: number; own_available: number; physical_available: number };
export type PlanningAvailability = { enabled: boolean; rows: PlanningRow[] };
export function reservationIndex(rows: PendingReservation[], planning?: PlanningAvailability) {
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
  const plans = new Map<string, PlanningRow>(), adjustments = new Map<string, number>();
  if (planning?.enabled && Array.isArray(planning.rows)) for (const row of planning.rows) {
    const key = `${row.record_type}:${row.record_id}`;
    if (![row.available,row.own_available,row.physical_available].every(n=>Number.isFinite(n)&&n>=0)) continue;
    plans.set(key,row);
    const baseline = availableAfterReservations(row.physical_available,records.get(key)||0);
    if(row.parent_id){const parent=`${row.record_type}:${row.parent_id}`;
      adjustments.set(parent,(adjustments.get(parent)||0)+row.available-baseline);}
  }
  return {
    planning: planning?.enabled === true,
    available: (type:string,id:string,fallback:number,ownPending=false) => {
      const row=plans.get(`${type}:${id}`);
      return row ? (ownPending ? row.own_available : row.available) : fallback;
    },
    parentAdjustment: (type:string,id:string) => adjustments.get(`${type}:${id}`)||0,
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
