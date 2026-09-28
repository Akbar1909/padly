import type { ReactNode } from "react";
import { BRAND, PAGES } from "../lib/brand";

/** Absolute URL of a public page on the website (the app runs inside the admin iframe). */
export const siteUrl = (path: string) => `${BRAND.site}${path}`;

export const SUPPORT_MAILTO = `mailto:${BRAND.supportEmail}`;

/**
 * Mail link to support. Opened in a new window: the admin iframe is sandboxed and may not
 * hand a mailto: navigation of its own frame to the mail app.
 */
export function SupportLink({ children = "Contact support" }: { children?: ReactNode }) {
  return (
    <s-link href={SUPPORT_MAILTO} target="_blank">
      {children}
    </s-link>
  );
}

/** Help links at the bottom of a page (the Polaris "footer help" pattern). */
export function HelpFooter() {
  return (
    <s-stack alignItems="center" paddingBlock="large">
      <s-text color="subdued">
        Need help? Email <SupportLink>{BRAND.supportEmail}</SupportLink> ·{" "}
        <s-link href={siteUrl(PAGES.support)} target="_blank">
          Support &amp; FAQ
        </s-link>{" "}
        ·{" "}
        <s-link href={siteUrl(PAGES.privacy)} target="_blank">
          Privacy
        </s-link>{" "}
        ·{" "}
        <s-link href={siteUrl(PAGES.terms)} target="_blank">
          Terms
        </s-link>
      </s-text>
    </s-stack>
  );
}
