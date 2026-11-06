export type ImportPhotoResult = { url: string | null; error?: string; permissionDenied?: boolean };

/** A saved inventory thumbnail, not merely any URL containing 'supabase'. */
export function isInventoryStoragePhoto(value: unknown, projectUrl: string): value is string {
  if (typeof value !== "string" || !projectUrl) return false;
  try {
    const url = new URL(value), project = new URL(projectUrl);
    const folder = "/storage/v1/object/public/equipment-photos/items/thumbs/";
    return url.origin === project.origin && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(folder) && url.pathname.length > folder.length;
  } catch { return false; }
}

/** One import-run cache. Never write an external URL if download/upload failed.
 * The same source across several Excel rows is copied only once per run. */
export function createImportPhotoResolver(projectUrl: string, request: typeof fetch = fetch) {
  const cache = new Map<string, Promise<ImportPhotoResult>>();
  async function save(source: string): Promise<ImportPhotoResult> {
    if (source.length > 4096 || !/^https?:\/\//i.test(source)) {
      return { url: null, error: "Use an HTTP(S) image URL, or upload this photo from your device later." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 32000);
    try {
      const response = await request("/api/optimize-image", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl: source }), signal: controller.signal,
      });
      const data: unknown = await response.json().catch(() => null);
      const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
      if (!response.ok) return {
        url: null, permissionDenied: response.status === 401 || response.status === 403,
        error: typeof body.error === "string" ? body.error.slice(0, 240) : "The photo could not be saved. Upload it from your device later.",
      };
      if (!isInventoryStoragePhoto(body.url, projectUrl)) return {
        url: null, error: "The photo service did not return a saved Supabase inventory photo. Upload it from your device later.",
      };
      return { url: body.url };
    } catch {
      return { url: null, error: "Photo download/upload failed or timed out. Upload it from your device later." };
    } finally { clearTimeout(timer); }
  }
  return {
    resolve(value: unknown): Promise<ImportPhotoResult> {
      const source = typeof value === "string" ? value.trim() : "";
      if (!source) return Promise.resolve({ url: null });
      let pending = cache.get(source);
      if (!pending) { pending = save(source); cache.set(source, pending); }
      return pending;
    },
  };
}
