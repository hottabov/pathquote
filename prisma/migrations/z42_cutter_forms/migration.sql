-- The two cutter forms that have never had an implementation: X-Calibre and
-- L-Series. Both are rendered as React components rather than by patching a
-- workbook (docs/superpowers/specs/2026-09-03-web-production-forms-design.md),
-- so this migration adds only the enum values that let a product point at
-- them; there are no templates to commit.
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'X_CALIBRE';
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'L_SERIES';
