-- The supply voltages were narrowed (src/lib/production-forms/voltage.ts):
-- an M-Series is ordered for 220 V, 400 V or 480 V (415 V is gone), an
-- X-Calibre for 400 V or 480 V. A stored answer that is no longer one of
-- them would fail the spec schema on the item's next save, so it is cleared
-- and the builder asks for the voltage again.
UPDATE "DocumentItem" i
   SET "productionSpec" = i."productionSpec" - 'voltage'
  FROM "Product" p
 WHERE p."id" = i."productId"
   AND (
     (p."form" = 'M_SERIES' AND i."productionSpec"->>'voltage' NOT IN ('220V', '400V', '480V'))
     OR (p."form" = 'X_CALIBRE' AND i."productionSpec"->>'voltage' NOT IN ('400V', '480V'))
   );
