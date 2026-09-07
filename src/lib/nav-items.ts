import { FileText, Users, Package, Settings } from "lucide-react";

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
  {
    href: "/settings",
    label: "Settings",
    description: "Account and preferences",
    icon: Settings,
  },
] as const;
