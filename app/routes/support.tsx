import type { ReactNode } from "react";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import {
  LegalLayout,
  SupportEmail,
  legalLinks,
  legalMeta,
  legalStyles as s,
} from "../components/legal/LegalLayout";
import {
  CREDITS_EXPIRY,
  ERASURE_WINDOW,
  REFUND_POLICY,
  REPLY_TIME,
} from "../components/legal/copy";
import { BRAND, PAGES } from "../lib/brand";
import { env } from "../lib/env.server";

// Also the listing's support and FAQ URL, so answers must hold for the app as it ships.

export const meta: MetaFunction = () =>
  legalMeta(
    "Support and FAQ",
    `Get help with ${BRAND.name}: contact support, and answers about credits, restores, uninstalling, refunds and which images work best.`,
    PAGES.support,
  );

export const links = legalLinks;

// The free grant comes from the same config the app credits new installs with.
export const loader = () => ({ freeCredits: env().FREE_CREDITS });

const buildFaq = (
  freeCredits: number,
): { id: string; q: string; a: ReactNode }[] => [
  {
    id: "how-it-works",
    q: `How does ${BRAND.name} work?`,
    a: (
      <>
        <p>Open the app from your Shopify admin and create a job:</p>
        <ol>
          <li>
            Pick products by collection, vendor, product type or tag, and choose
            the first image or all images.
          </li>
          <li>
            Choose the canvas (square or 4:5), margin and background: pure
            white, another colour, or keep your own. Turn on AI upscaling if you
            want small photos enlarged.
          </li>
          <li>
            {BRAND.name} backs up each original, then cleans it. Drag through
            the before and after previews, with the cut-out mask on top.
          </li>
          <li>
            Approve the images you like and apply them. Nothing in your store
            changes until you do.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: "credits",
    q: "What is a credit?",
    a: (
      <>
        <p>
          Each image you apply to your store costs 1 credit, plus 1 more when AI
          upscaling runs on it. Credits are only deducted when an image is
          applied: previews, rejected images and images that fail cost nothing.
          The job page shows the cost before you start.
        </p>
        <p>
          New installs get {freeCredits} free credits. After that, you can buy
          one-time credit packs on the app&apos;s Credits page, billed by
          Shopify in USD. See the <a href="/#pricing">pricing</a>.
        </p>
      </>
    ),
  },
  {
    id: "what-changes",
    q: "What exactly changes in my store?",
    a: (
      <>
        <p>
          Only the image files you apply. Each one is replaced in place, so it
          keeps its position in the gallery, its alt text and its variant links.
          Titles, descriptions, prices and everything else stay as they are.
        </p>
        <p>
          If Shopify won&apos;t replace a file in place, {BRAND.name} adds the
          new image in the same position with the same alt text and variant
          links, and removes the old one from the product. The old file stays in
          your Shopify Files.
        </p>
        <p>
          When AI upscaling ran on an image, the file&apos;s metadata notes that
          AI was used, unless you turn that setting off.
        </p>
      </>
    ),
  },
  {
    id: "restore",
    q: "How do restores work?",
    a: (
      <p>
        Every original is backed up before it&apos;s changed. On a job&apos;s
        page you can restore a single image or every applied image in the job;
        the original goes back the same way the new image went in. Restores are
        free, but they don&apos;t give back the credits spent applying the
        image. Backups are kept for as long as the app is installed.
      </p>
    ),
  },
  {
    id: "flagged",
    q: "Why was an image flagged?",
    a: (
      <p>
        {BRAND.name} flags images it&apos;s unsure about: for example when the
        cut-out may have missed part of the product, when text or a label was
        found, or when upscaling changed the image more than expected. Flagged
        images are never included in “Approve all”; check them one by one and
        approve or reject each.
      </p>
    ),
  },
  {
    id: "images",
    q: "Which images work best?",
    a: (
      <>
        <ul>
          <li>
            JPG, PNG and WebP keep their format. GIF, TIFF, BMP and AVIF are
            converted to JPG. Animated images and HEIC files aren&apos;t
            supported.
          </li>
          <li>
            Background removal works best when the product stands out from its
            background and isn&apos;t cut off by the edge of the photo.
          </li>
          <li>
            AI upscaling only runs on photos smaller than the size you set (by
            default, a short side under 1,200 pixels). Photos with text or
            labels get a standard resize instead, to keep lettering sharp.
          </li>
          <li>
            Finished images are sRGB and at most 20 megapixels. Very large
            originals may be rejected.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "speed",
    q: "How long does a job take?",
    a: (
      <p>
        Most images take from a few seconds to about a minute each. Jobs run in
        the background, so you can leave the page and come back to review.
      </p>
    ),
  },
  {
    id: "uninstall",
    q: "What happens to my data if I uninstall?",
    a: (
      <>
        <p>{CREDITS_EXPIRY}</p>
        <p>
          Your store&apos;s data, backups and cleaned images are erased{" "}
          {ERASURE_WINDOW}. Restore anything you want to keep before
          uninstalling. The{" "}
          <a href={`${PAGES.privacy}#uninstall`}>privacy policy</a> has the full
          timeline.
        </p>
      </>
    ),
  },
  {
    id: "refunds",
    q: "Can I get a refund?",
    a: (
      <p>
        {REFUND_POLICY} Email <SupportEmail subject="Refund request" /> with
        your store&apos;s name or address and the pack you bought; refunds are
        issued through Shopify. Details are in the{" "}
        <a href={`${PAGES.terms}#refunds`}>terms</a>.
      </p>
    ),
  },
  {
    id: "access",
    q: "What access does the app need?",
    a: (
      <p>
        Only your products and files. {BRAND.name} never reads your orders or
        customers, and we never use your images to train AI models.
      </p>
    ),
  },
  {
    id: "other-platforms",
    q: "Can I use it outside Shopify?",
    a: (
      <p>
        Not yet. A web app and API for other platforms are planned; join the{" "}
        <a href="/#ways">waitlist</a> to hear when they launch.
      </p>
    ),
  },
];

const contact = (
  <div className={s.contact}>
    <h2>Get help</h2>
    <p>
      Email us and a person will reply, usually {REPLY_TIME}. Tell us your
      store&apos;s name or address, what you were doing, and the job or product
      involved. Screenshots help.
    </p>
    <a
      className={s.mail}
      href={`mailto:${BRAND.supportEmail}?subject=${encodeURIComponent(`${BRAND.name} support`)}`}
    >
      {BRAND.supportEmail}
    </a>
    <small>Support in English</small>
  </div>
);

const buildSections = (freeCredits: number) => [
  {
    id: "faq",
    title: "Frequently asked questions",
    body: (
      <div className={s.faq}>
        {buildFaq(freeCredits).map((f) => (
          <details key={f.id} id={f.id}>
            <summary>{f.q}</summary>
            <div>{f.a}</div>
          </details>
        ))}
      </div>
    ),
  },
  {
    id: "policies",
    title: "Policies",
    body: (
      <ul>
        <li>
          <a href={PAGES.privacy}>Privacy policy</a>: what we collect, where
          it&apos;s stored, how long we keep it and your rights.
        </li>
        <li>
          <a href={PAGES.terms}>Terms of service</a>: credits, billing, refunds
          and acceptable use.
        </li>
      </ul>
    ),
  },
];

export default function Support() {
  const { freeCredits } = useLoaderData<typeof loader>();
  return (
    <LegalLayout
      path={PAGES.support}
      kicker="Support"
      title={
        <>
          How can we <em>help?</em>
        </>
      }
      lede={`Answers to common questions about ${BRAND.name}, and how to reach us when you need a hand.`}
      summary={contact}
      sections={buildSections(freeCredits)}
      contents={false}
    />
  );
}
