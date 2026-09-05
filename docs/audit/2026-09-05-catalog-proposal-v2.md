# PathQuote — Catalog cleanup, аудит v2 (звірка DB ↔ US ↔ AU)

**Статус: ПРОПОЗИЦІЯ. У продукті нічого не змінено. Чекаю на добро.**

Дата: 2026-09-05.
Джерела: локальна DB (`RAW/catalog-dump.json`, 68 products / 108 options), `RAW/Price List North America (01-06-2026).xlsx` (**US — що існує**), `RAW/11 Price List Australia 2026-05-28.xlsx` (**AU — базові ціни**), Pathfinder Brain.

Прийняті рішення (з твоїх відповідей):
- Код = `Буква-Дефіс-Номер`: `M-3180`, `X-10390`. `E` = extended, `F` = felt.
- Назва машини: `M-Series Cutting Machine 3cm × 180cm`.
- Software ніколи не опція машини → опція `PTW` видаляється, є лише product.
- Що існує — вирішує US-список. AU — джерело AUD цін.
- Service (RSP, RSP+, SERVICE, TRADE-IN + SVC-*) — вже зроблено, не чіпаю.
- Нові коди даю сам; погодиш з директором на етапі експорту.
- Дрібні помилки в описах виправляю автоматично.

---

## 0. Головні знахідки звірки (те, що треба знати до всього іншого)

| # | Знахідка | Де | Наслідок |
|---|---|---|---|
| F1 | **X-Series в AU-списку взагалі немає.** В DB X має AUD ціни, скопійовані з M (X-10180 AU 212 500 = M10180 AU 212 500). | DB vs AU | AUD-ціни на X — вигадані екстрактором. Питання Q1 |
| F2 | **US має лише 2 X-моделі: X10180, X10220.** В DB — 12 (X-3180 … X-10390). | DB vs US | 10 X-продуктів не існують у US. Питання Q1 |
| F3 | **US `L-320EF` помилково злитий у `L-320F`.** Скрипт `extract-us-prices.ts` перейменовує `L-320EF → L-320F`. У DB `L-320F` US = 154 864 — це ціна L-320**E**F (extended+felt), а не L-320F. | DB vs US | Ціна неправильна. Треба окремий product `L-320EF`. Питання Q2 |
| F4 | **`LS Convert` AU = 0 у DB, але AU-список має 9 018.** | DB vs AU | Втрачена ціна. Виправити |
| F5 | **`PTW(I)` AU = 0 у DB.** AU-список має PTW як опцію на M і L по 3 500. Ти сказав — software не опція. | DB vs AU | Product `PTW-I` AU = 3 500, опція `PTW` видаляється |
| F6 | **Трансформатори `TR480`, `TR220` є в US, немає в DB.** TR480 (M): 2 716 USD. TR220 (M, X): 5 036 USD. | US vs DB | Додати 2 опції |
| F7 | **US Crate для M/X — по ширині:** `Crate M180` 2 507, `Crate M220` 2 786. DB має один `Crate-M` (AU 3 000, US нема). | US vs DB | Питання Q3 |
| F8 | **HDRF crates у DB подвоєні**: `HDRF-180 Crate` (nc=true) і `HDRF-180 Crate- Wooden Crate for transport` (nc=false) — те саме, двічі, для всіх 3 ширин. | DB | 3 зайвих опції видалити |
| F9 | **`JTP` (AU 0) і `JetPen` (7 500/7 500) — один товар двічі.** | DB | Злити в `JTP` з цінами 7 500 |
| F10 | **`PRA-L` (AU 2 200, L-sheet) vs product `PRA` (AU 3 500, Software-sheet; US 2 250).** Два різні AUD-прайси на одне ПЗ. | AU | Питання Q4 |
| F11 | **L-Series інсталяція в US — за розміром машини, не за MTS.** US: "L180, L180E, L220 Install" 6 900 / "L220E, L320E Install" 8 820. DB назвала їх `SVC-L-INSTALL` (no MTS) / `SVC-L-INSTALL-MTS`. У L-Series MTS немає взагалі. | US vs DB | Перейменувати/переописати 2 SVC-опції |
| F12 | **EasyFeeder Installation** є в US (360 для 2020/2420, 720 для 3220/4030), в DB немає. | US vs DB | Додати `SVC-EF-INSTALL` |
| F13 | **EL-3220 / EL-4030 / EF-3220 / EF-4030** — є в US, отже існують (Brain про 4120 — ігноруємо). AU ціни = 0, це нормально (в AU не продаються). | US | Лишаємо як є |
| F14 | **AU-only товари, яких немає в US**: VRB-180/200/220, EXH, Waste Bin-180, IKP, BED, EDS-500/800, DMT, Drills×2, PTN, EDG, 320-E, EL Sync, FM180, Punchline P-180/P-220. | AU vs US | Питання Q5 |
| F15 | **DB-only товари, яких немає в жодному списку**: FP-TROLLEY (AU 0), Crate-EL (AU 1 400), HDRF AU-ціни (17 500 / 19 500 / 21 400), SVC-HDRF-INSTALL AU 300, TPL. | DB | Питання Q6 |
| F16 | **M-Series 300-ширина (M3300/M5300/M7300/M10300)**: тільки US. AU=0. Норм. M3390 в AU без ціни (порожня клітинка) — теж 0. | — | Лишаємо |
| F17 | EL Roll Holder для 2420 в US-списку підписаний `#ST620-2020` (copy-paste). AU каже `ST620-2420`. | US | Беремо ST620-2420 |
| F18 | US EL називає busbar **"Electrical Runner"**, AU — **"Electrical Busbar"**. Один товар. | US vs AU | Назва: Electrical Busbar (як AU/Brain) |
| F19 | В US X-sheet опція MTS описана "Not available for **K5380**" — legacy K-series текст. | US | Опис беремо з AU ("Not available for Mx390") |

