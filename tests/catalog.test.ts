import { describe, it, expect, beforeAll } from 'vitest';
import catalogData from '../prisma/seed-data/catalog.json';
import { deriveEasyLoaderOptions } from '../src/lib/production-forms/table-sections';
import { legacyOptionIdentity } from '../src/lib/catalog-identity';

interface CatalogItem {
  code: string;
  name: string;
  description: string;
  price: number | null;
  needsReview: boolean;
  isCredit?: boolean;
}

interface GlobalOption extends CatalogItem {
  compatibleSeries: string[];
  compatibleProducts?: string[];
}

interface Series {
  seriesCode: string;
  seriesName: string;
  maxDiscountPct: number | null;
  products: CatalogItem[];
}

interface Catalog {
  extractedAt: string;
  series: Series[];
  options: GlobalOption[];
}

const catalog = catalogData as Catalog;

describe('Catalog Extraction Validation', () => {
  let mSeries: Series;
  let xcSeries: Series;
  let lSeries: Series;
  let allItems: CatalogItem[];

  beforeAll(() => {
    mSeries = catalog.series.find((s) => s.seriesCode === 'M')!;
    xcSeries = catalog.series.find((s) => s.seriesCode === 'X')!;
    lSeries = catalog.series.find((s) => s.seriesCode === 'L')!;

    // Collect all items (products from every series, plus the global options)
    allItems = [];
    catalog.series.forEach((series) => {
      allItems.push(...series.products);
    });
    allItems.push(...catalog.options);
  });

  describe('Series Structure', () => {
    // 10 series (the original 9 plus "SVC" (Service), a hand-authored series
    // with no sheet of its own, added for the new "SERVICE" container
    // product and its SVC-* service options -- see MANUAL_PRODUCTS.SVC and
    // MANUAL_OPTIONS in scripts/extract-catalog.ts) minus 1: Punchline ("P")
    // was retired from the catalogue entirely (owner decision -- not sold
    // anymore), dropped at extraction rather than extracted-and-filtered
    // (see the comment above extractSoftware in scripts/extract-catalog.ts).
    // 9 -> 10: HDRF was split out of the EasyFeeder ("EF") series into its
    // own "HDRF" series (owner decision -- it's a different machine with its
    // own NA sheet and product photo, not an EasyFeeder variant; see
    // MANUAL_PRODUCTS.HDRF in scripts/extract-catalog.ts).
    it('should have exactly 10 series', () => {
      expect(catalog.series).toHaveLength(10);
    });

    it('Punchline ("P") no longer exists as a series', () => {
      expect(catalog.series.some((s) => s.seriesCode === 'P')).toBe(false);
    });

    // 64 -> 67: the single width-less "HDRF" product was split into three
    // width variants (HDRF-180/220/320, net +2 -- owner decision, see
    // MANUAL_PRODUCTS.EF), and the new "SERVICE" container product was added
    // (+1, see MANUAL_PRODUCTS.SVC). See that file's header comments for the
    // full history of how 64 itself was reached (10 NA-only additions).
    // 67 -> 68: the TRADE-IN credit product was added (+1, see
    // MANUAL_PRODUCTS.SVC) -- a real catalogue product (John: "you're selling
    // a trade in. It's a negative value"), not a discount.
    // 68 -> 66: Punchline's two products (P-180, P-220) were retired along
    // with the whole series (see above).
    it('should have exactly 66 total products across all series', () => {
      const totalProducts = catalog.series.reduce((sum, series) => sum + series.products.length, 0);
      expect(totalProducts).toBe(66);
    });

    it('M series should have 16 products (12 original + NA-only M3300/M5300/M7300/M10300)', () => {
      expect(mSeries.products).toHaveLength(16);
    });

    it('L series maxDiscountPct should be 10', () => {
      expect(lSeries.maxDiscountPct).toBe(10);
    });

    // EasyLoader/EasyFeeder/Software were originally misclassified as
    // options-only sheets (0 products each), which made their machines and
    // software modules impossible to add to a document. Re-verified against
    // the source sheets and reclassified -- see scripts/extract-catalog.ts.
    it('EasyLoader (EL) should have 4 products (2020/2420 + NA-only 3220/4030 drive modules)', () => {
      const el = catalog.series.find((s) => s.seriesCode === 'EL')!;
      expect(el.products).toHaveLength(4);
    });

    // 5 -> 4: HDRF (the old single width-less product, later split into
    // three width variants) moved out of EF entirely into its own "HDRF"
    // series -- see MANUAL_PRODUCTS.HDRF in scripts/extract-catalog.ts. EF
    // is back down to just its own four EasyFeeder products.
    it('EasyFeeder (EF) should have 4 products (2020/2420/4030 + NA-only EF-3220), and no HDRF products', () => {
      const ef = catalog.series.find((s) => s.seriesCode === 'EF')!;
      expect(ef.products).toHaveLength(4);
      expect(ef.products.map((p) => p.code).sort()).toEqual(['EF-2020', 'EF-2420', 'EF-3220', 'EF-4030'].sort());
      expect(ef.products.some((p) => p.code.startsWith('HDRF'))).toBe(false);
    });

    // HDRF is its own catalogue series now (owner decision -- see
    // MANUAL_PRODUCTS.HDRF in scripts/extract-catalog.ts), carrying exactly
    // the three width variants that used to live inside EF.
    it('Heavy Duty Roll Feeder (HDRF) should have exactly 3 products: HDRF-180/220/320', () => {
      const hdrf = catalog.series.find((s) => s.seriesCode === 'HDRF')!;
      expect(hdrf).toBeDefined();
      expect(hdrf.seriesName).toBe('Heavy Duty Roll Feeder');
      expect(hdrf.products).toHaveLength(3);
      expect(hdrf.products.map((p) => p.code).sort()).toEqual(['HDRF-180', 'HDRF-220', 'HDRF-320']);
    });

    it('FabricPro (FP) should have 4 products (FP-180/FP-220 + manual FP-TROLLEY + NA-only FP-300)', () => {
      const fp = catalog.series.find((s) => s.seriesCode === 'FP')!;
      expect(fp.products).toHaveLength(4);
    });

    it('Software (SW) should have 11 products (10 original + NA-only PTW(I))', () => {
      const sw = catalog.series.find((s) => s.seriesCode === 'SW')!;
      expect(sw.products).toHaveLength(11);
    });

    // New hand-authored series (see MANUAL_PRODUCTS.SVC in
    // scripts/extract-catalog.ts) -- a container product for the SVC-*
    // service options, not sold on its own (price 0, needsReview false), plus
    // the TRADE-IN credit product added alongside it (see the next test).
    it('Service (SVC) should have exactly 2 products: "SERVICE" and "TRADE-IN"', () => {
      const svc = catalog.series.find((s) => s.seriesCode === 'SVC')!;
      expect(svc).toBeDefined();
      expect(svc.products).toHaveLength(2);
      expect(svc.products[0]).toMatchObject({
        code: 'SERVICE',
        name: 'Service',
        price: 0,
        needsReview: false,
      });
    });

    // TRADE-IN is a credit product (John: "we should create another product
    // called trade-in... it's a negative value") -- see MANUAL_PRODUCTS.SVC
    // in scripts/extract-catalog.ts. `price: 20000` is John's own stated
    // default ("I would put a value of $20,000 on it... as a default, they
    // can always change it up or down"); `isCredit: true` is what actually
    // makes it subtract from a quote rather than add to it (see
    // Product.isCredit in schema.prisma / EngineItem.isCredit in
    // src/lib/pricing.ts). Its `description` carries the disposal/no-resale/
    // Pathfinder-inspection terms John dictated -- transcribed, provisional,
    // not the agreed legal redaction (see the fuller note on the
    // MANUAL_PRODUCTS.SVC entry itself), so this only checks that the
    // structural fields are right, not the exact wording.
    it('TRADE-IN should be a credit product priced 20000, needsReview=false', () => {
      const svc = catalog.series.find((s) => s.seriesCode === 'SVC')!;
      const tradeIn = svc.products.find((p) => p.code === 'TRADE-IN');
      expect(tradeIn).toBeDefined();
      expect(tradeIn).toMatchObject({
        code: 'TRADE-IN',
        name: 'Trade-in',
        price: 20000,
        needsReview: false,
        isCredit: true,
      });
      expect(tradeIn?.description.length).toBeGreaterThan(0);
    });
  });

  describe('X and M Series Code Mapping', () => {
    // X is cloned from M-Series' products BEFORE the NA-only M3300/M5300/
    // M7300/M10300 products are appended (see scripts/extract-catalog.ts's
    // main()) -- there's no NA evidence of a matching X-3300-style product
    // (the NA X-series sheet only prices X10180/X10220), so X intentionally
    // stays at its original 12 rather than growing to 16 alongside M.
    it('X series should have 12 products (unaffected by the NA-only M-series widths)', () => {
      expect(xcSeries.products).toHaveLength(12);
    });

    // The X-Calibre *series code* is "X" (renamed from "XC" -- the catalog
    // UI showed "XC" but should read "X"; product codes were already
    // "X-####" before this rename and are unaffected).
    it('X series seriesName should still read "X-Calibre"', () => {
      expect(xcSeries.seriesName).toBe('X-Calibre');
    });

    it('every X product should correspond to an M product of the same spec (X-<code> <-> M<code>)', () => {
      xcSeries.products.forEach((xcProduct) => {
        const expectedMCode = 'M' + xcProduct.code.substring(2);
        const mProduct = mSeries.products.find((p) => p.code === expectedMCode);
        expect(mProduct, `expected M product "${expectedMCode}" for X product "${xcProduct.code}"`).toBeDefined();
      });
    });

    it('every original M product (excluding the NA-only 300cm-width tier) has an X clone', () => {
      const naOnlyMCodes = new Set(['M3300', 'M5300', 'M7300', 'M10300']);
      mSeries.products
        .filter((p) => !naOnlyMCodes.has(p.code))
        .forEach((mProduct) => {
          const expectedXcCode = 'X-' + mProduct.code.substring(1);
          expect(xcSeries.products.some((p) => p.code === expectedXcCode)).toBe(true);
        });
    });
  });

  describe('Spot Price Validation', () => {
    it('M3180 should have price 175000', () => {
      const m3180 = mSeries.products.find((p) => p.code === 'M3180');
      expect(m3180?.price).toBe(175000);
    });

    it('L-180 should have price 135000', () => {
      const l180 = lSeries.products.find((p) => p.code === 'L-180');
      expect(l180?.price).toBe(135000);
    });

    // The EasyLoader itself is now free: it is assembled entirely from
    // options, and the price it used to carry -- which was always the price
    // of its first drive module, as its own description says -- moved to the
    // "Drive Module (first 1.2M)" option the builder writes.
    it('EL-2020 costs nothing, and its drive module carries the price it used to', () => {
      const el = catalog.series.find((s) => s.seriesCode === 'EL')!;
      expect(el.products.find((p) => p.code === 'EL-2020')?.price).toBe(0);
      expect(
        catalog.options.find((o) => o.code === 'EL-2020 Drive Module (first 1.2M)')?.price
      ).toBe(4050);
    });

    it('every EasyLoader width has a drive module option', () => {
      for (const code of ['EL-2020', 'EL-2420', 'EL-3220', 'EL-4030']) {
        const drive = catalog.options.find((o) => o.code === `${code} Drive Module (first 1.2M)`);
        expect(drive, code).toBeDefined();
        expect(drive?.compatibleProducts).toEqual([code]);
      }
    });

    // The load-bearing one. The EasyLoader builder writes one option per
    // module role, looked up as "this width's option with this role"
    // (`setEasyLoaderLayout`), and refuses the layout when a role has no
    // row -- so a width missing a role is not a cosmetic gap, it is a table
    // that cannot be saved at all. Derive a layout that uses every role and
    // check the catalogue has one for every width. The seed derives role and
    // parent from the legacy codes (src/lib/catalog-identity.ts) until
    // catalogue v2 carries them itself.
    it('every role the EasyLoader builder can write exists for every width', () => {
      const identities = catalog.options.map((o) => ({ code: o.code, ...legacyOptionIdentity(o.code) }));
      const layout = [
        { lengthM: 3.6, surface: 'conveyor' as const },
        { lengthM: 1.2, surface: 'static' as const },
      ];
      const derived = deriveEasyLoaderOptions(layout, true);
      expect(derived.map((d) => d.role)).toEqual(['EL_DRIVE', 'EL_CONVEYOR', 'EL_STATIC', 'EL_BUSBAR', 'EL_RAIL']);
      for (const width of ['EL-2020', 'EL-2420', 'EL-3220', 'EL-4030']) {
        for (const { role } of derived) {
          const matches = identities.filter((o) => o.role === role && o.parentProductCode === width);
          expect(matches.map((o) => o.code), `${width} ${role}`).toHaveLength(1);
        }
      }
    });

    it('every EasyLoader width has a busbar and a support rail for a FabricPro', () => {
      for (const code of ['EL-2020', 'EL-2420', 'EL-3220', 'EL-4030']) {
        const codes = catalog.options.map((o) => o.code);
        expect(codes, code).toContain(
          `${code} Electrical Busbar Per 1.2M Used for Fabric Pro automatic spreader.`
        );
        expect(codes, code).toContain(`${code} Travel Platform support rail. Per 1.2m`);
      }
    });

    it('EF-4030 should have price 17540', () => {
      const ef = catalog.series.find((s) => s.seriesCode === 'EF')!;
      const ef4030 = ef.products.find((p) => p.code === 'EF-4030');
      expect(ef4030?.price).toBe(17540);
    });

    it('PTN should have price 20577', () => {
      const sw = catalog.series.find((s) => s.seriesCode === 'SW')!;
      const ptn = sw.products.find((p) => p.code === 'PTN');
      expect(ptn?.price).toBe(20577);
    });
  });

  describe('Price Validation Rules', () => {
    // A price is either a usable positive number, or it's flagged for review
    // (covers both a missing price, e.g. M3390, and a present-but-unusable
    // one, e.g. TPL's genuine 0) -- with one deliberate, documented
    // exception: "SERVICE" (see MANUAL_PRODUCTS.SVC in
    // scripts/extract-catalog.ts) is a container product never sold on its
    // own -- its own price is a real, intentional 0, not a "TBD" gap, so
    // needsReview is false for it specifically.
    it('every item should have a positive price OR be flagged needsReview (except the intentional zeros)', () => {
      allItems.forEach((item) => {
        // Two kinds of real, intentional 0. "SERVICE" is a container product
        // never sold on its own. An EasyLoader is sold as the sum of its
        // modules, every one of which is an option -- so the machine line
        // itself is genuinely free, not a price nobody has filled in yet.
        if (item.code === 'SERVICE' || /^EL-\d{4}$/.test(item.code)) {
          expect(item.price, item.code).toBe(0);
          expect(item.needsReview, item.code).toBe(false);
          return;
        }
        expect((item.price !== null && item.price > 0) || item.needsReview).toBe(true);
      });
    });

    it('a null price should always be flagged needsReview', () => {
      allItems.forEach((item) => {
        if (item.price === null) {
          expect(item.needsReview).toBe(true);
        }
      });
    });
  });

  describe('Known Data Gaps', () => {
    it('M3390 should have needsReview=true (price is null)', () => {
      const m3390 = mSeries.products.find((p) => p.code === 'M3390');
      expect(m3390?.needsReview).toBe(true);
      expect(m3390?.price).toBeNull();
    });

    it('LS Convert (now a Software product) should have needsReview=true', () => {
      const sw = catalog.series.find((s) => s.seriesCode === 'SW')!;
      const lsConvert = sw.products.find((p) => p.code === 'LS Convert');
      expect(lsConvert).toBeDefined();
      expect(lsConvert?.needsReview).toBe(true);
      expect(lsConvert?.price).toBeNull();
    });

    it('TPL should have price 0 and needsReview=true (genuine 0 in source, not a missing cell)', () => {
      const tpl = catalog.options.find((o) => o.code === 'TPL');
      expect(tpl).toBeDefined();
      expect(tpl?.price).toBe(0);
      expect(tpl?.needsReview).toBe(true);
    });

    // Manual products (not in the source Excel -- see MANUAL_PRODUCTS in
    // scripts/extract-catalog.ts) should survive extraction with no price
    // and needsReview=true, same as every other unpriced item.
    it('FP-TROLLEY (manual FP product) should exist with needsReview=true and no price', () => {
      const fp = catalog.series.find((s) => s.seriesCode === 'FP')!;
      const trolley = fp.products.find((p) => p.code === 'FP-TROLLEY');
      expect(trolley).toBeDefined();
      expect(trolley?.name).toBe('Fabric Roll Trolley');
      expect(trolley?.price).toBeNull();
      expect(trolley?.needsReview).toBe(true);
    });

    // The old single width-less "HDRF" product was split into three width
    // variants (owner decision, model like EasyLoader) -- see
    // MANUAL_PRODUCTS.HDRF in scripts/extract-catalog.ts. "HDRF" itself no
    // longer exists as a product code, and these three now live in their own
    // "HDRF" series, not EF (owner decision -- see the "Series Structure"
    // describe block above). Unlike every other manual/NA-only gap in this
    // describe block, these three DO carry a real AU price -- the owner's
    // own USD->AUD conversion (see the comment on MANUAL_PRODUCTS.HDRF's
    // entries), not something sourced from the AU price list, so
    // needsReview is false rather than the usual "no AU pricing published
    // yet" true.
    it('HDRF-180/220/320 (manual HDRF-series products) should exist with real AU prices, needsReview=false', () => {
      const hdrf = catalog.series.find((s) => s.seriesCode === 'HDRF')!;
      const ef = catalog.series.find((s) => s.seriesCode === 'EF')!;
      expect(ef.products.some((p) => p.code === 'HDRF')).toBe(false);
      expect(ef.products.some((p) => p.code.startsWith('HDRF'))).toBe(false);
      const expectedPrices: Record<string, number> = { 'HDRF-180': 17500, 'HDRF-220': 19500, 'HDRF-320': 21400 };
      for (const [code, price] of Object.entries(expectedPrices)) {
        const product = hdrf.products.find((p) => p.code === code);
        expect(product, `expected HDRF product "${code}"`).toBeDefined();
        expect(product?.name).toBe(`Heavy Duty Roll Feeder ${code.split('-')[1]}`);
        expect(product?.price).toBe(price);
        expect(product?.needsReview).toBe(false);
      }
    });
  });

  describe('Global Options', () => {
    // 81 -> 90: -1 (FM180 retired, not sold anymore -- see the "FM180
    // retirement" describe block below), +1 (JTP), +9 (SVC-* service
    // options) -- see MANUAL_OPTIONS in scripts/extract-catalog.ts.
    // 90 -> 95: +1 (Crate-EL) +4 (EL-3220/EL-4030 Additional/Static table
    // 1.2M lengths, priced null pending confirmation) -- production forms
    // phase 2, Task 1.
    // 95 -> 94: Crate-P retired along with the rest of Punchline (see the
    // "Series Structure" describe block above).
    // 94 -> 97: the three HDRF crate options (HDRF-180/220/320 "Crate- Wooden
    // Crate for transport"), product-scoped like EasyLoader's own
    // accessories -- see MANUAL_OPTIONS in scripts/extract-catalog.ts.
    // 97 -> 105: four "Drive Module (first 1.2M)" options, one per EasyLoader
    // width, plus a busbar and a travel-platform rail for EL-3220 and EL-4030,
    // which had neither -- the EasyLoader builder writes all of these from the
    // table layout, so a width missing one would silently drop a line from
    // the quote.
    it('should have exactly 105 global options', () => {
      expect(catalog.options).toHaveLength(105);
    });

    it('Crate-P no longer exists as an option', () => {
      expect(catalog.options.some((o) => o.code === 'Crate-P')).toBe(false);
    });

    // Most options are series-scoped (non-empty compatibleSeries). A few
    // (e.g. EasyLoader accessories, scoped to one specific drive-module
    // product rather than the whole EL series) are product-scoped instead:
    // compatibleSeries is `[]` and compatibleProducts carries the scoping.
    // Every option must be compatible with *something*, one way or the other.
    it('every option should have a non-empty compatibleSeries OR compatibleProducts list', () => {
      catalog.options.forEach((option) => {
        expect(Array.isArray(option.compatibleSeries)).toBe(true);
        const hasSeries = option.compatibleSeries.length > 0;
        const hasProducts = Array.isArray(option.compatibleProducts) && option.compatibleProducts.length > 0;
        expect(hasSeries || hasProducts).toBe(true);
      });
    });

    it('EasyLoader accessory options should be product-scoped: empty compatibleSeries + compatibleProducts', () => {
      const elOptions = catalog.options.filter((o) => o.code.startsWith('EL-'));
      expect(elOptions.length).toBeGreaterThan(0);
      elOptions.forEach((option) => {
        expect(option.compatibleSeries).toEqual([]);
        expect(option.compatibleProducts).toBeDefined();
        expect(option.compatibleProducts!.length).toBeGreaterThan(0);
        option.compatibleProducts!.forEach((code) =>
          expect(['EL-2020', 'EL-2420', 'EL-3220', 'EL-4030']).toContain(code),
        );
      });
    });

    it('every option sourced from the M sheet should include "X" in compatibleSeries', () => {
      // PTW (merged M+L) and every M-only/split "-M" option should carry X.
      const mSourced = catalog.options.filter((o) => o.compatibleSeries.includes('M'));
      expect(mSourced.length).toBeGreaterThan(0);
      mSourced.forEach((option) => {
        expect(option.compatibleSeries).toContain('X');
      });
    });

    it('options priced identically across sheets are merged into one option with the union of series', () => {
      // PTW is priced 3500 in both M-series and L-Series -> single global option.
      const ptw = catalog.options.filter((o) => o.code === 'PTW');
      expect(ptw).toHaveLength(1);
      expect(ptw[0].price).toBe(3500);
      expect(ptw[0].compatibleSeries.sort()).toEqual(['L', 'M', 'X'].sort());
      // No unsuffixed leftovers for a merged code.
      expect(catalog.options.some((o) => o.code === 'PTW-M' || o.code === 'PTW-L')).toBe(false);
    });

    it('options priced differently across sheets are split into series-suffixed codes', () => {
      const splitBaseCodes = ['ABR', 'APM', 'BCR', 'HDC', 'HFV', 'OFD', 'OFP', 'PM', 'PRM'];
      splitBaseCodes.forEach((code) => {
        // The unsuffixed base code must not survive a split.
        expect(catalog.options.some((o) => o.code === code)).toBe(false);

        const mVariant = catalog.options.find((o) => o.code === `${code}-M`);
        const lVariant = catalog.options.find((o) => o.code === `${code}-L`);
        expect(mVariant).toBeDefined();
        expect(lVariant).toBeDefined();
        expect(mVariant!.price).not.toBe(lVariant!.price);
        expect(mVariant!.compatibleSeries).toContain('X');
      });

      // "Crate" used to split three ways (M, P, FP), all at different
      // prices. Punchline's own "Crate" row (Crate-P) went with the rest of
      // the retired series (see "Series Structure" above), so the sheet-
      // level split is now two ways (M, FP) -- the two still-priced-
      // differently variants remain, and Crate-P must not have come back.
      const crateM = catalog.options.find((o) => o.code === 'Crate-M');
      const crateFP = catalog.options.find((o) => o.code === 'Crate-FP');
      expect(crateM).toBeDefined();
      expect(crateFP).toBeDefined();
      expect(crateM!.price).not.toBe(crateFP!.price);
      expect(catalog.options.some((o) => o.code === 'Crate-P')).toBe(false);
      expect(catalog.options.some((o) => o.code === 'Crate')).toBe(false);
    });

    // PRA used to split two ways (L-Series option, SW-sheet option) at
    // different prices. The SW-sheet "PRA" is now a Software product (see
    // Series Structure above) rather than an option, so there's no longer a
    // second "PRA" option to trigger the automatic merge/split logic --
    // the L-Series option keeps its long-standing "PRA-L" code (hard-coded
    // in extractLSeries) rather than reverting to an unsuffixed "PRA", which
    // would collide with the new SW product code.
    it('PRA-L (L-Series option) and PRA (SW product) coexist as distinct codes with different prices', () => {
      const praL = catalog.options.find((o) => o.code === 'PRA-L');
      expect(praL).toBeDefined();
      expect(praL!.price).toBe(2200);
      expect(praL!.compatibleSeries).toEqual(['L']);
      // No leftover "PRA-SW" option and no unsuffixed "PRA" option -- SW's
      // PRA is a product now.
      expect(catalog.options.some((o) => o.code === 'PRA-SW')).toBe(false);
      expect(catalog.options.some((o) => o.code === 'PRA')).toBe(false);

      const sw = catalog.series.find((s) => s.seriesCode === 'SW')!;
      const praProduct = sw.products.find((p) => p.code === 'PRA');
      expect(praProduct).toBeDefined();
      expect(praProduct!.price).toBe(3500);
    });

    // New owner-requested option (MANUAL_OPTIONS in scripts/extract-catalog.ts),
    // distinct from the pre-existing "JetPen" option sourced from the
    // L-Series sheet's own row (priced 7500).
    it('JTP ("JetPen") should exist, L-Series only, price null + needsReview true', () => {
      const jtp = catalog.options.find((o) => o.code === 'JTP');
      expect(jtp).toBeDefined();
      expect(jtp?.name).toBe('JetPen');
      expect(jtp?.price).toBeNull();
      expect(jtp?.needsReview).toBe(true);
      expect(jtp?.compatibleSeries).toEqual(['L']);

      // The pre-existing "JetPen" option (different code, different price)
      // is untouched by this addition.
      const jetPen = catalog.options.find((o) => o.code === 'JetPen');
      expect(jetPen).toBeDefined();
      expect(jetPen?.price).toBe(7500);
    });

    // FM180 ("Fabric Master") retired -- not sold anymore (owner decision).
    // Dropped at extraction (scripts/extract-catalog.ts skips the row) so it
    // never reappears in catalog.json; prisma/seed.ts's RETIRED_OPTION_CODES
    // handles cleaning it up on an existing DB.
    it('FM180 no longer exists as a catalog option', () => {
      expect(catalog.options.some((o) => o.code === 'FM180')).toBe(false);
    });

    // Service options (MANUAL_OPTIONS in scripts/extract-catalog.ts),
    // product-scoped to the new "SERVICE" container product, sourced from
    // prisma/seed-data/prices-us.json's `unmatched[]` rows (real NA service
    // rows with no AU equivalent) -- see scripts/extract-us-prices.ts. Every
    // one of these has AU price null + needsReview true EXCEPT
    // SVC-HDRF-INSTALL, which now carries the owner's own manual USD->AUD
    // conversion (see the comment on MANUAL_PRODUCTS.EF's HDRF entries) --
    // checked separately below.
    it('service options (excluding SVC-HDRF-INSTALL) exist, product-scoped to SERVICE, AU price null + needsReview true', () => {
      const serviceCodes = [
        'SVC-LNS-INSTALL',
        'SVC-FP-INSTALL',
        'SVC-M-INSTALL',
        'SVC-M-INSTALL-MTS',
        'SVC-L-INSTALL',
        'SVC-L-INSTALL-MTS',
        'SVC-EL-INSTALL',
        'SVC-SW-TRAINING',
      ];
      expect(serviceCodes).toHaveLength(8);
      for (const code of serviceCodes) {
        const option = catalog.options.find((o) => o.code === code);
        expect(option, `expected service option "${code}"`).toBeDefined();
        expect(option?.price).toBeNull();
        expect(option?.needsReview).toBe(true);
        expect(option?.compatibleSeries).toEqual([]);
        expect(option?.compatibleProducts).toEqual(['SERVICE']);
      }
    });

    it('SVC-HDRF-INSTALL is priced 300 (AU), needsReview=false, product-scoped to SERVICE', () => {
      const option = catalog.options.find((o) => o.code === 'SVC-HDRF-INSTALL');
      expect(option).toBeDefined();
      expect(option?.price).toBe(300);
      expect(option?.needsReview).toBe(false);
      expect(option?.compatibleSeries).toEqual([]);
      expect(option?.compatibleProducts).toEqual(['SERVICE']);
    });

    // HDRF crates: product-scoped like EasyLoader's own accessories, one per
    // width, each a genuinely different price (see the owner's table).
    it('HDRF crate options exist, product-scoped to their own width, priced per the owner table', () => {
      const expected: Record<string, [string, number]> = {
        'HDRF-180 Crate- Wooden Crate for transport': ['HDRF-180', 1800],
        'HDRF-220 Crate- Wooden Crate for transport': ['HDRF-220', 2000],
        'HDRF-320 Crate- Wooden Crate for transport': ['HDRF-320', 2300],
      };
      for (const [code, [productCode, price]] of Object.entries(expected)) {
        const option = catalog.options.find((o) => o.code === code);
        expect(option, `expected HDRF crate option "${code}"`).toBeDefined();
        expect(option?.price).toBe(price);
        expect(option?.needsReview).toBe(false);
        expect(option?.compatibleSeries).toEqual([]);
        expect(option?.compatibleProducts).toEqual([productCode]);
      }
    });

    // Confirms the "no option silently disappears" analysis behind moving
    // HDRF out of the EF series: no option in the catalog is compatibleSeries
    // -scoped to "EF" at all (the EF sheet contributes zero options -- see
    // extractEasyFeeder in scripts/extract-catalog.ts, always `options: []`),
    // so relocating HDRF-180/220/320 into their own series carries nothing
    // implicit along with it. The three HDRF crate options above are already
    // product-scoped (compatibleProducts), not series-scoped, so they move
    // with their products regardless of which series those products sit in.
    it('no option is compatibleSeries-scoped to EF (so moving HDRF out of EF drops no implicit option)', () => {
      const efScoped = catalog.options.filter((o) => o.compatibleSeries.includes('EF'));
      expect(efScoped).toEqual([]);
    });
  });

  describe('Data Integrity', () => {
    it('should not have duplicate codes across all products and options globally', () => {
      const codeMap: Record<string, number> = {};

      allItems.forEach((item) => {
        codeMap[item.code] = (codeMap[item.code] || 0) + 1;
      });

      const duplicates = Object.entries(codeMap)
        .filter(([, count]) => count > 1)
        .map(([code]) => code);

      expect(duplicates).toEqual([]);
    });

    it('all items should have required fields', () => {
      allItems.forEach((item) => {
        expect(item.code).toBeDefined();
        expect(typeof item.code).toBe('string');
        expect(item.code.length).toBeGreaterThan(0);

        expect(item.name).toBeDefined();
        expect(typeof item.name).toBe('string');
        expect(item.name.length).toBeGreaterThan(0);

        expect(item.description).toBeDefined();
        expect(typeof item.description).toBe('string');

        if (item.price !== null) {
          expect(typeof item.price).toBe('number');
        }

        expect(typeof item.needsReview).toBe('boolean');
      });
    });
  });

  describe('Catalog Metadata', () => {
    it('should have valid extractedAt timestamp', () => {
      expect(catalog.extractedAt).toBeDefined();
      const timestamp = new Date(catalog.extractedAt);
      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp.getTime()).toBeGreaterThan(0);
    });

    it('all series should have required fields', () => {
      catalog.series.forEach((series) => {
        expect(series.seriesCode).toBeDefined();
        expect(typeof series.seriesCode).toBe('string');
        expect(series.seriesCode.length).toBeGreaterThan(0);

        expect(series.seriesName).toBeDefined();
        expect(typeof series.seriesName).toBe('string');
        expect(series.seriesName.length).toBeGreaterThan(0);

        expect(Array.isArray(series.products)).toBe(true);
      });
    });

    it('options should be a top-level global array on the catalog, not nested per series', () => {
      expect(Array.isArray(catalog.options)).toBe(true);
      expect(catalog.options.length).toBeGreaterThan(0);
    });
  });
});
