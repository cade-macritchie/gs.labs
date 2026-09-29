/**
 * The order form is embedded in the Slate portal at
 * https://enroll.gs.edu/portal/merch-order through an iframe (see
 * slate-templates/wrappers/merch-order-wrapper.liquid.html). These helpers talk
 * to that wrapper; outside an iframe they do nothing.
 */
export const EMBED_PARENT_ORIGIN = "https://enroll.gs.edu";

export function postToParent(message: { type: string; [key: string]: unknown }) {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(message, EMBED_PARENT_ORIGIN);
}
