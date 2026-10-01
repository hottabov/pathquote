"use client";

import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "slow" | "saved" | "error";

export type AutosaveState = {
  status: AutosaveStatus;
  error: string | null;
  /** Runs a pending save right now instead of waiting out the debounce, and
   * resolves once it has landed. A no-op when nothing is pending. For a
   * caller that is about to disable the hook (closing the options sheet) and
   * would otherwise drop the last change on the floor. */
  flush: () => Promise<void>;
};

/** How long a save may run before the indicator admits it is slow ("Still
 * saving…") instead of showing a "Saving…" that looks frozen. */
const SLOW_SAVE_MS = 8000;

/** A save that takes at least this long is reported to the server log
 * (`reportSlowSave`), so the next "it hung" has a number and a field name
 * behind it. Kept well below SLOW_SAVE_MS: the point is to see the trend
 * before anyone notices. */
const REPORT_SLOW_SAVE_MS = 3000;

/** How long a "Saved" status lingers before fading back to "idle" (the
 * "Saving…" / "Saved" pair the owner asked for — see the hook's own doc
 * comment). */
const SAVED_LINGER_MS = 2000;

/**
 * Debounced autosave for a single value: `delay`ms after `value` last
 * changes, calls `onSave(value)` and reflects the outcome as `status`
 * (`"idle" | "saving" | "saved" | "error"`) plus `error` — meant to back a
 * small `aria-live="polite"` inline indicator next to the field, replacing
 * an explicit Save button (see item-discount-field.tsx,
 * document-discount-field.tsx and notes-section.tsx for the pattern).
 *
 * Two guards keep this from saving things it shouldn't:
 * - The very first render never saves — mounting with an already-loaded
 *   value (the document's current notes/discount/etc.) must not immediately
 *   re-save it.
 * - A `value` that's `===`-equal to the last value actually saved (or the
 *   initial one) is skipped too, so e.g. a re-render that doesn't change
 *   the field never queues a redundant save.
 *
 * `onSave` should resolve to the project's `{ error?: string }`
 * `ActionResult` shape (or resolve to nothing) on a handled failure, or
 * throw on an unexpected one — either becomes `status: "error"` with a
 * message, and does NOT advance "last saved value" (so fixing the value
 * and pausing again retries the save rather than silently giving up).
 * `enabled: false` (e.g. a read-only document) suppresses saving entirely
 * without needing the caller to conditionally call the hook.
 *
 * Tests: this repo has no React test renderer (no @testing-library/react in
 * package.json; vitest runs in a plain node environment), so the hook's
 * timing is not unit-tested. The "value returns to the last saved value
 * while a save is pending" path is a two-line state transition in the
 * effect below, covered by reading it rather than by a mocked-timer harness.
 */
export function useAutosave<T>({
  value,
  onSave,
  delay = 800,
  enabled = true,
  label = "field",
}: {
  value: T;
  onSave: (value: T) => Promise<{ error?: string } | void>;
  delay?: number;
  enabled?: boolean;
  /** Names the field in the slow-save report (see `reportSlowSave`). */
  label?: string;
}): AutosaveState {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const isFirstRender = useRef(true);
  const lastSavedValue = useRef(value);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedLingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a stale save's result landing after a newer save already
  // started (e.g. delay=800 and the user changes the value twice quickly).
  const saveToken = useRef(0);
  // True from scheduling a save until its debounce timer fires. The effect
  // cleanup clears the timer on every value change, so `saveTimer.current`
  // cannot say whether one was pending when the value moved back.
  const savePending = useRef(false);

  // The save the debounce timer will run, so `flush` can run it early.
  const pendingRun = useRef<(() => Promise<void>) | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function runSave(saving: T, token: number): Promise<void> {
    savePending.current = false;
    pendingRun.current = null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => {
      if (token === saveToken.current) setStatus("slow");
    }, SLOW_SAVE_MS);
    const startedAt = Date.now();
    try {
      const result = await onSave(saving);
      const ms = Date.now() - startedAt;
      if (ms >= REPORT_SLOW_SAVE_MS) reportSlowSave(label, ms);
      if (token !== saveToken.current) return; // superseded by a later save
      if (result && "error" in result && result.error) {
        setStatus("error");
        setError(result.error);
        return;
      }
      lastSavedValue.current = saving;
      setStatus("saved");
      setError(null);
      if (savedLingerTimer.current) clearTimeout(savedLingerTimer.current);
      savedLingerTimer.current = setTimeout(() => {
        if (token === saveToken.current) setStatus("idle");
      }, SAVED_LINGER_MS);
    } catch (err) {
      if (token !== saveToken.current) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      if (token === saveToken.current && slowTimer.current) clearTimeout(slowTimer.current);
    }
  }

  async function flush(): Promise<void> {
    const run = pendingRun.current;
    if (run) await run();
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      lastSavedValue.current = value;
      return;
    }
    if (!enabled) return;
    if (value === lastSavedValue.current) {
      // The value came back to what is already saved (Auto → Custom → Auto
      // inside the debounce window). The cleanup below already cancelled the
      // timer, but the "saving" status it set would otherwise stay forever:
      // cancel the pending save for good and settle back to idle. A save
      // already in flight is not pending and is left to finish.
      if (savePending.current) {
        savePending.current = false;
        pendingRun.current = null;
        saveToken.current++;
        setStatus("idle");
        setError(null);
      }
      return;
    }

    if (saveTimer.current) clearTimeout(saveTimer.current);

    const token = ++saveToken.current;
    setStatus("saving");
    setError(null);
    savePending.current = true;

    pendingRun.current = () => runSave(value, token);
    saveTimer.current = setTimeout(() => {
      void pendingRun.current?.();
    }, delay);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSave is expected to be stable-enough (a bound action or closure); depending on it would re-arm the debounce every render.
  }, [value, enabled, delay]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (savedLingerTimer.current) clearTimeout(savedLingerTimer.current);
      if (slowTimer.current) clearTimeout(slowTimer.current);
    },
    []
  );

  return { status, error, flush };
}

/** Fire-and-forget: tells the server a save took `ms`, so it lands in the
 * app log next to nginx's own request time (`rt=`). The two together say
 * where a slow save spent its time — on the server, on the wire, or queued
 * in the browser behind another save (Next sends server actions one at a
 * time). Never throws; a failed report is not worth bothering anyone with. */
function reportSlowSave(label: string, ms: number): void {
  try {
    const body = JSON.stringify({ label, ms, path: window.location.pathname });
    if (!navigator.sendBeacon?.("/api/client-timing", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/client-timing", { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {
    // Reporting is best-effort.
  }
}
