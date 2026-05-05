export default function Loading() {
  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="mx-auto max-w-[1100px] space-y-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-gray-200 bg-white px-4 py-4 shadow-sm"
          >
            <div className="mb-3 h-5 w-40 animate-pulse rounded bg-gray-200" />

            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 5 }).map((_, j) => (
                <div
                  key={j}
                  className="h-9 w-28 animate-pulse rounded-full bg-gray-200"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}