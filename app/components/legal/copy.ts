/**
 * Promises made in more than one place (landing, support, terms). Keep them in one spot so
 * the pages can't drift apart, and only change them together with the code that keeps them
 * (shop/redact purge, retention sweep, billing).
 */

/** What happens to credits and backups on uninstall (billing-credits-forfeit-on-uninstall). */
export const CREDITS_EXPIRY =
  "Credits don't expire while the app is installed. If you uninstall, unused credits and your image backups are deleted, usually 48 hours later.";

/** Erasure timeline after uninstall: shop/redact at 48 h, or the 25-day retention sweep. */
export const ERASURE_WINDOW =
  "within 30 days (usually 48 hours after you uninstall)";

/** Refund policy for credit packs, stated in the terms and on the support page. */
export const REFUND_POLICY =
  "Unused credit packs can be refunded on request within 14 days of purchase. Credits already spent on applied images aren't refundable.";

/** How fast support answers. */
export const REPLY_TIME = "within 2 business days";
