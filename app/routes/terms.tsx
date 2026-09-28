import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import {
  LegalLayout,
  SupportEmail,
  legalLinks,
  legalMeta,
  legalStyles as s,
} from "../components/legal/LegalLayout";
import { CREDITS_EXPIRY, ERASURE_WINDOW } from "../components/legal/copy";
import { CREDIT_PACKS } from "../lib/billing.server";
import { BRAND, LEGAL_UPDATED, PAGES } from "../lib/brand";
import { env } from "../lib/env.server";

export const meta: MetaFunction = () =>
  legalMeta(
    "Terms of service",
    `The terms for using the ${BRAND.name} Shopify app and website: credits and billing through Shopify, refunds, acceptable use, AI results and liability.`,
    PAGES.terms,
  );

export const links = legalLinks;

// Pack prices and the free grant come from the same config the app bills with.
export const loader = () => ({
  packs: CREDIT_PACKS,
  freeCredits: env().FREE_CREDITS,
});

function buildSections(
  packs: { id: string; name: string; credits: number; price: number }[],
  freeCredits: number,
) {
  return [
    {
      id: "agreement",
      title: "About these terms",
      body: (
        <>
          <p>
            These terms are an agreement between you and {BRAND.name} (“
            {BRAND.name}”, “we”, “us”). They apply when you install or use the{" "}
            {BRAND.name} Shopify app, and when you use this website, including
            the free try-it demo. By doing either, you accept them. If you use{" "}
            {BRAND.name} for a business, you confirm that you can accept these
            terms on its behalf.
          </p>
          <p>
            Our <a href={PAGES.privacy}>privacy policy</a> explains how we
            handle data and is part of these terms.
          </p>
        </>
      ),
    },
    {
      id: "service",
      title: "The service",
      body: (
        <>
          <p>
            {BRAND.name} cleans up product photos in bulk. It can remove the
            background (onto white or another colour) or keep it, pad each photo
            to a square or 4:5 canvas with even margins and no cropping, and
            optionally upscale small photos with AI. You preview the results,
            approve the ones you want, and {BRAND.name} replaces those images in
            place on your products. Each original is backed up first so you can
            restore it.
          </p>
          <p>
            The website demo lets anyone clean a few photos a day for free, to
            see how it works. Demo results are previews only.
          </p>
        </>
      ),
    },
    {
      id: "eligibility",
      title: "Who can use it",
      body: (
        <p>
          The app is for merchants with a Shopify store, and you must also
          follow{" "}
          <a href="https://www.shopify.com/legal/terms">
            Shopify&apos;s terms of service
          </a>
          . You must be old enough to enter a binding contract where you live.
          The website demo is open to anyone who follows these terms.
        </p>
      ),
    },
    {
      id: "account",
      title: "Your account",
      body: (
        <p>
          There&apos;s no separate {BRAND.name} login: you sign in through your
          Shopify admin, and anyone with access to the app there can use it for
          your store, including buying credits and applying images. You&apos;re
          responsible for who has that access.
        </p>
      ),
    },
    {
      id: "credits",
      title: "Credits and billing",
      body: (
        <>
          <ul>
            <li>
              New installs get <strong>{freeCredits} free credits</strong>.
            </li>
            <li>
              Each image you apply costs <strong>1 credit</strong>, plus{" "}
              <strong>1 more</strong> when AI upscaling runs on it.
            </li>
            <li>
              Credits are only deducted when an image is applied to your store.
              Images that fail, that you reject or never apply cost nothing.
            </li>
            <li>
              Restoring an original is free, but it doesn&apos;t give back the
              credits spent applying that image.
            </li>
            <li>{CREDITS_EXPIRY}</li>
            <li>
              Credits have no cash value and can&apos;t be moved to another
              store.
            </li>
          </ul>
          <p>You can buy more credits in one-time packs (prices in USD):</p>
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Pack</th>
                  <th scope="col">Credits</th>
                  <th scope="col">Price</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name.replace(" pack", "")}</td>
                    <td>{p.credits.toLocaleString("en-US")}</td>
                    <td>${p.price} USD</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Packs are one-time charges billed by Shopify on your Shopify
            invoice. Shopify may show them in your billing currency and add
            taxes that apply to you. We may change pack prices in the future;
            changes never affect credits you&apos;ve already bought.
          </p>
        </>
      ),
    },
    {
      id: "refunds",
      title: "Refunds",
      body: (
        <>
          <p>
            If you haven&apos;t used a credit pack, you can ask for a refund
            within <strong>14 days of buying it</strong>. Email{" "}
            <SupportEmail subject="Refund request" /> with your store&apos;s
            name or address and the pack you bought. Credits already spent on
            applied images aren&apos;t refundable.
          </p>
          <p>
            Refunds are issued through Shopify, and the refunded credits are
            removed from your balance. If something on our side charged you by
            mistake, tell us and we&apos;ll put it right. Nothing in these terms
            limits rights you have under the law.
          </p>
        </>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>When you use {BRAND.name}, you agree to:</p>
          <ul>
            <li>
              only upload or process images you own or have the rights to use
              and edit;
            </li>
            <li>
              not use it for anything illegal, including content that is
              infringing, sexually exploits anyone, or promotes violence or
              hate;
            </li>
            <li>
              not try to get around limits (such as the demo&apos;s daily limit
              or credit checks), overload the service, or access parts of it you
              aren&apos;t meant to;
            </li>
            <li>
              not copy, resell or build a competing service on top of{" "}
              {BRAND.name}.
            </li>
          </ul>
          <p>
            We may remove content or suspend access that breaks these rules.
          </p>
        </>
      ),
    },
    {
      id: "content",
      title: "Your images",
      body: (
        <p>
          Your images stay yours, and so do the cleaned versions. You give us
          permission to store, process and display them only as needed to
          provide the service to you, as described in the privacy policy. We
          never use them to train AI models.
        </p>
      ),
    },
    {
      id: "ai-results",
      title: "AI results",
      body: (
        <>
          <p>
            {BRAND.name} uses AI models to find the product and, if you turn it
            on, to upscale small photos. Results vary with the photo. The AI can
            miss or cut into parts of a product, soften fine detail, or change
            small text, so:
          </p>
          <ul>
            <li>
              review the previews before you apply them; images we&apos;re
              unsure about are flagged and never approved in bulk;
            </li>
            <li>
              you decide what gets applied to your store and are responsible for
              checking it meets your needs and any marketplace&apos;s rules.
            </li>
          </ul>
          <p>
            Every original is backed up before it&apos;s changed and can be
            restored while the app is installed. Backups aren&apos;t a general
            backup service for your store: they&apos;re deleted {ERASURE_WINDOW}
            , so restore anything you want to keep before you uninstall.
          </p>
        </>
      ),
    },
    {
      id: "availability",
      title: "Availability and changes",
      body: (
        <p>
          We work to keep {BRAND.name} running smoothly, but we can&apos;t
          promise it will always be available or error-free. Processing can slow
          down at busy times, and we may pause the service for maintenance. We
          may add, change or remove features over time.
        </p>
      ),
    },
    {
      id: "third-parties",
      title: "Other services",
      body: (
        <p>
          {BRAND.name} depends on Shopify and on the providers listed in our{" "}
          <a href={`${PAGES.privacy}#providers`}>privacy policy</a>. We
          aren&apos;t responsible for their services, and their own terms apply
          to them.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Disclaimer and limitation of liability",
      body: (
        <>
          <p>
            To the extent the law allows, {BRAND.name} is provided “as is”,
            without warranties of any kind, including that results will fit a
            particular purpose.
          </p>
          <p>
            To the extent the law allows, we aren&apos;t liable for indirect or
            consequential losses, such as lost profits, sales or data, and our
            total liability for any claim about {BRAND.name} is limited to the
            amount you paid us in the 12 months before the claim. Nothing in
            these terms limits liability that can&apos;t be limited by law.
          </p>
        </>
      ),
    },
    {
      id: "termination",
      title: "Ending the service",
      body: (
        <p>
          You can stop at any time by uninstalling the app. We may suspend or
          end your access if you break these terms. If we ever stop offering{" "}
          {BRAND.name}, we&apos;ll give reasonable notice first. After you
          uninstall, your data, backups and unused credits are deleted as the{" "}
          <a href={PAGES.privacy}>privacy policy</a> describes.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We may update these terms. We&apos;ll post the new version here with a
          new date and, for significant changes, give notice on this page before
          they take effect. If you keep using {BRAND.name} after that, the new
          terms apply.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions about these terms: <SupportEmail subject="Terms" />. For
          help with the app, see the <a href={PAGES.support}>support page</a>.
        </p>
      ),
    },
  ];
}

export default function Terms() {
  const { packs, freeCredits } = useLoaderData<typeof loader>();
  return (
    <LegalLayout
      path={PAGES.terms}
      kicker="Terms"
      title={
        <>
          Terms of <em>service</em>
        </>
      }
      lede={`The rules for using ${BRAND.name}, in plain language: how credits and billing work, refunds, what you can use it for, and what we're responsible for.`}
      updated={LEGAL_UPDATED}
      sections={buildSections(packs, freeCredits)}
    />
  );
}
