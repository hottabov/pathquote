# PathQuote — Catalog cleanup proposal

**Статус: ПРОПОЗИЦІЯ. Нічого в продукті не змінено. Чекаю на добро.**

Дата: 2026-09-05. Джерела: `prisma/seed-data/catalog.json`, `prisma/schema.prisma`, аудит коду `src/**`, `scripts/**`, Pathfinder Brain (`02 Products/*`, `10 Features/*`).

---

## Частина 1. Архітектура: код ≠ ідентичність

### Що є зараз

DB вже правильна: `Product.id` / `Option.id` — cuid, `code` — `@unique String`. Проблема не в схемі, а в коді застосунку: **~60 місць** де логіка читає *значення* рядка `code` і робить з нього висновки. Повна таблиця в Додатку A. Коротко — код таємно кодує 15 різних понять:

| # | Що закодовано в рядку `code` | Де | Приклад |
|---|---|---|---|
| 1 | Яку production-форму друкувати | `specs/*.ts`, `resolve.ts` | `/^M(3\|5\|7\|10)(180\|220\|300\|390)$/`, `/^EL-\d{4}$/`, `/^FP-(180\|220\|300)$/` |
| 2 | Чи це взагалі машина | `context.ts`, `quotation-data.ts` | `resolveForm(code) !== null`, `MACHINE_SERIES_CODES` |
| 3 | Висота/ширина різання, см | `machine-specs.ts` | парсинг цифр з `M3390`, `L-320F` — *важливіше за опис у каталозі* |
| 4 | Ширина столу / паперу, мм | `machine-specs.ts`, `easyloader.ts` | `EL-2020`→2020, `P-180`→1880 |
| 5 | Модель у серії → галочка на формі | `m-series.ts`, `fabricpro.ts` | `{"FP-180":"H27"}` |
| 6 | Вид EL-модуля (drive/conveyor/static/busbar/rail) | `table-sections.ts` | `` `${itemCode} ${EL_OPTION_SUFFIX[kind]}` `` |
| 7 | Опція → клітинка на формі (~25 прив'язок) | `m-series.ts:96-135` | `/^VRB/ /^HFV/ /^Crate/ /^DRG-3$/ …` |
| 8 | Ящик / roll holder / sync | `easyloader.ts` | `/Roll Holder/i`, `/Syncronisation/i`, `/^Crate-EL$/` |
| 9 | Software host vs module, standalone vs integrated | `production-forms-section.tsx`, `quotation-data.ts` | `PTW(I)`, `.includes("(S)")` |
| 10 | Який content-block описує товар у quotation | `quotation-data.ts` | `option.${code}`, `machine.m-series` |
| 11 | Серія, вшита в суфікс опції | `ABR-M` / `ABR-L` | consumer потім зрізає `/^ABR/` |
| 12 | Довжина одиниці (1.2 м) | `option-length.ts` | regex по `Option.name` |
| 13 | Product чи Option | `seed-lib.ts` | "в якому Set є код" |
| 14 | Retired/renamed identity | `seed.ts:67-88, 207-251` | 16 літералів + `XC-`→`X-` |
| 15 | Який файл картинки | `import-images-lib.ts` | `code.toLowerCase()+".svg"` |

Плюс **транспорт**: `addItem(documentId, productCode)`, `optionSelectionSchema.optionCode`, catalog-visibility по кодах — id вже є в picker'і, але по wire йде code.

Плюс **снапшоти**: `DocumentItem.code`, `DocumentLine.code` — вся логіка форм/блоків працює зі снапшоту, не з живого товару. Перейменуєш товар → старі й нові рядки того ж товару поводяться по-різному.

### Цільовий стан

**Принцип: `code` — це label. Мутабельний, unique, для людей і для друку. Жодна гілка `if` не дивиться на його значення.**

Замість цього — явні атрибути:

```prisma
enum ProductKind   { MACHINE TABLE FEEDER SPREADER SOFTWARE SYSTEM SERVICE CREDIT ACCESSORY }
enum ProductionForm { M_SERIES EASYLOADER FABRICPRO }

model Product {
  id          String   @id @default(cuid())
  code        String   @unique      // label, можна міняти
  legacyCodes String[] @default([]) // історія кодів: імпорт цін/картинок по старому коду не ламається
  kind        ProductKind
  form        ProductionForm?       // null = форми немає
  // specs Json вже є, зараз null для всіх. Заповнити типізовано:
  // { cutHeightCm, cutWidthCm, tableWidthMm, paperWidthMm, modelTier, extended, belt }
  contentBlockId String?
  ...
}

enum OptionRole {
  EL_DRIVE EL_CONVEYOR EL_STATIC EL_BUSBAR EL_RAIL EL_ROLL_FEED EL_ROLL_HOLDER EL_SYNC
  CRATE MTS MTS_TRAVEL VRB HFV OFJ OFD OFP PM APM PRM DMT DRG MRK IJP HDC ABR BCR DR2 IKA IKP AFP
  SW_MODULE INSTALL TRAINING ...
}

model Option {
  id            String  @id @default(cuid())
  code          String  @unique
  legacyCodes   String[] @default([])
  role          OptionRole?      // що це за річ — для галочок, для derived-логіки
  parentProductId String?        // EL-2020-DM12 належить EL-2020 (замість парсингу префікса)
  unitLengthM   Decimal?         // 1.2 — замість regex по name
  contentBlockId String?
  ...
}

model DocumentItem { ... productId; code/name/description = snapshot для друку; kind/form = snapshot теж }
model DocumentLine { ... refId → Option.id; code/name = snapshot; role = snapshot }
```

Галочки на формах: `m-series.ts` замість 25 regex — мапа `OptionRole → cell`. EL derived options: `findOption({ parentProductId, role })` замість `${code} ${suffix}`.

### План міграції (безпечний, 4 фази)

| Фаза | Що | Ризик | Поведінка |
|---|---|---|---|
| 1 | Додати колонки `kind/form/role/parentProductId/unitLengthM/legacyCodes`, заповнити **backfill-скриптом з поточних regex** (regex один раз стають даними). Тести: для кожного товару `resolveForm(code) === product.form`. | низький | без змін |
| 2 | Перевести читачів на нові колонки: `resolveForm(product)`, ticks по `role`, `machine-specs` зі `specs`, wire на `productId/optionId`. Старі regex залишаються як assert у тестах. | середній | без змін для користувача |
| 3 | Перейменувати коди/назви/описи (Частина 2). `legacyCodes` = старий код. Снапшоти в існуючих документах **не чіпаємо** (надруковані quote мають лишитись як були). | низький | нові quote — нові коди |
| 4 | Видалити regex, `EL_OPTION_SUFFIX`, `RETIRED_OPTION_CODES`, `PRINTED_WIDTHS`, `MACHINE_SERIES_CODES`. | низький | — |

Після фази 2 директор міняє код у admin UI — і нічого не ламається. Саме це і є ціль.

**Питання до тебе (арх.):**
1. Існуючі документи в проді: скільки їх? Фаза 3 їх не чіпає, але при redraw старого quote він побачить старий код у снапшоті — ОК?
2. `legacyCodes` як масив на товарі vs окрема таблиця `CodeAlias` — масив простіший, беру його, якщо не проти.

---

## Частина 2. Порядок у каталозі: code / name / description

### Правила

- **code** — короткий ідентифікатор для людей. ≤ 16 символів, `[A-Z0-9-]`, без пробілів/дужок/`#`. Збігається з price list де можливо (Brain: *"Quotes and price lists → follow the price list's own codes so they match the order"*).
- **name** — одне коротке речення, ≤ 50 символів, без "Computer controlled…". Те, що видно у списку і на рядку quote.
- **description** — повний текст як є (лише виправлені фактичні помилки, позначені ⚠️).

### 2.1 Machines

| code | name (нове) | description | note |
|---|---|---|---|
| M3180 | M-Series Cutting Machine 3cm × 180cm | як є | лишаю без дефісу — так у price list |
| M3220 | M-Series Cutting Machine 3cm × 227cm | як є | |
| M3300 | M-Series Cutting Machine 3cm × 300cm | як є | |
| M3390 | M-Series Cutting Machine 3cm × 390cm | як є | |
| M5180 … M5390 | M-Series Cutting Machine 5cm × … | як є | |
| M7180 … M7390 | M-Series Cutting Machine 7cm × … | як є | |
| M10180 … M10390 | M-Series Cutting Machine 10cm × … | як є | |
| X-3180 … X-10390 | X-Calibre Cutting Machine 3cm × 180cm … | як є | ⚠️ X має дефіс, M — ні. Price list так пише. Уніфікувати? (Brain: PR0001 допускає обидва) |
| L-180 | L-Series Cutting Machine 180cm | як є | belt: urethane |
| L-180F | L-Series Cutting Machine 180cm, Felt | як є | |
| L-220 | L-Series Cutting Machine 226cm | як є | |
| L-220F | L-Series Cutting Machine 226cm, Felt | як є | |
| L-320 | L-Series Cutting Machine 320cm | ⚠️ desc каже "Width 226cm" — copy-paste помилка, Brain підтверджує 3200mm. Виправити на 320cm | |
| L-320E | L-Series Cutting Machine 320cm, Extended | ⚠️ те саме 226→320; desc не згадує extended | |
| L-320F | L-Series Cutting Machine 320cm, Felt | як є | |
| FP-180 | FabricPro Spreader 180cm | як є | |
| FP-220 | FabricPro Spreader 220cm | як є | |
| FP-300 | FabricPro Spreader 300cm | як є | |

Формат "3cm × 180cm" = lay height × cutting width. Brain: *"L-Series model name refers to cutting WIDTH, M-Series to cutting HEIGHT — easiest mistake to make"*, тому в назві обидва числа з підписом через `×`. Альтернатива: "M-Series 3cm lay, 180cm wide" — скажи, що читається краще.

### 2.2 Tables / feeders / handling

| code | name | description | note |
|---|---|---|---|
| EL-2020 | EasyLoader 2020 | як є | вже ОК |
| EL-2420 | EasyLoader 2420 | як є | |
| EL-3220 | EasyLoader 3220 | як є | |
| EL-4030 | EasyLoader 4030 | як є | ⚠️ Brain: брошура має **EL-4120**, 4030 ніде не існує. Перевірити з production |
| EF-2020 … EF-3220 | EasyFeeder 2020 … | як є ("1200m length" → ⚠️ 1200mm) | |
| EF-4030 | EasyFeeder 4030 | | ⚠️ Brain: брошура **EF-4120**, "4030 does not exist". Перевірити |
| HDRF-180/220/320 | Heavy Duty Roll Feeder 180/220/320 | як є | ОК |
| FP-TROLLEY | Fabric Roll Trolley | як є | ОК |
| LNS-2020/2420/3220 | Leather Nesting System 2020/… | як є (повний список a-f) | ⚠️ Brain: PR0001 каже "Station", price list "System". Лишаю System |

### 2.3 Software (products)

| code (зараз) | code (нове) | name | description |
|---|---|---|---|
| ANT-V5 | ANT-V5 | Automatic Nester V5 | як є |
| ANT-V6 | ANT-V6 | Automatic Nester V6 | як є |
| EDG | EDG | External Digitizer | як є |
| LS Convert | **LSC** | LS Convert | як є (Brain code = LSC) |
| PDG | PDG | PhotoDigitiser | як є |
| PRA | PRA | Production Analyst | як є |
| PTN | PTN | Photo Nesting | як є. ⚠️ брошура пише PNT — Brain TODO, лишаю PTN як у price list |
| PTW(I) | **PTW-I** | PathWorks Integrated | як є |
| PTW(S) | **PTW-S** | PathWorks Standalone | як є |
| WPL | WPL | PoolLiner Wizard | як є |
| WPN | WPN | Panel Wizard | як є |

⚠️ Дублікати: **option `PTW`** (M,X,L) з тим самим описом що product `PTW(I)`; **option `PRA-L`** = product `PRA`. Seed вже retired `PRA-SW`/`PTW(S)` як опції. Питання: `PTW` та `PRA-L` як опції — лишаємо (бо ціна на L інша) чи видаляємо на користь products?

### 2.4 Service

| code | name | description |
|---|---|---|
| SERVICE | Service | як є |
| TRADE-IN | Trade-in | як є |

### 2.5 Options — M/X-Series (коди вже короткі, міняю тільки name)

| code | name (нове) | description |
|---|---|---|
| ABR-M | Air Brush | як є |
| AFP | Automatic Foot Pressure | як є |
| APM-M | Adaptive Pattern Matching | як є |
| BCR-M | Barcode Scanner | як є |
| BED | Bed Projector | як є |
| Crate-M | Wooden Crate | як є |
| DMT | DuctMaster | як є |
| DR2 | Secondary Drill Unit | як є |
| DRG-1 | Drag Knife, Olfa 45° | як є |
| DRG-2 | Drag Knife, Excellite 21° | як є |
| DRG-3 | Drag Knife, Carbide 45° | як є |
| Drills included → **DRL-6** | Drills 2301071-7-6 | ⚠️ зараз name = part number. Що це? Уточнити |
| Drills included 2301071-7-10 → **DRL-10** | Drills 2301071-7-10 | те саме |
| EDS-500 | Edge Sealer Static 500mm | як є |
| EDS-800 | Edge Sealer Static 800mm | як є |
| EXH | Exhaust Option | як є |
| HDC-M | HeadCam | як є |
| HFV-M | High Flow Vacuum 22kW | як є |
| IJP | Ink Jet Printer | як є |
| IKA | IceKnife Air | як є |
| IKP | IceKnife Liquid | як є |
| MRK | Marking Tool | як є |
| MTS | Machine Transfer System | як є |
| MTS- additional travel p/Metre → **MTS-M** | MTS Additional Travel, per metre | як є |
| OFD-M | Offload Display | як є |
| OFJ | Offload Projector | як є |
| OFP-M | Offload Printer | як є |
| PM-M | Pattern Match | як є |
| PRM-M | Production Manager | як є |
| PTW | PathWorks Integrated | як є — див. дублікат вище |
| VRB-180/200/220 | Vacuum Resealing Blind 180/200/220 | як є |
| Waste Bin-180 → **WB-180** | Waste Bin, Mx180 | як є |

### 2.6 Options — L-Series (тут найгірше: коди = речення)

| code (зараз) | code (нове) | name | description |
|---|---|---|---|
| 1.0mm dia punch | **PCH-1.0** | Punch 1.0mm | як є |
| 2.0mm dia punch | **PCH-2.0** | Punch 2.0mm | |
| 3.0mm dia punch | **PCH-3.0** | Punch 3.0mm | |
| 4.0mm dia punch | **PCH-4.0** | Punch 4.0mm | |
| 5.0mm dia punch | **PCH-5.0** | Punch 5.0mm | |
| Punch Tool- Quick Release (…) | **PCH-QR** | Punch Tool, Quick Release | як є |
| 28 Dia. Round Knife Tool- … | **RKT-28** | Round Knife Tool 28mm | як є |
| 40 Dia. Round Knife Tool- Quick release (Not available yet) | **RKT-40** | Round Knife Tool 40mm | як є; ⚠️ "Not available yet" → `active: false`? |
| Drag Knife Tool- Quick Release (…) 30 deg | **DKT-30** | Drag Knife Tool 30°, Quick Release | як є |
| Drag Knife Tool- Quick Release (…) 45 deg? | **DKT-45** | Drag Knife Tool 45°, Quick Release | як є, ⚠️ прибрати "?" |
| Driven- Electrically driven. Suit 28mm… | **DRV-28** | Driven Knife 28mm | як є |
| Notch Tool- Quick Release (…) | **NTT** | Notch Tool, Quick Release | як є |
| 180-E / 220-E / 320-E | **L-180-E / L-220-E / L-320-E** | Extended Length, L-180 / … | як є. Або лишити як є — коротко і в price list так |
| Crate-180/220/320 | **Crate-L-180 / …** | Wooden Crate, L-180 / … | зараз desc = "Crate-180". Дати опис як у Crate-M. Або лишити коди як є |
| ABR-L | ABR-L | Air Brush | як є |
| APM-L | APM-L | Adaptive Pattern Matching | |
| BCR-L | BCR-L | Barcode Scanner | |
| HDC-L | HDC-L | HeadCam | |
| HFV-L | HFV-L | High Flow Vacuum 15kW | ⚠️ desc не каже 15kW, Brain каже. Додати? |
| JTP | JTP | JetPen | desc "Non-contact high speed ink marking." |
| JetPen | **JTP-T** ? | JetPen Marking Tool | ⚠️ дублікат JTP? Різні ціни? Уточнити |
| OFD-L / OFP-L / PM-L / PRM-L / PRA-L | як є | Offload Display / Offload Printer / Pattern Match / Production Manager / Production Analyst | |

Brain TODO прямо каже: *"L-Series quick-release tooling … priced by description only, with no option codes. Assign codes"*. Це наш шанс — але коди PCH/RKT/DKT/DRV/NTT я вигадав; в price list їх немає. Треба погодити з директором, щоб потім не перейменовувати (хоча після Частини 1 це вже не страшно).

### 2.7 Options — EasyLoader (× 4 ширини: 2020 / 2420 / 3220 / 4030)

| code (зараз) | code (нове) | name | role |
|---|---|---|---|
| EL-2020 Drive Module (first 1.2M) | **EL-2020-DM1** | Drive Module, first 1.2m | EL_DRIVE ⚠️ seed retired це для 2020/2420, а catalog.json і `EL_OPTION_SUFFIX.drive` його очікують. Розібратись |
| EL-2020 Additional 1.2M lengths | **EL-2020-DM12** | Conveyor Module 1.2m | EL_CONVEYOR |
| EL-2020 Static table 1.2M lengths | **EL-2020-ST12** | Static Table 1.2m | EL_STATIC |
| EL-2020 Electrical Busbar Per 1.2M … | **EL-2020-BB12** | Electrical Busbar 1.2m | EL_BUSBAR |
| EL-2020 Travel Platform support rail. Per 1.2m | **EL-2020-RL12** | Platform Support Rail 1.2m | EL_RAIL |
| EL-2020 Single Roll feed attachment (…) | **EL-2020-RF** | Single Roll Feed Attachment | EL_ROLL_FEED |
| EL-2020 Syncronisation Feature (…) | **EL-2020-SYNC** | Synchronisation with Cutter | EL_SYNC. ⚠️ "Syncronisation" → "Synchronisation" в name; desc лишаю як у price list |
| EL-2020 #ST620-2020 Roll Holder- … | **ST620-2020** | Paper Roll Holder | EL_ROLL_HOLDER. Заводський артикул, є в Brain |
| EL-2420 ST620-2420 Roll Holder- … | **ST620-2420** | Paper Roll Holder | |
| Crate-EL | Crate-EL | Wooden Crate | CRATE |
| Crate-FP | Crate-FP | Wooden Crate | CRATE |
| HDRF-180 Crate- Wooden Crate for transport | **Crate-HDRF-180** | Wooden Crate | CRATE |
| HDRF-220 … / HDRF-320 … | **Crate-HDRF-220 / -320** | Wooden Crate | |
| TPL | TPL | Travelling Operator Platform | |
| SVC-* | як є | як є | вже чисто |

Описи всіх EL-опцій — повний текст з price list як є. `unitLengthM = 1.2` для DM1/DM12/ST12/BB12/RL12. `parentProductId` = відповідний EL-xxxx.

### 2.8 Зведення: що саме зміниться в даних

- Products: **0 кодів** змінюються, крім `LS Convert→LSC`, `PTW(I)→PTW-I`, `PTW(S)→PTW-S`. Назви — усі 61.
- Options: **~50 кодів** змінюються (L tools, EL, HDRF crates, Waste Bin, MTS travel, Drills). Назви — ~90.
- Descriptions: тільки фактичні виправлення (L-320 226→320, EF "1200m"→"1200mm, DKT-45 "?").

---

## Частина 3. Відкриті питання (потрібна відповідь перед фазою 3)

1. **EL-4030 / EF-4030** — Brain каже таких моделей немає, є 4120. Хто правий: price list чи брошура?
2. **Дублікати**: `PTW` (option) vs `PTW(I)` (product); `PRA-L` vs `PRA`; `JetPen` vs `JTP`. Лишаємо як окремі SKU з окремими цінами, чи зливаємо?
3. **EL Drive Module** — seed retire'ить опцію "EL-2020 Drive Module (first 1.2M)" (він тепер = product EL-2020), але catalog.json і `EL_OPTION_SUFFIX.drive` її ще використовують. Що правильно: drive module = сам product, а опції — тільки додаткові модулі?
4. **Нові коди для L-tools** (PCH/RKT/DKT/DRV/NTT) — вигадані мною. Погодити з директором або дати свої.
5. **M vs X дефіс** (`M3180` vs `X-3180`) — уніфікувати чи лишити як у price list?
6. **"Drills included 2301071-7-6"** — що це за товар?
7. **RKT-40 "Not available yet"** — `active: false`?
8. Формат назв машин: "M-Series Cutting Machine 3cm × 180cm" чи "M-Series 3cm lay, 180cm wide"?

---

## Додаток A. Повна карта залежностей від `code` (аудит)

(A) Production forms: `specs/m-series.ts:4,7-14,34-35,70,96-135`; `specs/easyloader.ts:5,7,53-59,121-123,135-142`; `specs/fabricpro.ts:5,7,47-49`; `resolve.ts:13-20,70-78`; `context.ts:50-54`; `api/documents/[id]/production-forms/route.ts:54,72,92,95,100`; `actions/production.ts:54,109`; `components/documents/production-forms-section.tsx:51,65-66`.

(B) EL derived codes: `table-sections.ts:44-57,150-158`; `actions/documents/options.ts:280-300` (+ дубль `actions/documents.ts:733-751`); `items-list.tsx:214,479`; `production-spec-editor.tsx:155,192,547`; `tests/catalog.test.ts:260`, `tests/table-sections.test.ts:85-143`.

(C) Quotation blocks/specs: `quotation-data.ts:152-160,177-196,203,217,591-676`; `machine-specs.ts:38-121`; `content-blocks.json` keys `option.<code>`.

(D) Name parsing: `option-length.ts:18-36`; `item-options-editor.tsx:354`.

(E) Wire/transport: `actions/documents/items.ts:42-67`; `validation/documents.ts:213`; `actions/documents/options.ts:127-171`; `catalog-compat.ts:127-149`; `actions/catalog-visibility.ts:27-70`; `catalog-visibility-editor.tsx:38-127`; `actions/catalog/compatibility.ts:16-39`; `queries/catalog.ts:266`.

(F) Seed/scripts: `prisma/seed.ts:67-88,141,153,207-251,261-345`; `seed-lib.ts:281-311`; `scripts/extract-catalog.ts:161-175,238,276-282,408-434,481,495-540`; `scripts/extract-us-prices.ts:86-345`; `scripts/import-images-lib.ts:27-205`; `scripts/import-product-images.ts:112-252`.

(G) Snapshots: `schema.prisma:580` `DocumentItem.code`, `:627` `DocumentLine.code`.

Чисто (id-based): `catalog-visibility.ts`, `pricing.ts` (`isCredit` — bool), `compatibilityOrFilter`, `spec-images.ts`.
