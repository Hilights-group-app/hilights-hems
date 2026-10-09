import { createClient } from "@/lib/supabase/client";

export type UserRole =
  | "admin"
  | "warehouse_manager"
  | "head"
  | "viewer";

export type UserDepartment = "lighting" | "video" | "rigging";

const ROLE_KEY = "hems:user_role";
const NAME_KEY = "hems:user_name";
const DEPT_KEY = "hems:user_department";
const USER_ID_KEY = "hems:user_id";

export function setUserRole(role: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ROLE_KEY, role);
}

export function getUserRole(): UserRole | null {
  if (typeof window === "undefined") return null;
  const role = localStorage.getItem(ROLE_KEY);
  if (!role) return null;
  return role as UserRole;
}

export function setUserName(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(NAME_KEY, name);
}

export function getUserName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(NAME_KEY);
}

export function setUserId(userId: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_ID_KEY, userId);
}

export function getUserId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(USER_ID_KEY);
}

export function setUserDepartment(department: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(DEPT_KEY, department);
}

export function getUserDepartment(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(DEPT_KEY);
}

export function clearAuthStore() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(DEPT_KEY);
  localStorage.removeItem(USER_ID_KEY);
  localStorage.removeItem("hems:active-equipment-list-id");

  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith("hems:list-details:")) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Storage can be unavailable in private browsing mode.
  }
}

export async function logout() {
  const supabase = createClient();

  try {
    await supabase.auth.signOut();
  } finally {
    clearAuthStore();
  }
}

export function isAdmin(): boolean {
  return getUserRole() === "admin";
}

export function isWarehouseManager(): boolean {
  return getUserRole() === "warehouse_manager";
}

export function isViewer(): boolean {
  return getUserRole() === "viewer";
}

export function isHead(): boolean {
  return getUserRole() === "head";
}

export function canEditInventory(): boolean {
  const role = getUserRole();

  return (
    role === "admin" ||
    role === "warehouse_manager"
  );
}

export function canReorderInventory(): boolean {
  return getUserRole() === "admin";
}

export function canImportInventory(): boolean {
  return getUserRole() === "admin";
}

export function canCreateEquipmentLists(): boolean {
  return getUserRole() !== null;
}

export function canCreateMaintenanceLists(): boolean {
  const role = getUserRole();
  return role === "admin" || role === "warehouse_manager" || role === "head";
}

export function canManageEquipmentLists(): boolean {
  const role = getUserRole();
  return role === "admin" || role === "warehouse_manager";
}

export function canEditReportForDepartment(
  department: UserDepartment | null,
): boolean {
  const role = getUserRole();

  if (role === "admin") return true;
  if (role !== "head" || !department) return false;

  return getUserDepartment() === department;
}

export function inventoryDepartmentFromRoute(
  category: string,
  subcategory = "",
): UserDepartment | null {
  const route = `${category} ${subcategory}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (/\b(lighting|light|fixture|dimmer|console)\b/.test(route)) {
    return "lighting";
  }

  if (
    /\b(video|led|screen|projector|projection|media|server|network|processor|camera|lens)\b/.test(
      route,
    )
  ) {
    return "video";
  }

  if (/\b(rigging|truss|hoist|motor|lifting)\b/.test(route)) {
    return "rigging";
  }

  return null;
}

export function canEditReportForRoute(
  category: string,
  subcategory = "",
): boolean {
  return canEditReportForDepartment(
    inventoryDepartmentFromRoute(category, subcategory),
  );
}

export function canAccessReports(): boolean {
  const role = getUserRole();
  return (
    role === "admin" ||
    role === "warehouse_manager" ||
    role === "head" ||
    role === "viewer"
  );
}

export function canAccessSettings(): boolean {
  return getUserRole() === "admin";
}
