export default function InventoryRouteLoading() {
  return (
    <div role="status" aria-label="Loading equipment page" className="flex min-h-[35vh] items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-5">
        <img src="/logo-icon.png" alt="" width={40} height={40} className="h-10 w-10 object-contain" />
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600 motion-reduce:animate-none" />
        <span className="sr-only">Loading equipment page…</span>
      </div>
    </div>
  );
}
