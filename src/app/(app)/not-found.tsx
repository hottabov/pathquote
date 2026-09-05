import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

/**
 * What every `notFound()` in the signed-in area renders. Most of them are
 * reached not by a mistyped URL but by a MANAGER opening something that is
 * out of their scope — another manager's document or company, a hidden
 * series, an admin-only settings page — which is exactly why the wording
 * stays on "doesn't exist or isn't yours to open": those pages 404 rather
 * than 403 precisely so the two cases can't be told apart (see
 * `documentWhereForUser`'s callers), and a message that said "you don't have
 * access" would give away the difference this whole convention hides.
 */
export default function AppNotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Not found"
      description="This page doesn't exist, or isn't yours to open."
      action={
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4")}>
          Back to dashboard
        </Link>
      }
    />
  );
}
