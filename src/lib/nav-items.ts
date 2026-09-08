import { FileText, FileCheck, Users, Package, Settings } from "lucide-react";

// Shared between the dashboard cards ((app)/page.tsx) and the app shell's
// nav (sidebar on md+, bottom bar on mobile) so both stay in sync with a
// single source of truth.
export const NAV_ITEMS = [
  {
    href: "/quotes",
    label: "Quotes",
    description: "Customer quotations",
    icon: FileText,
  },
  {
    href: "/clients",
    label: "Clients",
    description: "Manage your customers",
    icon: Users,
  },
  {
    href: "/catalog",
    label: "Catalog",
    description: "Products and pricing",
    icon: Package,
  },
  // No role gating here, deliberately: every signed-in user sees every entry,
  // and that is right for this one. A MANAGER may READ the legal text their
  // own client is about to sign — `/settings/content`, the admin-only screen
  // this replaces, hid it from them entirely, which is the defect the
  // Documents section fixes. What a manager may not do is edit it, and that
  // is gated on the two pages themselves (no editor, no palette, no Save, no
  // region create/delete, no drag handles) rather than on the route.
  {
    href: "/documents",
    label: "Documents",
    description: "Terms and conditions",
    icon: FileCheck,
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Account and preferences",
    icon: Settings,
  },
] as const;
