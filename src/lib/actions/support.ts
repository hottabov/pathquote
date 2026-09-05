"use server";

import { revalidateSupport } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { supportMessageSchema } from "@/lib/validation/support";
import { resolveSupportRecipients } from "@/lib/support";
import { listActiveDevelopers } from "@/lib/queries/users";
import { getRegionById } from "@/lib/queries/catalog";
import { getAppVersion } from "@/lib/app-version";
import { buildSupportMessageEmail } from "@/lib/email/support-message";
import { resolveReplyTo } from "@/lib/email/reply-to";
import { createAppMailTransport, mailFromAddress } from "@/lib/email/transport";
import { flattenZodError, type ActionResultWithWarning } from "./_shared";

export type SupportActionResult = ActionResultWithWarning;

/**
 * Handles a PathQuote Support submission (Settings -> PathQuote Support,
 * open to any signed-in user — see src/lib/settings-nav.ts). The app
 * already knows who's asking, their role, and their region, so the form
 * only ever collects a subject and a message; everything else attached
 * below is context the sender never has to type.
 *
 * Order matters here and is deliberate:
 *   1. Validate the form fields.
 *   2. Resolve recipients (`resolveSupportRecipients`) *before* writing
 *      anything — if nobody holds the DEVELOPER role, this refuses plainly
 *      and stores nothing, rather than accepting a report that can never
 *      reach anyone.
 *   3. Store the message. This happens before the email send is attempted,
 *      not after — a misconfigured SMTP transport (a real, documented risk
 *      here — see docs/email-sending-setup.md) must never mean the report
 *      simply vanishes. `emailedAt`/`emailError` are filled in afterwards.
 *   4. Attempt the email, via the exact transport auth.ts's magic-link flow
 *      already uses (see src/lib/email/transport.ts). A failure here is
 *      recorded on the row and returned as a `warning`, not an `error` —
 *      the report itself was not lost, only the notification.
 */
export async function submitSupportMessage(formData: FormData): Promise<SupportActionResult> {
  const session = await requireSession();

  const parsed = supportMessageSchema.safeParse({
    subject: formData.get("subject"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const developers = await listActiveDevelopers();
  const recipients = resolveSupportRecipients(developers);
  if (!recipients.ok) {
    return { error: recipients.error };
  }

  const region = await getRegionById(session.user.regionId);
  const appVersion = getAppVersion();
  const submittedAt = new Date();

  const created = await db.supportMessage.create({
    data: {
      authorId: session.user.id,
      authorRole: session.user.role,
      regionId: session.user.regionId,
      appVersion,
      subject: parsed.data.subject,
      body: parsed.data.body,
      createdAt: submittedAt,
    },
  });

  const authorEmail = session.user.email ?? "";
  const email = buildSupportMessageEmail({
    subject: parsed.data.subject,
    body: parsed.data.body,
    authorEmail,
    authorName: session.user.name,
    authorRole: session.user.role,
    regionName: region?.name ?? null,
    appVersion,
    submittedAt,
    // The reporter's own address, not the shared sales inbox — a quote
    // email falls back to EMAIL_REPLY_TO when its author is gone
    // (src/lib/email/reply-to.ts), but the reporter here is always the
    // signed-in session, so there is no fallback case to reach for.
    replyTo: resolveReplyTo({ email: authorEmail, name: session.user.name }, undefined),
  });

  try {
    const transport = createAppMailTransport();
    const result = await transport.sendMail({
      to: recipients.to,
      from: mailFromAddress(),
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
    if (failed.length) {
      throw new Error(`Email (${failed.join(", ")}) could not be sent`);
    }

    await db.supportMessage.update({ where: { id: created.id }, data: { emailedAt: new Date() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown email error";
    await db.supportMessage.update({ where: { id: created.id }, data: { emailError: message } });
    return {
      warning:
        "Your message was recorded, but the notification email couldn't be sent — the developer can still find it on record.",
    };
  }

  revalidateSupport();
  return {};
}
