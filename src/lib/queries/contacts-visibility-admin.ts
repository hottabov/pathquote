import { db } from "@/lib/db";
import { buildContactsVisibility, type ContactsVisibility } from "@/lib/contacts-visibility";

// Admin-only read for the "Contacts visibility" editor on a user's own
// settings page (/settings/users/[userId]). Unscoped by design: the editor
// lists every country that has a client, with how many, so an admin deciding
// what to grant can tell a country with 4,000 clients from one with a stray
// record. That is a count over the whole client base, not a list of anyone's
// clients, and its only caller is the ADMIN-only user editor. See the
// allowlist entry in tests/scope-coverage.test.ts.
//
// The row-building is pure and lives in src/lib/contacts-visibility.ts, where
// the no-database test suite can import it; this is the thin shell around it.
export type {
  ContactsVisibility,
  VisibilityCountryRow,
} from "@/lib/contacts-visibility";

/**
 * `userId`'s current country grant joined to the per-country company counts.
 * One grouped count over the indexed `Company.country`, not a count per
 * country; the user's grant is read alongside it. A user that does not exist
 * reads as an empty grant, as the page has already 404ed on one.
 */
export async function getContactsVisibility(userId: string): Promise<ContactsVisibility> {
  const [user, groups] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { visibleCountries: true } }),
    db.company.groupBy({ by: ["country"], _count: { _all: true } }),
  ]);

  return buildContactsVisibility(groups, user?.visibleCountries ?? []);
}
