-- Software sold as an option on a cutter (PTW-I, PRA, LSC and the PathWorks
-- modules) gets one role per program, so the PathWorks section of the
-- M-Series, X-Calibre and L-Series forms can tick each box from the option
-- line instead of sending it to the Additional items sheet.
--
-- Enum values only: a new value cannot be used in the same transaction that
-- adds it, so the rows are updated by z45.
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'PTW_I';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'PRA';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'LSC';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'PDG';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'WPN';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'WPL';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'ANT_V5';
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'ANT_V6';
