export type UnitReportStatusFilter =
  | "all"
  | "available"
  | "maintenance"
  | "assigned";

export type ChainValidityFilter = "all" | "valid" | "expired";

export type SerialPasteUnit = {
  id: string;
  serial: string | null;
};

export type SerialPasteAssignment<T extends SerialPasteUnit> = {
  serial: string;
  target: T | null;
};

export type SerialPastePlan<T extends SerialPasteUnit> = {
  assignments: SerialPasteAssignment<T>[];
  duplicateCount: number;
  ignoredBlankCount: number;
  overwriteCount: number;
};

function serialKey(value: string | null | undefined) {
  return String(value || "").trim().toLocaleLowerCase();
}

/**
 * Builds a safe sequential paste plan for a copied Excel serial-number column.
 * Existing serials outside the target row are never duplicated. Blank lines and
 * duplicate values in the pasted column are ignored.
 */
export function buildSerialPastePlan<T extends SerialPasteUnit>(
  units: T[],
  startUnitId: string,
  clipboardText: string,
): SerialPastePlan<T> {
  const rawLines = clipboardText.split(/\r\n|\n|\r/);
  const nonBlank = rawLines.map((line) => line.trim()).filter(Boolean);
  const ignoredBlankCount = Math.max(0, rawLines.length - nonBlank.length);
  const uniqueSerials: string[] = [];
  const pastedKeys = new Set<string>();
  let duplicateCount = 0;

  for (const serial of nonBlank) {
    const key = serialKey(serial);
    if (!key || pastedKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }
    pastedKeys.add(key);
    uniqueSerials.push(serial);
  }

  const startIndex = Math.max(
    0,
    units.findIndex((unit) => unit.id === startUnitId),
  );
  const occupied = new Map<string, Set<string>>();

  for (const unit of units) {
    const key = serialKey(unit.serial);
    if (!key) continue;
    const ids = occupied.get(key) ?? new Set<string>();
    ids.add(unit.id);
    occupied.set(key, ids);
  }

  const assignments: SerialPasteAssignment<T>[] = [];
  let cursor = startIndex;

  for (const serial of uniqueSerials) {
    const target = units[cursor] ?? null;
    const previousKey = serialKey(target?.serial);

    if (target && previousKey) {
      const previousIds = occupied.get(previousKey);
      previousIds?.delete(target.id);
      if (previousIds?.size === 0) occupied.delete(previousKey);
    }

    const nextKey = serialKey(serial);
    if (occupied.has(nextKey)) {
      duplicateCount += 1;

      if (target && previousKey) {
        const previousIds = occupied.get(previousKey) ?? new Set<string>();
        previousIds.add(target.id);
        occupied.set(previousKey, previousIds);
      }
      continue;
    }

    assignments.push({ serial, target });
    const targetKey = target?.id ?? `new:${assignments.length}`;
    occupied.set(nextKey, new Set([targetKey]));
    cursor += 1;
  }

  const overwriteCount = assignments.filter(
    ({ serial, target }) =>
      Boolean(target?.serial?.trim()) &&
      serialKey(target?.serial) !== serialKey(serial),
  ).length;

  return {
    assignments,
    duplicateCount,
    ignoredBlankCount,
    overwriteCount,
  };
}

export function isMultiLineSerialPaste(text: string) {
  return /\r|\n/.test(text);
}
