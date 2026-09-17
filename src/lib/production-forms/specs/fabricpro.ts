import { fabricProSpecSchema } from "@/lib/validation/production-spec";
import type { HtmlFormSpec } from "../types";

/**
 * FabricPro. Drawn by `FabricProForm` (src/components/forms/
 * fabricpro-form.tsx); the workbook `fabric-pro-order-form-08.xlsx` and its
 * cell map are gone.
 *
 * The catalogue sells one option for the FabricPro, `Crate-FP`, and the
 * builder adds it with the machine (DEFAULT_OPTION_ROLES). The travel
 * platform and its two rails are not options: the platform is fitted to
 * every machine, and the rails' length comes from the EasyLoader table the
 * machine is paired with (`ctx.rails`) or from the manager's override.
 */
export const fabricProSpec: HtmlFormSpec = {
  id: "fabricpro",
  title: "Fabric Pro Order Form",
  form: "FABRICPRO",
  renderer: "html",
  specSchema: fabricProSpecSchema,
  // "ui" is not listed: screenSideSchema defaults to -Y, so it can never be
  // missing. FabricPro has no other required field.
  requires: [],

  covers: ["CRATE"],
};
