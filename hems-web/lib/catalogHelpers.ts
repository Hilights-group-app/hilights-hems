// lib/catalogHelpers.ts

export function titleFromSlug(slug?: string) {
  if (!slug) return "Subcategory";

  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}