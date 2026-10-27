import type { EquipmentList, EquipmentListType } from "./equipmentLists";
import { createRefreshQueue } from "./workspaceRefresh";

export const CLOSED_LIST_FOLDERS: readonly {
  key: string; label: string; listTypes: readonly EquipmentListType[];
}[] = [
  { key: "shipment", label: "Shipment", listTypes: ["transfer_out", "transfer_in"] },
  { key: "local_event", label: "Local Event", listTypes: ["local_event"] },
  { key: "dry_hire", label: "Dry Hire", listTypes: ["dry_hire"] },
  { key: "maintenance", label: "Maintenance", listTypes: ["maintenance"] },
];
export type ClosedListFolder = typeof CLOSED_LIST_FOLDERS[number];
export const CLOSED_FOLDER_PAGE_SIZE = 30;
export function belongsToClosedFolder(list: EquipmentList, folder: ClosedListFolder) {
  return list.status === "closed" && folder.listTypes.includes(list.list_type);
}

export type ClosedFolderState = {
  rows: EquipmentList[]; loaded: boolean; loading: boolean; hasMore: boolean; error: string;
};
export const emptyClosedFolder = (): ClosedFolderState => ({
  rows: [], loaded: false, loading: false, hasMore: false, error: "",
});

// Lazy, owner-scoped paging. Uses the same single-flight/hidden-tab queue as
// the working lists, without adding a Realtime subscription or polling timer.
export function createClosedFolderController(options: {
  folder: ClosedListFolder;
  read: (offset: number, pageSize: number) => Promise<EquipmentList[]>;
  publish: (state: ClosedFolderState) => void;
  isCurrent: () => boolean;
  isVisible: () => boolean;
}) {
  let state = emptyClosedFolder();
  let open = false, disposed = false, dirty = true, wantsMore = false;
  let revision = 0, offset = 0, loadedAt = 0;
  const current = () => !disposed && options.isCurrent();
  const publish = (patch: Partial<ClosedFolderState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    options.publish(state);
  };
  const queue = createRefreshQueue(async () => {
    if (!current() || !open) return;
    const readRevision = revision;
    const start = !dirty && state.loaded && wantsMore ? offset : 0;
    wantsMore = false;
    publish({ loading: true, error: "" });
    try {
      const result = await options.read(start, CLOSED_FOLDER_PAGE_SIZE);
      if (!current() || readRevision !== revision) return;
      const page = result.slice(0, CLOSED_FOLDER_PAGE_SIZE);
      const merged = new Map<string, EquipmentList>();
      for (const list of [...(start ? state.rows : []), ...page]) {
        if (belongsToClosedFolder(list, options.folder)) merged.set(list.id, list);
      }
      offset = start + page.length;
      dirty = false;
      loadedAt = Date.now();
      publish({ rows: [...merged.values()], loaded: true, loading: false,
        hasMore: result.length > CLOSED_FOLDER_PAGE_SIZE, error: "" });
    } catch {
      if (!current() || readRevision !== revision) return;
      wantsMore = start > 0;
      publish({ loading: false, error: "Closed lists could not be loaded. Please try again." });
    }
  }, { isVisible: () => current() && open && options.isVisible() });
  return {
    setOpen(value: boolean) {
      open = value;
      if (!open || !current()) return;
      if (dirty || !state.loaded || Date.now() - loadedAt > 30000) {
        dirty = true; wantsMore = false; queue.request();
      } else queue.resume();
    },
    invalidate() {
      revision++; dirty = true; wantsMore = false;
      if (open && current()) queue.schedule();
    },
    loadMore() {
      if (!open || !current() || !state.loaded || state.loading || !state.hasMore) return;
      wantsMore = true; queue.request();
    },
    retry() { if (open && current()) queue.request(); },
    wake() {
      if (!current() || !open || !options.isVisible()) return;
      queue.resume();
      if (!queue.isPending() && Date.now() - loadedAt > 30000) {
        dirty = true; wantsMore = false; queue.request();
      }
    },
    dispose() { disposed = true; queue.dispose(); },
  };
}
