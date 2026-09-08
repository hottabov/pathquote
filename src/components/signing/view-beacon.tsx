"use client";

import { useEffect, useRef } from "react";

// Reports a genuine human opening the quote, exactly once.
//
// The discriminator is interaction, not arrival. A link scanner loads the page,
// runs its scripts and leaves without ever moving a pointer, pressing a key,
// scrolling or touching the screen; a person reading a quote does at least one
// of those within seconds. So the beacon waits for the first such event rather
// than firing on mount — firing on mount would put the write back where it
// started, just on a different URL, since Defender's headless browser executes
// JavaScript.
//
// `scroll` is included because a phone reader may do nothing else, and
// `visibilitychange` is not: a background prerender can become visible without
// anyone touching it.

const INTERACTIONS = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"] as const;

export function ViewBeacon({ token }: { token: string }) {
  // Guards both the double effect invocation React StrictMode performs in
  // development and the race between two interaction events landing in the
  // same tick.
  const fired = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    function report() {
      if (fired.current) return;
      fired.current = true;
      controller.abort();
      // Fire and forget: this is bookkeeping for the sender's pipeline, and
      // nothing the reader sees depends on it. A failure must never interrupt
      // someone reading a quote, so the rejection is swallowed on purpose.
      void fetch(`/sign/${encodeURIComponent(token)}/viewed`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    }

    for (const event of INTERACTIONS) {
      window.addEventListener(event, report, {
        once: true,
        passive: true,
        signal: controller.signal,
      });
    }

    return () => controller.abort();
  }, [token]);

  return null;
}
