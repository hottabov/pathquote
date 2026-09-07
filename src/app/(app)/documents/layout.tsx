import type { ReactNode } from "react";
import { requireRegion } from "@/lib/authz";

/**
 * Every quote belongs to a region, so a manager without one is redirected
 * to /no-region before any page under this area renders. Guarding the
 * segment rather than each page means a new sub-route inherits this.
 */
export default async function DocumentsLayout({ children }: { children: ReactNode }) {
  await requireRegion();
  return <>{children}</>;
}
