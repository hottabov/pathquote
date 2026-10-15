import type { Metadata } from "next";
import {
  getQuoteValidityDays,
  getShowOptionIcons,
  getSigningLinkValidityDays,
} from "@/lib/queries/settings";
import { updateSetting } from "@/lib/actions/settings";
import { QuoteValidityForm } from "@/components/settings/quote-validity-form";
import { SigningLinkValidityForm } from "@/components/settings/signing-link-validity-form";
import { ShowOptionIconsForm } from "@/components/settings/show-option-icons-form";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Preferences" };
export const dynamic = "force-dynamic";

/**
 * The Preferences section — defaults applied across the app (quote
 * validity, signing links, whether option icons show). Where
 * small settings collect as the app grows. Admin-only: the segment layout
 * (src/app/(app)/settings/preferences/layout.tsx) calls requireAdmin, so a
 * MANAGER never reaches this page at all.
 */
export default async function PreferencesSettingsPage() {
  const [quoteValidityDays, signingLinkValidityDays, showOptionIcons] = await Promise.all([
    getQuoteValidityDays(),
    getSigningLinkValidityDays(),
    getShowOptionIcons(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Preferences" description="Defaults applied across the app." />

      <SectionCard title="Preferences">
        <div className="flex flex-col gap-4">
          <QuoteValidityForm
            action={updateSetting.bind(null, "quote.validityDays")}
            defaultValue={quoteValidityDays}
          />
          <div className="border-t border-slate-100 pt-4">
            <SigningLinkValidityForm
              action={updateSetting.bind(null, "signing.linkValidityDays")}
              defaultValue={signingLinkValidityDays}
            />
          </div>
          <div className="border-t border-slate-100 pt-4">
            <ShowOptionIconsForm
              action={updateSetting.bind(null, "ui.showOptionIcons")}
              defaultValue={showOptionIcons}
            />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
