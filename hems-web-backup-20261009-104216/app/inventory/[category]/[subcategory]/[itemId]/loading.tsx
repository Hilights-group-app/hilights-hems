export default function Loading() {
  return (
    <div className="mx-auto w-full p-4 space-y-4">
      <div className="h-6 w-40 bg-gray-200 rounded animate-pulse" />

      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-gray-200 animate-pulse" />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 rounded-xl bg-gray-200 animate-pulse" />
        ))}
      </div>
    </div>
  );
}