---

## 1. Архітектура (без змін проти v1, коротко)

`code` = label, мутабельний. Логіка — на `id` + явних атрибутах: `Product.kind`, `Product.form`, `Product.specs{cutHeightCm, cutWidthCm, tableWidthMm, extended, belt}`, `Option.role`, `Option.parentProductId`, `Option.unitLengthM`, `legacyCodes[]`. 4 фази (додати колонки+backfill → переключити читачів → перейменувати → видалити regex). Деталі і повна карта 60 залежностей — у v1, Додаток A.

**Важливо для фази 3 з огляду на рішення "M-3180 з дефісом":** `specs/m-series.ts:4` regex `/^M(3|5|7|10)(180|220|300|390)$/` — без дефіса, зламається. `machine-specs.ts:38` `/^[MX]-?…/` — дефіс optional, витримає. `seed.ts:207` вже робив `XC-####→X-####`, тобто прецедент є. Це підтверджує: спочатку фаза 1–2, потім перейменування.

---

## 2. Цільовий каталог — PRODUCTS

Легенда: **AU** / **US** — ціни після звірки. `—` = не продається в регіоні (ціна 0, `needsReview`). ⚠️ = зміна проти DB.

### 2.1 M-Series (form: M_SERIES, kind: MACHINE)

| code (DB → нове) | name | AU | US |
|---|---|---|---|
| M3180 → **M-3180** | M-Series Cutting Machine 3cm × 180cm | 175 000 | 163 350 |
| M3220 → **M-3220** | M-Series Cutting Machine 3cm × 227cm | 188 000 | 176 715 |
| M3300 → **M-3300** | M-Series Cutting Machine 3cm × 300cm | — | 235 950 |
| M3390 → **M-3390** | M-Series Cutting Machine 3cm × 390cm | — | 247 500 |
| M5180 → **M-5180** | M-Series Cutting Machine 5cm × 180cm | 195 000 | 170 775 |
| M5220 → **M-5220** | … 5cm × 227cm | 208 000 | 184 140 |
| M5300 → **M-5300** | … 5cm × 300cm | — | 246 748 |
| M5390 → **M-5390** | … 5cm × 390cm | 245 000 | 289 575 |
| M7180 → **M-7180** | … 7cm × 180cm | 207 500 | 178 200 |
| M7220 → **M-7220** | … 7cm × 227cm | 220 500 | 191 565 |
| M7300 → **M-7300** | … 7cm × 300cm | — | 256 697 |
| M7390 → **M-7390** | … 7cm × 390cm | 257 000 | 297 000 |
| M10180 → **M-10180** | … 10cm × 180cm | 212 500 | 185 625 |
| M10220 → **M-10220** | … 10cm × 227cm | 225 500 | 198 990 |
| M10300 → **M-10300** | … 10cm × 300cm | — | 266 647 |
| M10390 → **M-10390** | … 10cm × 390cm | 262 000 | 304 425 |

