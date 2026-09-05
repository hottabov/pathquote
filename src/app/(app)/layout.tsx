import { requireSession } from "@/lib/authz";
import { AppShell } from "@/components/app-shell";
import { ConfirmProvider, ToastProvider } from "@/components/ui-kit/client";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  // ConfirmProvider/ToastProvider mount once here so every (app) page can
  // call useConfirm()/useToast() without its own provider boilerplate —
  // Task B-D's dialogs and action feedback consume these.
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppShell user={session.user}>{children}</AppShell>
      </ConfirmProvider>
    </ToastProvider>
  );
}
