import { createClient } from "@/lib/supabase/client";

export type UserRole =
  | "admin"
  | "warehouse_manager"
  | "head"
  | "viewer";

const ROLE_KEY = "hems:user_role";
const NAME_KEY = "hems:user_name";
const DEPT_KEY = "hems:user_department";

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
    role === "warehouse_manager" ||
    role === "head"
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