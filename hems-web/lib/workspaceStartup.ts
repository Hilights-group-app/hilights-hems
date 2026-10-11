import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/authStore";
import type { Catalog } from "@/lib/catalogStore";
import type { EquipmentList } from "@/lib/equipmentLists";

type WorkspaceProfile = { role: string; department: string | null; avatar_url: string | null; full_name: string | null };
type ReadResult<T> = { data: T | null; error: any };
const profileCache = new Map<string, { result: ReadResult<WorkspaceProfile>; at: number }>();
const profileRequests = new Map<string, Promise<ReadResult<WorkspaceProfile>>>();
const draftCache = new Map<string, { result: ReadResult<EquipmentList>; at: number }>();
const draftRequests = new Map<string, Promise<ReadResult<EquipmentList>>>();

export function readWorkspaceProfile(client: SupabaseClient, userId: string) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.at < 15000) return Promise.resolve(cached.result);
  const pending = profileRequests.get(userId);
  if (pending) return pending;
  const request = (async () => {
    const result = await client.from("profiles").select("role,department,avatar_url,full_name").eq("id", userId).maybeSingle();
    if (!result.error && result.data) profileCache.set(userId, { result, at: Date.now() });
    return result as ReadResult<WorkspaceProfile>;
  })().finally(() => profileRequests.delete(userId));
  profileRequests.set(userId, request);
  return request;
}

export function readWorkingDraft(client: SupabaseClient, listId: string, force = false, userId = getUserId()) {
  if (!userId) return Promise.resolve({ data: null, error: null } as ReadResult<EquipmentList>);
  const key = `${userId}:${listId}`;
  const cached = draftCache.get(key);
  if (!force && cached && Date.now() - cached.at < 10000) return Promise.resolve(cached.result);
  const pending = draftRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const result = await client.from("equipment_lists").select("*").eq("id", listId).maybeSingle();
    if (!result.error) draftCache.set(key, { result, at: Date.now() });
    return result as ReadResult<EquipmentList>;
  })().finally(() => draftRequests.delete(key));
  draftRequests.set(key, request);
  return request;
}

/** Route metadata only: no units, equipment photos or full stock are loaded. */
export function seedCatalogRoutes(catalog: Catalog) {
  if (typeof window === "undefined") return;
  const supported = new Set(["matrix", "fixture_units", "chain_hoist_units", "projector_units", "lens_units", "led_screen_units"]);
  try {
    for (const category of catalog.categories) for (const sub of category.subcategories) {
      sessionStorage.setItem(`hems:route:${category.slug}:${sub.slug}`, JSON.stringify({
        categoryId: category.id, subcategoryId: sub.id,
        type: supported.has(sub.type ?? "") ? sub.type : "fixture_units",
      }));
    }
  } catch { /* Route resolution can still use the warmed in-memory catalog. */ }
}
