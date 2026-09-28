import type { OptionRole } from "@prisma/client";

/**
 * The marking tools an L-Series carries, and the one rule about them: only
 * one can be fitted.
 *
 * `MRK` is included as standard on every L-Series and is not charged -- the
 * printed form says "standard on all". It occupies the same mount as the ink
 * jet printer, the JetPen and the air brush, so ordering one of those takes
 * the marking tool off the machine (the form's own footnotes, and Vadym,
 * 2026-09-18: "якщо менеджер обирає IJP, JetPen or ABR, треба MRK
 * виключати").
 *
 * That only one can be fitted -- on every machine, not just the L-Series
 * (John) -- is the catalogue's `OptionConflictGroup` of MRK, IJP,
 * JetPen and the air brushes. This file is what the L-Series form needs to
 * know about which one is on the machine.
 */
export const MARKING_TOOL_ROLES = ["MRK", "IJP", "JTP", "ABR"] as const;

export type MarkingToolRole = (typeof MARKING_TOOL_ROLES)[number];

/** What each one is called on the printed form -- `JTP` prints as JetPen. */
export const MARKING_TOOL_LABELS: Record<MarkingToolRole, string> = {
  MRK: "MRK",
  IJP: "IJP",
  JTP: "JetPen",
  ABR: "ABR",
};

export function isMarkingTool(role: OptionRole | null | undefined): role is MarkingToolRole {
  return role !== null && role !== undefined && (MARKING_TOOL_ROLES as readonly string[]).includes(role);
}

/** The marking tools among a set of roles, in the order the form lists them. */
export function markingToolsAmong(roles: Array<OptionRole | null | undefined>): MarkingToolRole[] {
  return MARKING_TOOL_ROLES.filter((tool) => roles.some((role) => role === tool));
}

/**
 * The tool that takes MRK's place, or null when the machine keeps its
 * standard marking tool. `MRK` itself never displaces it -- ordering the
 * option the machine already has changes nothing about what is fitted.
 */
export function markingToolReplacingMrk(roles: Array<OptionRole | null | undefined>): MarkingToolRole | null {
  return markingToolsAmong(roles).find((tool) => tool !== "MRK") ?? null;
}

/** Whether the standard MRK is still on the machine. */
export function mrkFitted(roles: Array<OptionRole | null | undefined>): boolean {
  return markingToolReplacingMrk(roles) === null;
}
