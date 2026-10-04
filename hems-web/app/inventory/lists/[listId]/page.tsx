 // app/inventory/lists/[listId]/page.tsx
import { use } from "react";
import EquipmentListDetailsClient from "@/components/EquipmentListDetailsClient";

type ParamsObj = {
  listId: string;
};

export default function Page({
  params,
}: {
  params: ParamsObj | Promise<ParamsObj>;
}) {
  const resolvedParams =
    (params as Promise<ParamsObj>)?.then instanceof Function
      ? use(params as Promise<ParamsObj>)
      : (params as ParamsObj);

  return <EquipmentListDetailsClient listId={resolvedParams.listId} />;
}
