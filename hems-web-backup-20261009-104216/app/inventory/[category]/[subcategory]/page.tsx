import SubcategoryRouterClient from "@/components/SubcategoryRouterClient";

export default async function Page({
  params,
}: {
  params: Promise<{ category: string; subcategory: string }>;
}) {
  const { category, subcategory } = await params;

  return <SubcategoryRouterClient category={category} subcategory={subcategory} />;
}