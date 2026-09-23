import { requireSession } from "@/lib/authz";
import { AppShell } from "@/components/app-shell";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "@/components/ui-kit/client";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  // ConfirmProvider/ToastProvider mount once here so every (app) page can
  // call useConfirm()/useToast() without its own provider boilerplate —
  // Task B-D's dialogs and action feedback consume these.
  //
  // TooltipProvider is here for a second reason as well as convenience: it
  // is what shares one delay across every tooltip on screen, so moving along
  // a row of icon buttons opens the second one immediately instead of
  // waiting out the full delay again. Per-row providers would each keep
  // their own timer and lose that.
  return (
    <ToastProvider>
      <ConfirmProvider>
        <TooltipProvider>
          <AppShell user={session.user}>{children}</AppShell>
        </TooltipProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
