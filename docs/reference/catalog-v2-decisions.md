# Catalog v2 — owner decisions (2026-09-05)

Source of truth for `catalog-v2-target.json`. Audit: `docs/audit/` (proposal v1, v2).

## Rules

- **Existence**: US price list (`RAW/Price List North America (01-06-2026).xlsx`) decides what exists. Items only in AU are deleted. Items in DB but in neither list were entered by hand by the owner — keep.
- **AUD prices**: AU price list (`RAW/11 Price List Australia 2026-05-28.xlsx`). Missing AU price → 0 + `needsReview`.
- **Code**: `LETTER-HYPHEN-NUMBER` (`M-3180`, `X-10390`). `E` = extended length, `F` = felt belt. ≤ 16 chars, `[A-Z0-9-.]`, no spaces/parentheses/`#`. Old code kept in `legacyCodes`.
- **Name**: short, ≤ 50 chars. Machines: `M-Series Cutting Machine 3cm × 180cm` (lay height × cutting width), `L-Series Cutting Machine 320cm, Extended, Felt`.
- **Description**: full price-list text; obvious typos fixed (seperately→separately, verticaly→vertically, cartrige→cartridge, measurments→measurements, PathCutTM→PathCut™, "1200m"→"1200mm", L-320 "Width 226cm"→"320cm"); internal notes removed ("Do we eliminate this…", "jph to discuss…", "Not available for K5380").
- **Software is never a machine option** — products only. Option `PTW` deleted; its AU 3 500 becomes product `PTW-I` AU price. `PRA-L` deleted; product `PRA` = AU 3 500 / US 2 250.
- **Existing documents are demo data** — snapshots not migrated.
- New codes (PCH-*, RKT-*, DKT-*, DRV-28, NTT, DRL-*, WB-180, MTS-M, EL-xxxx-*, Crate-*) are provisional; director reviews at export (Phase 5).

## Products

| Decision | Detail |
|---|---|
| X-Calibre | Keep only `X-10180`, `X-10220` (US). Delete X-3180…X-7390, X-10390. AU price 0 (no AU list). |
| M-Series | All 16, codes hyphenated `M-3180`…`M-10390`. AU 0 for 300-width and M-3390. |
| L-Series | `L-180`, `L-180F`, `L-220`, `L-220F`, `L-320` (AU only), `L-320E` (US only), `L-320F`, **new** `L-320EF` (US 154 864 — moved off L-320F, whose US price becomes 0). Extended = separate machine; option `320-E` deleted (AU-only). `180-E`/`220-E` stay (both lists). |
| Software | `LS Convert`→`LSC` (AU 9 018 restored), `PTW(I)`→`PTW-I` (AU 3 500), `PTW(S)`→`PTW-S`. Delete `PTN`, `EDG` (AU-only). |
| EasyLoader / EasyFeeder | Keep 2020/2420/3220/4030 (US). AU price 0 where absent. EL product price 0 — assembled from options. |
| HDRF, FP-TROLLEY, RSP, RSP+, SERVICE, TRADE-IN | Keep as entered by owner. |
| Punchline | Not added. |

## Options

| Decision | Detail |
|---|---|
| Delete (AU-only) | VRB-180/200/220, EXH, Waste Bin-180, IKP, BED, EDS-500/800, DMT, 320-E, EL Sync (both widths). Drills — **pending** (F14 vs Q7). |
| Delete (software) | PTW, PRA-L. |
| Delete (duplicates) | `HDRF-xxx Crate- Wooden Crate for transport` ×3 (keep `HDRF-xxx Crate` rows → rename `Crate-HDRF-xxx`), `JetPen` (merge into `JTP`, prices 7 500 / 7 500). |
| Add (US) | `TR480` (M; US 2 716), `TR220` (M, X; US 5 036), `Crate-M-180` / `Crate-M-220` (AU 3 000 both; US 2 507 / 2 786) replacing `Crate-M`, `Crate-FP-180/220/300` (AU 1 200 all; US 1 254 / 1 400 / 1 600) replacing `Crate-FP`, `SVC-EF-INSTALL` (US price **pending**: 360 or 720), `Crate-EL` US 1 125. |
| Rename | L tools → `PCH-1.0…5.0`, `PCH-QR`, `RKT-28`, `RKT-40`, `DKT-30`, `DKT-45`, `DRV-28`, `NTT`; `MTS- additional travel p/Metre`→`MTS-M`; EL options → `EL-xxxx-DM1/DM12/ST12/BB12/RL12/RF`, roll holders → `ST620-2020`/`ST620-2420`; `Crate-180/220/320`→`Crate-L-180/220/320`; `SVC-L-INSTALL`→`SVC-L-INSTALL-S` (L-180, L-180E, L-220), `SVC-L-INSTALL-MTS`→`SVC-L-INSTALL-L` (L-220E, L-320E). |
| EL busbar | Name "Electrical Busbar 1.2m" (AU/Brain), not "Electrical Runner" (US). 2420 roll holder = `ST620-2420`. |
| OFJ | M/X only (not L). |
| X compat | **pending** — restrict to US X-sheet list? |
| Crate noCommission | true for every crate (Crate-220 was false). |
| EL Drive Module | Stays an option (`EL-xxxx-DM1`); EL product price 0. Seed's `RETIRED_OPTION_CODES` entry removed. |
