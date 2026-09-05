import { displayCountry } from "@/lib/countries";
import type { DocumentForForms } from "@/lib/queries/documents";
import { readProductSpecs } from "@/lib/validation/product-specs";
import { resolveForm } from "./resolve";
import type { FormContext, FormItem, FormItemOption } from "./types";

type AddressLike = {
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
};

/**
 * Three lines, matching the three underlined address rows every form prints.
 * Absent parts are skipped rather than left as gaps, so a company with no
 * state does not print a stray double space.
 */
export function companyAddressLines(address: AddressLike): string[] {
  const locality = [address.city, address.state, address.postcode].filter(Boolean).join(" ");
  const country = address.country ? displayCountry(address.country) : null;
  return [address.street, locality || null, country].filter((line): line is string => Boolean(line));
}

/**
 * The legacy code-keyed views of an item's options (`optionCodes`,
 * `optionAttributes`, `optionQtys`), derived from the role-carrying list so
 * the two can never disagree. Consumers that still read codes use these;
 * the forms themselves read `options`.
 */
export function legacyOptionViews(
  options: FormItemOption[]
): Pick<FormItem, "optionCodes" | "optionAttributes" | "optionQtys"> {
  return {
    optionCodes: options.map((option) => option.code),
    optionAttributes: Object.fromEntries(
      options
        .filter((option) => option.attributes !== null)
        .map((option) => [option.code, option.attributes as Record<string, unknown>])
    ),
    optionQtys: options.map((option) => ({ code: option.code, qty: option.qty })),
  };
}

/**
 * Flattens the document the forms query returns into one context per item
 * that prints a form -- an item whose product carries a `form`. Items with
 * no form (software, services, accessories) get no context of their own;
 * the SOFTWARE ones are exposed on every context as `software` so a form can
 * ask whether PathWorks Integrated was sold and which modules came with it.
 *
 * A custom item with no product resolves to kind ACCESSORY and no form: it
 * has no catalogue facts to read, and no form has a box for it.
 */
export function buildFormContexts(document: DocumentForForms): FormContext[] {
  const snapshot = document.entitySnapshot as { entityName?: string } | null;
  const distributorName = snapshot?.entityName ?? document.region.entityName;

  const company = document.company;
  const addressLines = company ? companyAddressLines(company) : [];

  const deliveryAddressLines =
    company && !company.deliverySameAsMain
      ? companyAddressLines({
          street: company.deliveryStreet,
          city: company.deliveryCity,
          state: company.deliveryState,
          postcode: company.deliveryPostcode,
          country: company.deliveryCountry,
        })
      : addressLines;

  const software = document.items
    .filter((item) => item.product?.kind === "SOFTWARE")
    .map((item) => ({ code: item.code, specs: readProductSpecs(item.product?.specs) }));
  const softwareCodes = software.map((s) => s.code);

  return document.items
    .filter((item) => resolveForm(item.product?.form) !== null)
    .map((item) => {
      const options: FormItemOption[] = item.lines
        .filter((line) => line.kind === "OPTION" && line.code !== null)
        .map((line) => {
          const row = line.refId !== null ? document.optionsById[line.refId] : undefined;
          return {
            id: row?.id ?? line.refId,
            code: line.code as string,
            role: row?.role ?? null,
            qty: line.qty,
            attributes:
              line.attributes && typeof line.attributes === "object" && !Array.isArray(line.attributes)
                ? (line.attributes as Record<string, unknown>)
                : null,
          };
        });

      const formItem: FormItem = {
        id: item.id,
        code: item.code,
        name: item.name,
        kind: item.product?.kind ?? "ACCESSORY",
        form: item.product?.form ?? null,
        specs: readProductSpecs(item.product?.specs),
        spec: (item.productionSpec ?? {}) as Record<string, unknown>,
        options,
        ...legacyOptionViews(options),
      };

      return {
        distributorName,
        authorName: document.author.name ?? "",
        company: {
          name: company?.name ?? "",
          addressLines,
          industry: company?.industry?.name ?? null,
        },
        contact: {
          fullName: [document.contact?.firstName, document.contact?.lastName].filter(Boolean).join(" "),
          position: document.contact?.position ?? null,
          phone: document.contact?.phone ?? null,
          email: document.contact?.email ?? null,
        },
        deliveryAddressLines,
        software,
        softwareCodes,
        item: formItem,
      };
    });
}
