"use client";

import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export type AutosaveState = { status: AutosaveStatus; error: string | null };

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
}: {
  value: T;
  onSave: (value: T) => Promise<{ error?: string } | void>;
  delay?: number;
  enabled?: boolean;
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

    saveTimer.current = setTimeout(() => {
      savePending.current = false;
      void (async () => {
        try {
          const result = await onSave(value);
          if (token !== saveToken.current) return; // superseded by a later save
          if (result && "error" in result && result.error) {
            setStatus("error");
            setError(result.error);
            return;
          }
          lastSavedValue.current = value;
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
        }
      })();
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
    },
    []
  );

  return { status, error };
}
