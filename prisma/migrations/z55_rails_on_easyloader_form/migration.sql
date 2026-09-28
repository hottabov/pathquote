-- The FabricPro rails print on the EasyLoader form of every FabricPro
-- compatible table, at that table's length (src/lib/production-forms/rails.ts).
-- The FabricPro's own rail-length overrides are gone with them.
UPDATE "DocumentItem" i
   SET "productionSpec" = i."productionSpec" - 'railLengthM' - 'powerRailLengthM'
  FROM "Product" p
 WHERE p."id" = i."productId"
   AND p."form" = 'FABRICPRO'
   AND (i."productionSpec" ? 'railLengthM' OR i."productionSpec" ? 'powerRailLengthM');
