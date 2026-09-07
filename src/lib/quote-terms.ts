// The standard-terms figures the legal documents quote back at the customer.
// Pure: no `@/lib/db`, no `next/*`, so `vitest run` needs no DATABASE_URL —
// same rule as quote-variables.ts and machine-specs.ts.

export type QuoteTermValues = {
  deliveryWeeks: number;
  installationDays: number;
  trainingDays: number;
  warrantyMonths: number;
};

/** Per-quote overrides. Null or absent means "inherit the region's". */
export type QuoteTermOverrides = Partial<Record<keyof QuoteTermValues, number | null>>;

/**
 * Quote value if it has one, region value otherwise. `??` rather than `||`
 * on purpose: 0 is a figure someone may legitimately promise (a self-install
 * with no installation days), and `||` would silently replace it with the
 * region's.
 */
export function resolveQuoteTerms(overrides: QuoteTermOverrides, region: QuoteTermValues): QuoteTermValues {
  return {
    deliveryWeeks: overrides.deliveryWeeks ?? region.deliveryWeeks,
    installationDays: overrides.installationDays ?? region.installationDays,
    trainingDays: overrides.trainingDays ?? region.trainingDays,
    warrantyMonths: overrides.warrantyMonths ?? region.warrantyMonths,
  };
}
