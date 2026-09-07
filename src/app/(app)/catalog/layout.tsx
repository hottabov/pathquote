import type { ReactNode } from "react";
import { requireRegion } from "@/lib/authz";

/**
 * Catalogue prices are per region, so a manager without one is redirected
 * to /no-region before any page under this area renders. Guarding the
 * segment rather than each page means a new sub-route inherits this.
 */
export default async function CatalogLayout({ children }: { children: ReactNode }) {
  await requireRegion();
  return <>{children}</>;
}
