-- Tools that ship with a consumable (a drag knife's blade, a punch's drill):
-- which consumables a tool takes, and the consumable line a quote writes
-- under the tool's own line. See OptionConsumable in schema.prisma.
CREATE TABLE "OptionConsumable" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "consumableId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OptionConsumable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OptionConsumable_toolId_consumableId_key" ON "OptionConsumable"("toolId", "consumableId");
CREATE INDEX "OptionConsumable_consumableId_idx" ON "OptionConsumable"("consumableId");

ALTER TABLE "OptionConsumable" ADD CONSTRAINT "OptionConsumable_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Option"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OptionConsumable" ADD CONSTRAINT "OptionConsumable_consumableId_fkey" FOREIGN KEY ("consumableId") REFERENCES "Option"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentLine" ADD COLUMN "parentLineId" TEXT;
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_parentLineId_fkey" FOREIGN KEY ("parentLineId") REFERENCES "DocumentLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "DocumentLine_parentLineId_idx" ON "DocumentLine"("parentLineId");