description: як є ("Computer controlled cutting machine - 3cm compressed lay height, 180cm cutting width").

### 2.2 X-Calibre — залежить від Q1

Мінімальний варіант (тільки те, що є в US):

| code | name | AU | US |
|---|---|---|---|
| X-10180 | X-Calibre Cutting Machine 10cm × 180cm | ⚠️ ? | 248 000 |
| X-10220 | X-Calibre Cutting Machine 10cm × 227cm | ⚠️ ? | 262 000 |

Решта 10 (X-3180 … X-7390, X-10390) — `active: false` або видалити. Див. Q1.

### 2.3 L-Series (form: немає, kind: MACHINE) — залежить від Q2

| code | name | AU | US | note |
|---|---|---|---|---|
| L-180 | L-Series Cutting Machine 180cm | 135 000 | 118 029 | |
| L-180F | L-Series Cutting Machine 180cm, Felt | 130 000 | 113 657 | |
| L-220 | L-Series Cutting Machine 226cm | 150 000 | 131 143 | |
| L-220F | L-Series Cutting Machine 226cm, Felt | 145 000 | 126 771 | |
| L-320 | L-Series Cutting Machine 320cm | 170 000 | — | ⚠️ desc "Width 226cm" → "320cm" |
| L-320E | L-Series Cutting Machine 320cm, Extended | — | 159 235 | ⚠️ desc "Width 226cm" → "320cm", додати "Extended length." |
| L-320F | L-Series Cutting Machine 320cm, Felt | 165 000 | ⚠️ **—** (зараз 154 864 — це ціна L-320EF) | |
| ⚠️ **L-320EF** (новий) | L-Series Cutting Machine 320cm, Extended, Felt | — | 154 864 | |

### 2.4 Software (kind: SOFTWARE)

| code (DB → нове) | name | AU | US |
|---|---|---|---|
| ANT-V5 | Automatic Nester V5 | 8 320 | 6 429 |
| ANT-V6 | Automatic Nester V6 | 11 720 | 9 054 |
| EDG | External Digitizer | 1 114 | — |
| LS Convert → **LSC** | LS Convert | ⚠️ **9 018** (було 0) | 9 750 |
| PDG | PhotoDigitiser | 1 800 | 2 089 |
| PRA | Production Analyst | 3 500 (див. Q4) | 2 250 |
| PTN | Photo Nesting | 20 577 | — |
| PTW(I) → **PTW-I** | PathWorks Integrated | ⚠️ **3 500** (було 0; з опції PTW) | 2 786 |
| PTW(S) → **PTW-S** | PathWorks Standalone | 4 000 | 3 621 |
| WPL | PoolLiner Wizard | 5 850 | 5 432 |
| WPN | Panel Wizard | 500 | 696 |

description: як є, виправлено "measurments"→"measurements", "PathCutTM"→"PathCut™", "Digitizing"→"Digitising" (AU English).

### 2.5 Leather Nesting System, EasyLoader, EasyFeeder, HDRF, FabricPro

| code | name | AU | US | note |
|---|---|---|---|---|
| LNS-2020 / 2420 / 3220 | Leather Nesting System 2020 / 2420 / 3220 | 36 712 / 38 547.60 / 40 474.98 | 27 534 / 28 911 / 30 356 | desc: повний список a–f, як є |
| EL-2020 / 2420 / 3220 / 4030 | EasyLoader 2020 / … | 0 / 0 / — / — | 0 / 0 / 0 / 0 | ціна = з модулів (опції). desc як є |
| EF-2020 / 2420 / 3220 / 4030 | EasyFeeder 2020 / … | 10 400 / 10 860 / — / 17 540 | 16 714 / 17 829 / 27 161 / 29 250 | ⚠️ desc "1200m length" → "1200mm length" |
| HDRF-180 / 220 / 320 | Heavy Duty Roll Feeder 180 / 220 / 320 | 17 500 / 19 500 / 21 400 (Q6) | 12 500 / 13 900 / 15 290 | desc як є |
| FP-180 / 220 / 300 | FabricPro Spreader 180cm / 220cm / 300cm | 64 000 / 67 000 / — | 42 000 / 50 250 / 68 000 | desc як є |
| FP-TROLLEY | Fabric Roll Trolley | 0 (Q6) | — | |

