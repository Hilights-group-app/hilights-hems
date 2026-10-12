import type { EquipmentListItem } from "@/lib/equipmentLists";

export function draftGroupRank(items: EquipmentListItem[]): number {
  const ranks = items.map((item) => item.draft_sort_order)
    .filter((rank): rank is number => typeof rank === "number" && Number.isFinite(rank) && rank >= 0);
  return ranks.length ? Math.min(...ranks) : Infinity;
}

export function moveDraftGroup<T extends { key: string }>(
  groups: T[], sourceKey: string, targetKey: string, position: "before" | "after",
): T[] {
  const source = groups.find((group) => group.key === sourceKey);
  if (!source || sourceKey === targetKey || !groups.some((group) => group.key === targetKey)) return groups;
  const next = groups.filter((group) => group.key !== sourceKey);
  const index = next.findIndex((group) => group.key === targetKey);
  next.splice(index + (position === "after" ? 1 : 0), 0, source);
  return next;
}
