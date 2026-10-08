/**
 * Grant a user the clients of some countries, or take the grant away.
 *
 *   npm run user:countries -- anna@example.com US,CA     # US and Canada
 *   npm run user:countries -- anna@example.com '*'       # every country
 *   npm run user:countries -- anna@example.com none      # no country grant
 *
 * The `--` matters: without it npm keeps the arguments for itself. Quote the
 * `*` so the shell does not expand it to file names.
 *
 * A grant lets a MANAGER or REGIONAL_MANAGER read and edit every company whose
 * country is in the list, in addition to the ones they already own (or, for a
 * regional manager, their region's). It never lets them delete a company they
 * do not own. See src/lib/scope.ts. An ADMIN or DEVELOPER already sees every
 * company, so a grant on one changes nothing.
 *
 * The user must already exist, and a code that is not a known country is
 * refused rather than stored. The change reaches a signed-in user within a few
 * minutes, when their session next re-reads the database (src/auth.ts), or at
 * their next sign-in.
 */
import "dotenv/config";

async function main() {
  const [emailArg, listArg, ...extra] = process.argv.slice(2);
  if (!emailArg || listArg === undefined || extra.length > 0) {
    console.error("usage: tsx scripts/set-user-countries.ts <email> <US,CA,... | '*' | none>");
    process.exit(1);
  }

  // Validate before touching the database.
  const { parseCountryGrant } = await import("../src/lib/country-grant");
  const parsed = parseCountryGrant(listArg);
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}`);
    process.exit(1);
  }

  const { db } = await import("../src/lib/db");
  const email = emailArg.toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`error: no user with email ${email}`);
    process.exit(1);
  }

  const show = (countries: string[] | null | undefined) =>
    countries && countries.length > 0 ? countries.join(",") : "(none)";

  console.log(`user:   ${user.email} role=${user.role}`);
  console.log(`before: ${show(user.visibleCountries)}`);

  const updated = await db.user.update({
    where: { id: user.id },
    data: { visibleCountries: parsed.countries },
  });
  console.log(`after:  ${show(updated.visibleCountries)}`);

  if (user.role === "ADMIN" || user.role === "DEVELOPER") {
    console.warn("note: this role already sees every company, so the grant changes nothing for it");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