### 2.6 Service — не чіпаю (RSP, RSP+, SERVICE, TRADE-IN).

---

## 3. Цільовий каталог — OPTIONS

### 3.1 M / X (compat: M, X)

| code (DB → нове) | name | role | AU | US | note |
|---|---|---|---|---|---|
| ABR-M | Air Brush | ABR | 1 950 | 2 507 | |
| AFP | Automatic Foot Pressure | AFP | 1 560 | 1 671 | US X-sheet: "Included as standard" на X |
| APM-M | Adaptive Pattern Matching | APM | 15 000 | 19 500 | |
| BCR-M | Barcode Scanner | BCR | 2 500 | 1 462.50 | |
| BED | Bed Projector | BED | 10 000 | — | |
| Crate-M → див. Q3 | Wooden Crate | CRATE | 3 000 | 2 507 / 2 786 | |
| DMT | DuctMaster | DMT | 18 240 | — | |
| DR2 | Secondary Drill Unit | DR2 | 6 200 | 5 850 | |
| DRG-1 | Drag Knife, Olfa 45° | DRG | 2 535 | 2 674 | |
| DRG-2 | Drag Knife, Excellite 21° | DRG | 2 496 | 2 674 | |
| DRG-3 | Drag Knife, Carbide 45° | DRG | 2 496 | 2 674 | |
| Drills included → **DRL-6** | Drills 2301071-7-6 | — | 350 | — | desc: "Drill set, part 2301071-7-6" (Q7) |
| Drills included 2301071-7-10 → **DRL-10** | Drills 2301071-7-10 | — | 375 | — | |
| EDS-500 | Edge Sealer Static 500mm | EDS | 850 | — | |
| EDS-800 | Edge Sealer Static 800mm | EDS | 950 | — | |
| EXH | Exhaust Option | EXH | 1 000 | — | desc "verticaly"→"vertically" |
| HDC-M | HeadCam | HDC | 5 000 | 2 785.71 | |
| HFV-M | High Flow Vacuum 22kW | HFV | 4 400 | 6 129 | US X: standard |
| IJP | Ink Jet Printer | IJP | 6 552 | 7 020 | desc "cartrige"→"cartridge" |
| IKA | IceKnife Air | IKA | 3 800 | 3 970 | US X: standard |
| IKP | IceKnife Liquid | IKP | 4 940 | — | |
| MRK | Marking Tool | MRK | 1 950 | 2 507 | |
| MTS | Machine Transfer System | MTS | 15 000 | 10 446.43 | desc з AU |
| MTS- additional travel p/Metre → **MTS-M** | MTS Additional Travel, per metre | MTS_TRAVEL | 585 | 626.79 | unitLengthM=1 |
| OFD-M | Offload Display | OFD | 3 200 | 1 950 | |
| OFJ | Offload Projector | OFJ | 7 200 | 3 907.50 | |
| OFP-M | Offload Printer | OFP | 3 900 | 3 133.93 | |
| PM-M | Pattern Match | PM | 2 786 | 2 089 | |
| PRM-M | Production Manager | PRM | 5 000 | 3 214.29 | |
| ~~PTW~~ | — | — | — | — | ⚠️ **видалити** (F5) |
| ⚠️ **TR480** (новий, compat M) | Transformer 480V→380V, Integrated | TRANSFORMER | — | 2 716 | desc з US |
| ⚠️ **TR220** (новий, compat M, X) | Transformer 220V→380/415V, Standalone | TRANSFORMER | — | 5 036 | desc з US |
| VRB-180 / 200 / 220 | Vacuum Resealing Blind 180 / 200 / 220 | VRB | 4 100 / 4 200 / 4 300 | — | |
| Waste Bin-180 → **WB-180** | Waste Bin, Mx180 | — | 963 | — | desc: прибрати внутрішню нотатку "Do we eliminate this…" |

### 3.2 L-Series (compat: L)

