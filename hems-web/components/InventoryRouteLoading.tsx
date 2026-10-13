export default function InventoryRouteLoading() {
  return (
    <div role="status" aria-label="Loading equipment page" className="flex min-h-[160px] items-center justify-center bg-white">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600 motion-reduce:animate-none" aria-hidden="true" />
      <span className="sr-only">Loading equipment page…</span>
    </div>
  );
}
