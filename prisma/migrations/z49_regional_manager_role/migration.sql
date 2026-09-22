-- Adds REGIONAL_MANAGER to the Role enum: a MANAGER whose read and write
-- scope is their whole region (every Document with that regionId, every
-- Company owned by a user of that region) instead of just their own rows.
-- It carries NO admin rights -- see isRegionalManagerRole, src/lib/roles.ts.
--
-- Postgres can append a value to an enum type but can never drop one (the
-- same constraint z23_developer_role documents), so if this role is ever
-- retired the fix is to stop assigning it, not to remove it from the type.
-- The value is appended here and listed between MANAGER and DEVELOPER in
-- schema.prisma for readability; the two orderings differ and nothing in the
-- app compares roles ordinally.
ALTER TYPE "Role" ADD VALUE 'REGIONAL_MANAGER';

-- A regional manager's client list filters Company through its owner's
-- region, which is the first query here to select User BY region.
CREATE INDEX "User_regionId_idx" ON "User"("regionId");