| code (DB → нове) | name | AU | US | note |
|---|---|---|---|---|
| 1.0mm dia punch → **PCH-1.0** | Punch 1.0mm | 100 | 80 | US: noCommission ✓ |
| 2.0mm dia punch → **PCH-2.0** | Punch 2.0mm | 100 | 80 | |
| 3.0mm dia punch → **PCH-3.0** | Punch 3.0mm | 100 | 80 | (в обох списках рядок продубльований — беремо один) |
| 4.0mm dia punch → **PCH-4.0** | Punch 4.0mm | 100 | 80 | |
| 5.0mm dia punch → **PCH-5.0** | Punch 5.0mm | 100 | 80 | |
| Punch Tool- Quick Release (…) → **PCH-QR** | Punch Tool, Quick Release | 450 | 362 | desc: "seperately"→"separately" |
| 28 Dia. Round Knife Tool… → **RKT-28** | Round Knife Tool 28mm | 580 | 466 | |
| 40 Dia. Round Knife Tool… → **RKT-40** | Round Knife Tool 40mm | 630 | 506 | AU: "(Not available yet)", US: "(Not used on Felt bed)". Беру US текст (новіший). |
| Drag Knife Tool… 30 deg → **DKT-30** | Drag Knife Tool 30°, Quick Release | 730 | 587 | |
| Drag Knife Tool… 45 deg? → **DKT-45** | Drag Knife Tool 45°, Quick Release | 730 | 587 | прибрати "?" |
| Driven- Electrically driven… → **DRV-28** | Driven Knife 28mm | 6 400 | 5 143 | desc з US (додає "Only used with Felt cutting belt") |
| Notch Tool- Quick Release (…) → **NTT** | Notch Tool, Quick Release | 950 | 763 | |
| 180-E / 220-E | Extended Length, L-180 / L-220 | 6 000 / 8 000 | 5 304 / 7 071 | коди лишаю (є в обох списках) |
| 320-E | Extended Length, L-320 | 12 000 | — | AU-only (US продає L-320E як машину). Q2 |
| Crate-180 / 220 / 320 | Wooden Crate, L-180 / L-220 / L-320 | 1 200 / 1 500 / 1 800 | 2 507 / 2 786 / 3 000 | desc: "Wooden crate for transport". noCommission ✓ для всіх трьох (зараз Crate-220 = false — помилка) |
| ABR-L | Air Brush | 2 100 | 2 507 | |
| APM-L | Adaptive Pattern Matching | 8 000 | 19 500 | |
| BCR-L | Barcode Scanner | 1 050 | 1 463 | |
| HDC-L | HeadCam | 2 000 | 2 786 | |
| HFV-L | High Flow Vacuum 15kW | 16 000 | 17 143 | desc з AU |
| JTP + JetPen → **JTP** | JetPen Marking Tool | 7 500 | 7 500 | ⚠️ злити (F9). desc: "JetPen marking tool — non-contact high speed ink marking. Replaces the standard marking tool." |
| OFD-L | Offload Display | 1 400 | 1 950 | |
| OFP-L | Offload Printer | 2 250 | 3 134 | |
| PM-L | Pattern Match | 1 500 | 2 089 | |
| PRM-L | Production Manager | 2 620 | 3 214 | |
| PRA-L | — | 2 200 | — | ⚠️ Q4 |
| ⚠️ US також дає OFJ на L (3 908) — в DB OFJ тільки M/X | | | | Q8 |

### 3.3 EasyLoader (× 2020 / 2420 / 3220 / 4030; parentProductId = EL-xxxx)

