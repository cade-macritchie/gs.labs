"use client";

import { useEffect } from "react";
import { postToParent } from "@/lib/embed";

/** Reports the page height to the Slate wrapper so the iframe grows with its content. */
export function EmbedResizeReporter() {
  useEffect(() => {
    if (window.parent === window) return;
    const report = () =>
      postToParent({ type: "merch-order-resize", height: document.documentElement.scrollHeight });
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    report();
    return () => observer.disconnect();
  }, []);

  return null;
}
