import SubcategoryRouterClient from "@/components/SubcategoryRouterClient";

export default async function Page({
  params,
}: {
  params: Promise<{ category: string; subcategory: string }>;
}) {
  const { category, subcategory } = await params;

  return <SubcategoryRouterClient key={`${category}:${subcategory}`} category={category} subcategory={subcategory} />;
}