| code (нове) | name | role | unitLengthM | AU 2020/2420 | US 2020/2420/3220/4030 |
|---|---|---|---|---|---|
| EL-xxxx-DM1 | Drive Module, first 1.2m | EL_DRIVE | 1.2 | 4 050 / 4 455 | 6 936 / 7 340 / 12 480 / 12 480 |
| EL-xxxx-DM12 | Conveyor Module 1.2m | EL_CONVEYOR | 1.2 | 1 200 / 1 320 | 1 337 / 1 741 / 2 406 / 2 406 |
| EL-xxxx-ST12 | Static Table 1.2m | EL_STATIC | 1.2 | 743 / 780 | 557 / 585 / 1 003 / 1 003 |
| EL-xxxx-BB12 | Electrical Busbar 1.2m | EL_BUSBAR | 1.2 | 120 / 120 | 209 ×4 |
| EL-xxxx-RL12 | Platform Support Rail 1.2m | EL_RAIL | 1.2 | 45 / 45 | 161 ×4 |
| EL-2020-RF, EL-2420-RF | Single Roll Feed Attachment | EL_ROLL_FEED | — | 735 / 780 | 613 / 641 (3220/4030 — нема в US) |
| EL-2020-SYNC, EL-2420-SYNC | Synchronisation with Cutter | EL_SYNC | — | 1 500 / 1 500 | — (AU-only, Q5) |
| ST620-2020, ST620-2420 | Paper Roll Holder | EL_ROLL_HOLDER | — | 1 040 / 1 080 | 1 003 / 1 031 |
| Crate-EL | Wooden Crate | CRATE | — | 1 400 (Q6) | ⚠️ **1 125** (є в US для всіх 4, в DB US нема) |

Описи — повні з AU (Busbar: "Electrical busbar per 1.2m. Required for use with FabricPro automatic spreader." — з приміткою "*Required for FabricPro" з AU B10/B11).

### 3.4 Інші

| code (DB → нове) | name | AU | US | note |
|---|---|---|---|---|
| Crate-FP | Wooden Crate | 1 200 | 1 254 | ⚠️ US дає різні ціни по ширині: 1 254 / 1 400 / 1 600 для FP-180/220/300. Q3 |
| HDRF-180 Crate + HDRF-180 Crate- Wooden… → **Crate-HDRF-180** | Wooden Crate | 1 800 | 1 254 | ⚠️ дедуп (F8) |
| … → **Crate-HDRF-220** | Wooden Crate | 2 000 | 1 400 | |
| … → **Crate-HDRF-320** | Wooden Crate | 2 300 | 1 600 | |
| TPL | Travelling Operator Platform | 0 | 0 | Q6 |
| SVC-L-INSTALL → **SVC-L-INSTALL-S** | L-Series Installation & Training (L-180, L-180E, L-220) | 0 | 6 900 | ⚠️ F11 |
| SVC-L-INSTALL-MTS → **SVC-L-INSTALL-L** | L-Series Installation & Training (L-220E, L-320E) | 0 | 8 820 | ⚠️ F11 |
| ⚠️ **SVC-EF-INSTALL** (новий) | EasyFeeder Installation (3 hrs) | — | 360 (2020/2420) / 720 (3220/4030) | F12. Одна опція з двома цінами не влізе → 2 опції `SVC-EF-INSTALL-S` / `-L`, або компат по продукту. Q9 |
| решта SVC-* | як є | | | |

---

## 4. Питання (з прикладами)

**Q1. X-Calibre — які моделі існують і які AUD ціни?**
US-список має лише X10180 (248 000 USD) і X10220 (262 000 USD). AU-списку для X немає взагалі. У DB зараз 12 X-моделей, і AUD-ціна X-10180 = 212 500 — це просто скопійована ціна M10180.
Приклад: якщо продавець в Австралії відкриє квоту і вибере X-5390, він побачить 245 000 AUD — ціну M5390, яку ніхто для X не затверджував.
Варіанти: (a) лишити тільки X-10180 і X-10220, AUD = 0 / needsReview; (b) лишити тільки ці дві, AUD = як у M (свідомо); (c) лишити всі 12. Що обираєш?

**Q2. L-320 Extended — це окрема машина чи опція?**
AU: машина `L-320` 170 000 + опція `320-E` 12 000. US: одразу машина `L-320E` 159 235, опції 320-E нема. Плюс US має `L-320EF` (extended + felt) 154 864, якої в DB немає — її ціна помилково записана на `L-320F`.
Приклад: американський продавець хоче L-320 felt без extended — в DB він побачить 154 864, а це ціна extended-версії.
Пропоную: продукти L-320, L-320E, L-320F, L-320EF (усі 4), опція 320-E лишається для AU. ОК?

