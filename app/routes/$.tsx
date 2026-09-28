import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data } from "react-router";

import {
  SiteShell,
  SupportEmail,
  legalLinks,
  legalStyles as s,
} from "../components/legal/LegalLayout";
import { BRAND, PAGES } from "../lib/brand";

/** Any URL no other route matches: a branded 404 instead of React Router's default page. */
export const loader = ({ request }: LoaderFunctionArgs) => {
  // Unknown /app/… paths normally match app.$.tsx (a 404 inside the admin, with the nav).
  // Should one ever land here, it's in the admin iframe, where this public page and its home
  // links would load the marketing site. Throw instead: the root boundary shows the embedded
  // error screen, with no links out and no Google Fonts.
  if (/^\/app(\/|$)/.test(new URL(request.url).pathname)) {
    throw data(null, { status: 404 });
  }
  return data(null, { status: 404 });
};

export const meta: MetaFunction = () => [
  { title: `Page not found · ${BRAND.name}` },
  { name: "robots", content: "noindex" },
];

export const links = legalLinks;

export default function NotFound() {
  return (
    <SiteShell>
      <main id="content" className={s.center}>
        <div className={s.wrap}>
          <span className={s.code}>404 · Page not found</span>
          <h1 className={s.title}>
            This page <em>isn&apos;t here.</em>
          </h1>
          <p className={s.lede}>
            The link may be old or mistyped. If you were looking for help, the
            support page has answers, or email <SupportEmail />.
          </p>
          <div className={s.actions}>
            <a className={`${s.btn} ${s.btnPrimary}`} href="/">
              Go to the home page
            </a>
            <a className={`${s.btn} ${s.btnGhost}`} href={PAGES.support}>
              Support
            </a>
          </div>
        </div>
      </main>
    </SiteShell>
  );
}
