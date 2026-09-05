// The server-safe half of the ui-kit. Everything re-exported here is either a
// plain render-only component or a class-name constant, so a server component
// can pull one name out without that name's module graph deciding the whole
// route is client-side.
//
// The interactive half — `PhoneField` and the toast/confirm hooks — lives in
// ./client. Splitting them matters because a barrel is a single module to a
// bundler: one `import { FieldRow } from "@/components/ui-kit"` in a client
// component used to pull in `PhoneField`, and through it `@/lib/countries`,
// and through that `i18n-iso-countries` plus its `langs/en.json` — a
// side-effectful `registerLocale` call no tree-shaker can drop.
export { PageHeader } from "./page-header";
export { Avatar } from "./avatar";
export { SectionCard } from "./section-card";
export { TableShell, RowCell, tableClassName, tableHeadRowClassName, tableRowClassName } from "./data-table";
export { StatusBadge, STATUS_TONE, type StatusTone } from "./status-badge";
export { EmptyState } from "./empty-state";
export { FieldRow, fieldInputClass } from "./field-row";
export { CountrySelect } from "./country-select";
