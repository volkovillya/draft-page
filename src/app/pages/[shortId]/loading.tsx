export default function Loading() {
  return (
    <div className="flex h-dvh flex-col bg-canvas" role="status" aria-busy="true" aria-label="Loading review">
      <div className="flex h-12 items-center gap-3 border-b border-line px-3">
        <div className="size-6 animate-pulse rounded-md bg-hover" />
        <div className="h-4 w-44 animate-pulse rounded bg-hover" />
        <div className="ml-auto h-8 w-24 animate-pulse rounded-lg bg-hover" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 animate-pulse bg-panel" />
        <div className="w-[340px] border-l border-line bg-panel max-md:hidden" />
      </div>
    </div>
  );
}