**Q3. Ящики (Crate) для M/X і FabricPro — один код чи по ширині?**
US: "Crate M180" 2 507, "Crate M220" 2 786; FabricPro crate 1 254 / 1 400 / 1 600 для 180/220/300. AU: один "Crate" 3 000 для M, один 1 200 для FP.
Приклад: продавець вибирає M-7220 в US — яка ціна ящика? Потрібно 2 786, а DB дає одну на всі.
Пропоную: `Crate-M-180`, `Crate-M-220` (AU 3 000 обидва, US 2 507 / 2 786); `Crate-FP-180/220/300` (AU 1 200 всі, US 1 254 / 1 400 / 1 600). Для M-300/390 ящика в жодному списку немає — лишаємо без. ОК?

**Q4. Production Analyst — 2 200 чи 3 500 AUD?**
AU L-Series sheet: PRA 2 200. AU Software sheet: PRA 3 500. US: 2 250. Ти сказав software — тільки product. Але тоді хтось, хто купує L-Series, платитиме 3 500 замість 2 200.
Варіанти: (a) один product PRA, AU 3 500 — L-клієнти платять більше; (b) один product PRA, AU 2 200; (c) лишити PRA-L як виняток. Що обираєш?

**Q5. AU-only товари — лишаємо?**
Немає в US, є в AU: VRB-180/200/220, EXH, Waste Bin-180, IKP, BED, EDS-500/800, DMT, Drills ×2, PTN, EDG, 320-E, EL Sync, FM180 (вже видалений), Punchline P-180/P-220 (не в DB).
Ти сказав "US = що існує". Дослівно це означає видалити всі ці 15. Але вони мають AUD-ціни і, можливо, продаються в Австралії.
Пропоную: лишити активними з AU-ціною, US = 0. Punchline не додавати (Brain: "Do not write about Punchline yet"). ОК?

**Q6. DB-only товари, яких немає в жодному прайсі — звідки ціни?**
FP-TROLLEY (AU 0), Crate-EL (AU 1 400), HDRF-180/220/320 AUD 17 500 / 19 500 / 21 400, SVC-HDRF-INSTALL AU 300, TPL (0).
Приклад: HDRF-180 AU 17 500 — в AU-списку сторінки HDRF взагалі немає. Це ти вводив вручну (тоді ОК) чи це артефакт імпорту (тоді треба needsReview)?

**Q7. "Drills included 2301071-7-6" / "-7-10" — що це?**
AU M-sheet, 350 / 375 AUD, назва = номер деталі. Схоже на набір свердел. Пропоную коди DRL-6 / DRL-10, назва "Drill Set 2301071-7-6". Якщо це не свердла — скажи, що це.

**Q8. Offload Projector (OFJ) на L-Series?**
US L-sheet має OFJ 3 908, AU L-sheet — ні. DB: OFJ тільки M/X.
Додати `OFJ-L` (AU 0, US 3 908)?

**Q9. Інсталяція EasyFeeder — як дати дві ціни?**
US: 360 для EF-2020/2420, 720 для EF-3220/4030. Одна опція = одна ціна на регіон.
Варіанти: (a) дві опції `SVC-EF-INSTALL-S` (2020/2420) і `SVC-EF-INSTALL-L` (3220/4030); (b) одна опція 360, продавець сам подвоює qty. Пропоную (a).

**Q10. EL Drive Module — опція чи вже сам продукт?**
Зараз product EL-2020 має ціну 0, а опція "Drive Module (first 1.2M)" — 4 050. При цьому `prisma/seed.ts:69` позначає цю опцію як retired ("drive module → product EL-2020"), а DB її все одно має. Один із двох хтось забув.
Пропоную: лишити як в DB (product 0 + опція EL-2020-DM1), бо так працює EasyLoader builder. Seed підправлю. ОК?

---

## 5. Підсумок дій після твого "добро" (для орієнтиру)

1. Фаза 1–2 архітектури (нові колонки, backfill, переключення читачів). Без змін поведінки.
2. Дані: ~70 перейменувань кодів, ~150 назв, ~15 виправлень описів, 5 виправлень цін (F3, F4, F5, Crate-EL US, Crate-220 nc), 6 нових опцій (TR480, TR220, L-320EF, SVC-EF-INSTALL×2, + Q3/Q8), 5 видалень (PTW, JetPen-дубль, 3 HDRF-crate дублі).
3. Експорт таблиці для директора (окрема фаза, як домовились).
