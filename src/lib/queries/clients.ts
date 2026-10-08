import { cache } from "react";
import { db } from "@/lib/db";
import { companyWhereForUser, type ScopeUser } from "@/lib/scope";

export type CompanyListItem = {
  id: string;
  name: string;
  city: string | null;
  /** ISO alpha-2 code going forward, but may still be legacy free text for a
   * pre-migration company — render through `displayCountry()`
   * (src/lib/countries.ts), never directly. */
  country: string | null;
  website: string | null;
  contactCount: number;
  /** Which manager looks after this client — `User.name`, falling back to
   * `User.email`, and `null` for a company with no owner at all (possible:
   * `Company.ownerId` is nullable). Feeds the list's `Owner` column, shown to
   * the roles whose list can hold more than one manager's clients
   * (`canSeeSalesperson`, src/lib/roles.ts) — a regional manager's list is
   * several managers' clients merged, and unlabelled it is unusable.
   *
   * Always selected, never conditionally, for the reason
   * `DocumentListItem.salespersonName` gives: the role decides what is
   * displayed, not what is fetched. */
  ownerName: string | null;
};

/**
 * Companies visible to `user` — all for ADMIN, this region's managers' for a
 * REGIONAL_MANAGER, own-only for MANAGER, plus every company in a country the
 * user has been granted (`User.visibleCountries`) — optionally filtered by a
 * case-insensitive name search, ordered by name. Each row carries its contact
 * count for the list cards and its owner's name for the `Owner` column.
 */
export async function listCompanies(
  user: ScopeUser,
  params: { q?: string } = {}
): Promise<CompanyListItem[]> {
  const { q } = params;

  const where: NonNullable<Parameters<typeof db.company.findMany>[0]>["where"] = {
    ...companyWhereForUser(user),
  };

  if (q && q.trim()) {
    where.name = { contains: q.trim(), mode: "insensitive" };
  }

  const companies = await db.company.findMany({
    where,
    orderBy: { name: "asc" },
    include: {
      _count: { select: { contacts: true } },
      // Nullable relation: `Company.ownerId` is optional (see the schema), so
      // a company imported or created without a resolvable owner has none.
      owner: { select: { name: true, email: true } },
    },
  });

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    country: c.country,
    website: c.website,
    contactCount: c._count.contacts,
    ownerName: c.owner ? (c.owner.name ?? c.owner.email) : null,
  }));
}

export type ContactDetail = {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  isPrimary: boolean;
};

export type CompanyDetail = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  /** See `CompanyListItem.country`'s doc comment — same legacy-free-text
   * caveat applies here. */
  country: string | null;
  website: string | null;
  taxId: string | null;
  notes: string | null;
  /** Null when unset. See `src/components/clients/industry-picker.tsx`. */
  industryId: string | null;
  deliverySameAsMain: boolean;
  deliveryStreet: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryPostcode: string | null;
  deliveryCountry: string | null;
  deliveryContactName: string | null;
  deliveryPhone: string | null;
  deliveryNotes: string | null;
  contacts: ContactDetail[];
};

/**
 * A single company (scoped to what `user` may access) with its contacts,
 * primary contact first then by first name. Returns `null` both when the
 * company doesn't exist and when it exists but is out of the caller's
 * scope (a MANAGER viewing another manager's company) — callers should
 * treat both the same way (404), never distinguishing them.
 *
 * The company editor reads this twice per render — once in
 * `generateMetadata` for the tab title, once in the page body — so the work
 * sits behind a request memo (`getCompanyDetailInScope` below).
 */
export function getCompanyDetail(
  user: ScopeUser,
  companyId: string
): Promise<CompanyDetail | null> {
  return getCompanyDetailInScope(
    user.id,
    user.role,
    user.regionId ?? null,
    countriesKey(user.visibleCountries),
    companyId
  );
}

/** A country grant as one primitive, for the memo below: `cache` compares
 * arguments by identity, and `session.user.visibleCountries` is a fresh array
 * on every `auth()` call. Sorted so two orderings of one grant share an entry.
 * The codes are ISO alpha-2 (or `*`), so a comma cannot occur in one. */
function countriesKey(countries: string[] | undefined): string {
  return [...(countries ?? [])].sort().join(",");
}

function countriesFromKey(key: string): string[] {
  return key === "" ? [] : key.split(",");
}

/** Takes the scope as its primitive parts rather than the `ScopeUser`
 * itself, for the reason `getDocumentForBuilderInScope`
 * (src/lib/queries/documents.ts) spells out: React's `cache` matches object
 * arguments by identity, and every `auth()` call hands back a fresh
 * `session.user`, so a memo keyed on that object would never hit.
 *
 * `regionId` is one of them because it shapes the query: a REGIONAL_MANAGER
 * is scoped by their region rather than their own id
 * (`companyWhereForUser`). Dropping it here would resolve every colleague's
 * client to `null` — a 404 on a company the list had just linked to.
 *
 * `countries` is another, for the same reason: it is the country arm of that
 * filter. Dropping it here would fail closed, and a manager whose list shows
 * the clients of their countries would get a 404 on every one of them. */
const getCompanyDetailInScope = cache(async function getCompanyDetailInScope(
  userId: string,
  role: string,
  regionId: string | null,
  countries: string,
  companyId: string
): Promise<CompanyDetail | null> {
  const user: ScopeUser = {
    id: userId,
    role,
    regionId,
    visibleCountries: countriesFromKey(countries),
  };
  const company = await db.company.findFirst({
    where: { id: companyId, ...companyWhereForUser(user) },
    include: {
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }],
      },
    },
  });
  if (!company) return null;

  return {
    id: company.id,
    name: company.name,
    street: company.street,
    city: company.city,
    state: company.state,
    postcode: company.postcode,
    country: company.country,
    website: company.website,
    taxId: company.taxId,
    notes: company.notes,
    industryId: company.industryId,
    deliverySameAsMain: company.deliverySameAsMain,
    deliveryStreet: company.deliveryStreet,
    deliveryCity: company.deliveryCity,
    deliveryState: company.deliveryState,
    deliveryPostcode: company.deliveryPostcode,
    deliveryCountry: company.deliveryCountry,
    deliveryContactName: company.deliveryContactName,
    deliveryPhone: company.deliveryPhone,
    deliveryNotes: company.deliveryNotes,
    contacts: company.contacts.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      position: c.position,
      isPrimary: c.isPrimary,
    })),
  };
});
