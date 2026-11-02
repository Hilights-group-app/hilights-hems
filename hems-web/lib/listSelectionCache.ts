/** Shared read cache. Invalidations survive inventory component unmounts. */
export function createListSelectionCache<T>() {
  type Entry = { listId: string; revision: number; value?: T; request?: Promise<T> };
  const entries = new Map<string, Entry>();
  let watching = false;
  const key = (owner: string, listId: string) => JSON.stringify([owner, listId]);
  function entry(owner: string, listId: string) {
    const id = key(owner, listId);
    let current = entries.get(id);
    if (!current) {
      current = { listId, revision: 0 };
      entries.set(id, current);
    }
    return current;
  }
  function invalidate(listId?: string) {
    for (const current of entries.values()) {
      if (listId && current.listId !== listId) continue;
      current.revision++;
      delete current.value;
      delete current.request;
    }
  }
  function watch(target: EventTarget, eventName: string) {
    if (watching) return;
    watching = true;
    // Intentionally one module-lifetime listener, not one listener per row.
    // Invalidating memory never reads the server while inventory is unmounted.
    target.addEventListener(eventName, (event) => {
      const detail = (event as CustomEvent<{ listId?: string; matrixLinesCached?: boolean }>).detail;
      if (!detail?.matrixLinesCached) invalidate(detail?.listId);
    });
  }
  function read(owner: string, listId: string, load: () => Promise<T>): Promise<T> {
    const current = entry(owner, listId);
    if (current.value !== undefined) return Promise.resolve(current.value);
    if (current.request) return current.request;
    const revision = current.revision;
    const request: Promise<T> = Promise.resolve().then(load).then(
      (value) => {
        // A slow old request must not restore 20 after an edit saved 10.
        if (revision !== current.revision) return read(owner, listId, load);
        current.value = value;
        return value;
      },
      (error) => {
        if (revision !== current.revision) return read(owner, listId, load);
        throw error;
      },
    ).finally(() => {
      if (current.request === request) delete current.request;
    });
    current.request = request;
    return request;
  }
  function update(owner: string, listId: string, change: (previous: T | undefined) => T | undefined) {
    const current = entry(owner, listId);
    const next = change(current.value);
    current.revision++;
    current.value = next;
    delete current.request;
  }
  return { read, update, invalidate, watch,
    has: (owner: string, listId: string) => entry(owner, listId).value !== undefined };
}
