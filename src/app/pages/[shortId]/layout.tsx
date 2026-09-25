import type { ReactNode } from "react";
import { loadPage } from "./load-page";

/**
 * Checks the page exists before the loading skeleton streams. Once streaming starts the
 * status is fixed at 200, so a missing page must 404 here, above the loading boundary.
 */
export default async function ReviewLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ shortId: string }>;
}) {
  await loadPage((await params).shortId);
  return children;
}
