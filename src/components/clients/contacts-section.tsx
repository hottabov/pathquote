"use client";

import { useState, useTransition } from "react";
import { Star, Pencil, Trash2, Plus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContactForm } from "@/components/clients/contact-form";
import {
  TableShell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  EmptyState,
} from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { ActionResult, createContact, updateContact, deleteContact } from "@/lib/actions/clients";
import type { ContactDetail } from "@/lib/queries/clients";

type Actions = {
  createContact: typeof createContact;
  updateContact: typeof updateContact;
  deleteContact: typeof deleteContact;
};

/**
 * The contacts panel on a company's editor: a responsive list of existing
 * contacts (desktop table / mobile cards, each with an inline edit toggle,
 * a one-click "make primary" star, and a confirm-gated delete) plus an
 * always-available "add contact" form. All state here is purely UI (which
 * row is being edited, whether the add form is open) — the actual contact
 * data comes from the server component parent and refreshes automatically
 * after any action revalidates `/clients/[id]`.
 */
export function ContactsSection({
  companyId,
  contacts,
  actions,
  defaultCountry,
}: {
  companyId: string;
  contacts: ContactDetail[];
  actions: Actions;
  /** The company's own country, ISO alpha-2 — which country each contact's
   * phone field opens on. See `PhoneField`. */
  defaultCountry?: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const addForm = addOpen ? (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
      <ContactForm
        idPrefix="contact-new"
        action={actions.createContact.bind(null, companyId)}
        defaultValues={{
          firstName: "",
          lastName: "",
          email: "",
          phone: "",
          position: "",
          isPrimary: contacts.length === 0,
        }}
        submitLabel="Add contact"
        defaultCountry={defaultCountry}
        onDone={() => setAddOpen(false)}
        onCancel={() => setAddOpen(false)}
      />
    </div>
  ) : (
    <Button
      type="button"
      variant="outline"
      onClick={() => setAddOpen(true)}
      className="h-11 w-full sm:w-fit"
    >
      <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
      Add contact
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {contacts.length === 0 ? (
        <EmptyState icon={UserRound} title="No contacts yet" description="Add the first one below." />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Position
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Email / phone
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) =>
                  editingId === contact.id ? (
                    <tr key={contact.id} className={tableRowClassName}>
                      <td colSpan={4} className="p-4">
                        <ContactForm
                          idPrefix={`contact-${contact.id}`}
                          action={actions.updateContact.bind(null, contact.id)}
                          defaultValues={{
                            firstName: contact.firstName,
                            lastName: contact.lastName ?? "",
                            email: contact.email ?? "",
                            phone: contact.phone ?? "",
                            position: contact.position ?? "",
                            isPrimary: contact.isPrimary,
                          }}
                          submitLabel="Save contact"
                          defaultCountry={defaultCountry}
                          onDone={() => setEditingId(null)}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  ) : (
                    <ContactTableRow
                      key={contact.id}
                      contact={contact}
                      onEdit={() => setEditingId(contact.id)}
                      makePrimary={actions.updateContact}
                      onDelete={actions.deleteContact}
                    />
                  )
                )}
              </tbody>
            </table>
          }
          cards={contacts.map((contact) =>
            editingId === contact.id ? (
              <div key={contact.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <ContactForm
                  idPrefix={`contact-${contact.id}-mobile`}
                  action={actions.updateContact.bind(null, contact.id)}
                  defaultValues={{
                    firstName: contact.firstName,
                    lastName: contact.lastName ?? "",
                    email: contact.email ?? "",
                    phone: contact.phone ?? "",
                    position: contact.position ?? "",
                    isPrimary: contact.isPrimary,
                  }}
                  submitLabel="Save contact"
                  defaultCountry={defaultCountry}
                  onDone={() => setEditingId(null)}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : (
              <ContactCard
                key={contact.id}
                contact={contact}
                onEdit={() => setEditingId(contact.id)}
                makePrimary={actions.updateContact}
                onDelete={actions.deleteContact}
              />
            )
          )}
        />
      )}

      {addForm}
    </div>
  );
}

