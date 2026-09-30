-- EasyLoader installation is priced per hour from the table's own modules
-- (src/lib/production-forms/el-install.ts), so its option needs a role of
-- its own to be found by -- INSTALL is shared by every other installation.
--
-- Enum value only: a new value cannot be used in the same transaction that
-- adds it, so the option row is updated by z57.
ALTER TYPE "OptionRole" ADD VALUE IF NOT EXISTS 'EL_INSTALL';
