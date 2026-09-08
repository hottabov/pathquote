-- Drop Company.regionId.
--
-- A company is a client of the business, not of one office. Owner: a director
-- in the Australian head office can quote a European buyer without either of
-- them changing hands, so pinning the counterparty to a region was wrong in
-- the domain, and the field made the manager's own region a fence around who
-- they were allowed to file as a client.
--
-- Safe to drop because nothing read it for access control. Company reads are
-- scoped by ownerId alone (companyWhereForUser in src/lib/scope.ts) -- not one
-- db.company query ever had regionId in its where. Quote currency, tax rate
-- and discount/markup caps come from Document.regionId (the author's region),
-- never from the client's, so nothing about pricing shifts.
--
-- What is genuinely lost: assertRegionWritable ran on the three company write
-- paths (createCompany, updateCompany, createCompanyInline) and was the only
-- thing stopping a manager filing a company under another region's code. With
-- the column gone there is no foreign region to file under, so the guard has
-- no subject rather than a bypassed one. Region still guards prices
-- (priceWhereForUser) and document writes, which is where it belongs.
--
-- Destructive: the region each company was filed under is not recoverable from
-- another column. It was never used to decide anything, so nothing downstream
-- reads it back, but take the usual backup first.

-- DropForeignKey
ALTER TABLE "Company" DROP CONSTRAINT "Company_regionId_fkey";

-- AlterTable
ALTER TABLE "Company" DROP COLUMN "regionId";