function useMakePrimary(
  contact: ContactDetail,
  makePrimary: (contactId: string, formData: FormData) => Promise<ActionResult>
) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function handleMakePrimary() {
    if (contact.isPrimary || pending) return;
    const formData = new FormData();
    formData.set("firstName", contact.firstName);
    formData.set("lastName", contact.lastName ?? "");
    formData.set("email", contact.email ?? "");
    formData.set("phone", contact.phone ?? "");
    formData.set("position", contact.position ?? "");
    formData.set("isPrimary", "on");
    startTransition(async () => {
      const result = await makePrimary(contact.id, formData);
      if (!result?.error) {
        const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
        toast.success(`${fullName} is now the primary contact`);
      }
    });
  }

  return { pending, handleMakePrimary };
}

function useDeleteContact(
  contact: ContactDetail,
  onDelete: (contactId: string) => Promise<ActionResult>
) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");

  function handleDelete() {
    if (pending) return;
    void (async () => {
      const confirmed = await confirm({
        title: `Delete ${fullName}?`,
        description: "This can't be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      });
      if (!confirmed) return;

      setError(null);
      startTransition(async () => {
        const result = await onDelete(contact.id);
        if (result?.error) {
          setError(result.error);
          return;
        }
        toast.success(`Deleted ${fullName}`);
      });
    })();
  }

  return { pending, error, handleDelete, fullName };
}

function PrimaryStarButton({ contact, pending, onClick }: { contact: ContactDetail; pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={contact.isPrimary}
      aria-label={contact.isPrimary ? "Primary contact" : "Make primary contact"}
      className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed"
    >
      <Star
        className={cn("size-4", contact.isPrimary ? "fill-brand text-brand" : "text-slate-400")}
        aria-hidden="true"
      />
    </button>
  );
}

function ContactTableRow({
  contact,
  onEdit,
  makePrimary,
  onDelete,
}: {
  contact: ContactDetail;
  onEdit: () => void;
  makePrimary: (contactId: string, formData: FormData) => Promise<ActionResult>;
  onDelete: (contactId: string) => Promise<ActionResult>;
}) {
  const { pending: primaryPending, handleMakePrimary } = useMakePrimary(contact, makePrimary);
  const { pending: deletePending, error, handleDelete, fullName } = useDeleteContact(contact, onDelete);

  return (
    <tr className={tableRowClassName}>
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center gap-1">
          <PrimaryStarButton contact={contact} pending={primaryPending} onClick={handleMakePrimary} />
          <span className="font-medium text-brand-dark">{fullName}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-slate-600">{contact.position || "—"}</td>
      <td className="px-4 py-3 text-sm text-slate-600">
        {[contact.email, contact.phone].filter(Boolean).join(" · ") || "—"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label={`Edit ${fullName}`}
            className="focus-ring size-11 text-slate-400 hover:bg-slate-100 hover:text-brand-dark"
          >
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            disabled={deletePending}
            aria-label={`Delete ${fullName}`}
            className="focus-ring size-11 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-right text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function ContactCard({
  contact,
  onEdit,
  makePrimary,
  onDelete,
}: {
  contact: ContactDetail;
  onEdit: () => void;
  makePrimary: (contactId: string, formData: FormData) => Promise<ActionResult>;
  onDelete: (contactId: string) => Promise<ActionResult>;
}) {
  const { pending: primaryPending, handleMakePrimary } = useMakePrimary(contact, makePrimary);
  const { pending: deletePending, error, handleDelete, fullName } = useDeleteContact(contact, onDelete);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-1">
          <PrimaryStarButton contact={contact} pending={primaryPending} onClick={handleMakePrimary} />
          <div className="min-w-0 pt-2.5">
            <p className="truncate font-medium text-brand-dark">{fullName}</p>
            {contact.position ? <p className="text-xs text-slate-500">{contact.position}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label={`Edit ${fullName}`}
            className="focus-ring size-11 text-slate-400 hover:bg-slate-100 hover:text-brand-dark"
          >
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            disabled={deletePending}
            aria-label={`Delete ${fullName}`}
            className="focus-ring size-11 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <p className="pl-11 text-sm text-slate-500">
        {[contact.email, contact.phone].filter(Boolean).join(" · ") || "No email or phone"}
      </p>
      {error ? (
        <p role="alert" className="pl-11 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
