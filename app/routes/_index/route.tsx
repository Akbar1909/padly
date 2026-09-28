import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  Form,
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { z } from "zod";

import prisma from "../../db.server";
import { CREDIT_PACKS } from "../../lib/billing.server";
import { BRAND, PAGES } from "../../lib/brand";
import { env } from "../../lib/env.server";
import { redis } from "../../lib/redis.server";
import { clientIp } from "../../lib/try.server";
import { CompareSlider } from "../../components/landing/CompareSlider";
import { ExampleGallery } from "../../components/landing/ExampleGallery";
import { QualityStory } from "../../components/landing/QualityStory";
import { TrustGrid } from "../../components/landing/TrustGrid";
import { TryIt } from "../../components/landing/TryIt";
import { EXAMPLES, HERO } from "../../components/landing/examples";
import styles from "../../components/landing/landing.module.css";
import { CREDITS_EXPIRY, ERASURE_WINDOW } from "../../components/legal/copy";

const TITLE = `${BRAND.name}: bulk background remover for Shopify product photos`;
const DESCRIPTION =
  "Remove messy backgrounds from your Shopify product photos in bulk. Every cut-out is checked automatically, " +
  "padded to 1:1 or 4:5 without cropping and previewed before anything changes. Originals backed up.";

// Made from the hero pair (public/examples/CREDITS.md): no third-party product or brand.
const OG_IMAGE = `${BRAND.site}/examples/og.jpg`;
const OG_IMAGE_ALT =
  "A leather messenger bag photographed on a park bench, and the same bag cut out onto white and evenly padded by Padly";

/** The hero frame's width: the right column on desktop, full width below 980 px. */
const HERO_SIZES = "(max-width: 980px) calc(100vw - 32px), 540px";

export const meta: MetaFunction = () => [
  { title: TITLE },
  { name: "description", content: DESCRIPTION },
  { property: "og:title", content: TITLE },
  { property: "og:description", content: DESCRIPTION },
  { property: "og:type", content: "website" },
  { property: "og:site_name", content: BRAND.name },
  { property: "og:url", content: `${BRAND.site}/` },
  { property: "og:image", content: OG_IMAGE },
  { property: "og:image:width", content: "1200" },
  { property: "og:image:height", content: "630" },
  { property: "og:image:alt", content: OG_IMAGE_ALT },
  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:image", content: OG_IMAGE },
  { name: "twitter:image:alt", content: OG_IMAGE_ALT },
  { tagName: "link", rel: "canonical", href: `${BRAND.site}/` },
];

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap",
  },
  // The same WebP variant the hero's <picture> will pick, so it isn't fetched twice.
  {
    rel: "preload",
    as: "image",
    type: "image/webp",
    imageSrcSet: HERO.after.srcSet,
    imageSizes: HERO_SIZES,
  },
  {
    rel: "preload",
    as: "image",
    type: "image/webp",
    imageSrcSet: HERO.before.srcSet,
    imageSizes: HERO_SIZES,
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Shopify opens the app URL with ?shop=…; send it into the embedded app.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  const e = env();
  return {
    // Install buttons link to the App Store listing once it's live; there is no
    // shop-domain field anywhere on the site (App Store requirement 2.3.1).
    appStoreUrl: e.APP_STORE_URL ?? null,
    packs: CREDIT_PACKS,
    freeCredits: e.FREE_CREDITS,
    tryLimit: e.TRY_DAILY_LIMIT,
    donateUrl: e.DONATE_URL ?? null,
    year: new Date().getFullYear(),
  };
};

const WaitlistSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(254),
  interest: z.enum(["web", "api", "woocommerce", "other"]).default("web"),
});

// The waitlist form is a few hundred bytes; anything bigger isn't a person.
const WAITLIST_MAX_BYTES = 16 * 1024;
const WAITLIST_DAILY_LIMIT = 5;

/** Read a small form body, giving up (null) as soon as it passes `maxBytes`. */
async function readSmallForm(
  request: Request,
  maxBytes: number,
): Promise<FormData | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    return null;
  // No trustworthy length (chunked uploads): count the bytes as they arrive.
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  return new Response(Buffer.concat(chunks), {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
}

/**
 * Reject after `ms`. The shared Redis connection retries forever (BullMQ needs
 * maxRetriesPerRequest: null), so while Redis is down a command waits instead of failing.
 */
function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("redis timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Count a sign-up from this IP today; false once it's over the daily limit. */
async function allowSignup(request: Request): Promise<boolean> {
  const key = `waitlist:${new Date().toISOString().slice(0, 10)}:${clientIp(request)}`;
  try {
    const used = await withTimeout(redis().incr(key));
    if (used === 1) await withTimeout(redis().expire(key, 2 * 24 * 3600));
    return used <= WAITLIST_DAILY_LIMIT;
  } catch (error) {
    // Don't lose a real sign-up because the limiter is down.
    console.error("waitlist rate limit unavailable", error);
    return true;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await readSmallForm(request, WAITLIST_MAX_BYTES);
  if (!form) {
    return data(
      { error: "That request was too large. Please try again." },
      { status: 413 },
    );
  }
  // Bots fill every field; people never see this one.
  if (form.get("company")) return { ok: true as const };
  const parsed = WaitlistSchema.safeParse({
    email: form.get("email"),
    interest: form.get("interest") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!(await allowSignup(request))) {
    return data(
      {
        error:
          "Too many sign-ups from your connection today. Please try again tomorrow.",
      },
      { status: 429 },
    );
  }
  await prisma.waitlist.upsert({
    where: { email: parsed.data.email },
    create: parsed.data,
    update: { interest: parsed.data.interest },
  });
  return { ok: true as const };
};

const STEPS = [
  {
    title: "Pick products",
    body: "Choose by collection, vendor, type or tag, first image or all of them. Untick anything you want to leave alone.",
  },
  {
    title: "We clean them",
    body: "Each original is backed up, then the product is cut out, centred and padded onto your canvas, and upscaled if you want.",
  },
  {
    title: "You review",
    body: "Drag through before and after, with the cut-out mask on top. Risky images are flagged and never approved in bulk.",
  },
  {
    title: "Apply or restore",
    body: "Images are replaced in place, so order, alt text and variant links stay. Restore any original later, free.",
  },
];

/** What the output looks like; the safety promises live in the trust grid. */
const FEATURES = [
  {
    title: "Pads, never crops",
    body: "Square or 4:5 canvas with the same margin around every product. Nothing gets cut off, however it was shot.",
    icon: "M4 4h16v16H4zM8 8h8v8H8z",
  },
  {
    title: "Background removal that holds up",
    body: "AI finds the product on busy backgrounds and keeps fine edges. Or keep your background and only centre it.",
    icon: "M4 17l5-5 4 4 7-7M4 4h16v16H4z",
  },
  {
    title: "Careful AI upscaling",
    body: "Only for small images, only if you switch it on. Labels and text get a safe non-AI resize, and results that drift are flagged.",
    icon: "M4 20L20 4M13 4h7v7",
  },
];

const FAQ = [
  {
    q: "How do you catch a bad cut-out?",
    a: "Every cut-out is checked automatically. Our fast model's cut-out is re-run on a mirrored copy of the photo; if the two disagree, it's rejected. We also check edges, dropped inner parts and labels. A rejected cut-out is redone by a stronger model at no extra credit, or flagged for you if it can't be. Anything still uncertain (glass, hair, fine chains, several separate pieces) is flagged and never approved in bulk.",
  },
  {
    q: "Will it crop my products?",
    a: "No. The product is found, centred and padded onto a square or 4:5 canvas with an even margin. If a product can't fit, the canvas grows; the product is never cut.",
  },
  {
    q: "Can AI upscaling change how my product looks?",
    a: "It can alter fine detail, which is why it's off by default and only runs on small images. Images with text or labels get a non-AI resize, every result is compared with the original, and anything that drifts is flagged for you to check.",
  },
  {
    q: "What happens to my original photos?",
    a: `They're backed up before anything changes, and you can restore any image or a whole job in one click, free. If you uninstall, backups are deleted when Shopify asks us to erase your data: ${ERASURE_WINDOW}.`,
  },
  {
    q: "Do image order, alt text and variant links stay?",
    a: "Yes. Images are replaced in place, so they keep their position, alt text and variant links. If Shopify refuses an in-place replace, the new image is attached and linked the same way.",
  },
  {
    q: "Which formats does it handle?",
    a: "JPG, PNG and WebP stay in their format. Other formats are converted to JPG. Output is sRGB, up to 20 megapixels.",
  },
  {
    q: "Where are my photos stored?",
    a: `On our server in the Netherlands (EU), with your store's data and backups. Harder cut-outs and some AI upscales are sent to a processing provider in the US, pixels only, and deleted there after an hour by default. Everything is erased ${ERASURE_WINDOW}.`,
  },
  {
    q: "What access does the Shopify app need?",
    a: "Products and files only. It never reads your orders or customers, and your images are never used to train AI models.",
  },
  {
    q: "How do credits work?",
    a: "Each image you apply costs 1 credit, plus 1 more when AI upscaling runs on it. Previews, rejected and failed images are free, and so are restores, though a restore doesn't give back the credits spent applying the image.",
  },
  {
    q: "Do credits expire?",
    a: CREDITS_EXPIRY,
  },
];

function Icon({ d }: { d: string }) {
  return (
    <span className={styles.icon} aria-hidden="true">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </span>
  );
}

/**
 * "Install on Shopify" once APP_STORE_URL points at the listing. Until then a quiet,
 * non-interactive notice: never a field asking for the store's domain.
 */
function InstallCta({ url, small }: { url: string | null; small?: boolean }) {
  const size = small ? styles.btnSmall : "";
  if (url) {
    return (
      <a className={`${styles.btn} ${styles.btnPrimary} ${size}`} href={url}>
        <span className={styles.shopifyDot} aria-hidden="true" /> Install on
        Shopify
      </a>
    );
  }
  return (
    <span className={`${styles.btn} ${styles.btnSoon} ${size}`}>
      <span className={styles.soonDot} aria-hidden="true" />{" "}
      {small
        ? "Coming soon to Shopify"
        : "Coming soon to the Shopify App Store"}
    </span>
  );
}

export default function Landing() {
  const { appStoreUrl, packs, freeCredits, tryLimit, donateUrl, year } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const joining =
    navigation.state === "submitting" && navigation.formAction === "/?index";

  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <div className={`${styles.wrap} ${styles.navInner}`}>
          <a
            className={styles.brand}
            href="/"
            aria-label={`${BRAND.name} home`}
          >
            <span className={styles.brandMark} />
            <span className={styles.brandName}>{BRAND.name}</span>
          </a>
          <nav className={styles.navLinks} aria-label="Sections">
            <a href="#examples">Examples</a>
            <a href="#quality">Quality checks</a>
            <a href="#try">Try it</a>
            <a href="#how">How it works</a>
            <a href="#ways">Shopify &amp; API</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
          <InstallCta url={appStoreUrl} small />
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={`${styles.wrap} ${styles.heroGrid}`}>
            <div>
              <span
                className={`${styles.kicker} ${styles.reveal} ${styles.d1}`}
              >
                Product photo cleanup, in bulk
              </span>
              <h1 className={`${styles.h1} ${styles.reveal} ${styles.d2}`}>
                Every product photo, <em>studio&#8209;clean.</em>
              </h1>
              <p className={`${styles.lede} ${styles.reveal} ${styles.d3}`}>
                Remove messy backgrounds, centre every product on a square or
                4:5 canvas without cropping, and sharpen small shots with AI,
                across your whole catalog, with a preview before anything
                changes.
              </p>
              <div className={`${styles.ctaRow} ${styles.reveal} ${styles.d4}`}>
                {appStoreUrl ? (
                  <>
                    <InstallCta url={appStoreUrl} />
                    <a
                      className={`${styles.btn} ${styles.btnGhost}`}
                      href="#try"
                    >
                      Try your photo
                    </a>
                  </>
                ) : (
                  <>
                    <a
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      href="#try"
                    >
                      Try your photo
                    </a>
                    <InstallCta url={null} />
                  </>
                )}
              </div>
              <p
                className={`${styles.microcopy} ${styles.reveal} ${styles.d4}`}
              >
                {freeCredits} free credits · Pay only for images you apply ·
                Every original backed up
              </p>
            </div>
            <div
              className={`${styles.heroVisual} ${styles.reveal} ${styles.d3}`}
            >
              <div className={styles.heroFrame}>
                <CompareSlider
                  before={HERO.before}
                  after={HERO.after}
                  alt={HERO.alt}
                  label={HERO.title}
                  selection={HERO.selection}
                  sizes={HERO_SIZES}
                  demo
                  priority
                />
              </div>
              <div className={styles.heroCaption}>
                <span>{HERO.caption}, 1:1</span>
                <span>Drag the handle ↔</span>
              </div>
            </div>
          </div>
        </section>

        <div className={styles.strip}>
          <div className={`${styles.wrap} ${styles.stripInner}`}>
            <span>Every cut-out checked automatically</span>
            <span>Nothing changes until you approve</span>
            <span>Originals backed up</span>
            <span>Billed through Shopify</span>
            <span>Stored in the EU</span>
          </div>
        </div>

        <section className={styles.section} id="examples">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>Examples</span>
                <h2 className={styles.h2}>
                  Messy in, <em>matched</em> out.
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                {EXAMPLES.length} real product photos with real clutter, run
                through the same pipeline your products go through and not
                retouched. Same canvas, same margin, same white, every time.
                Drag any frame.
              </p>
            </div>
            <ExampleGallery examples={EXAMPLES} />
          </div>
        </section>

        <QualityStory />

        <section className={styles.section} id="try">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>Try it free</span>
                <h2 className={styles.h2}>
                  Your photo, <em>cleaned</em> in seconds.
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                No account, no card. Drop in one product photo and see the
                result in the same frame, the way it would land in your store.
              </p>
            </div>
            <TryIt limit={tryLimit} />
          </div>
        </section>

        <section className={styles.section} id="how" style={{ paddingTop: 0 }}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>How it works</span>
                <h2 className={styles.h2}>
                  Four steps. <em>Nothing changes</em> until you say so.
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                Built for catalogs, not one-off edits: hundreds of products in
                one job, reviewed in one place.
              </p>
            </div>
            <ol
              className={styles.steps}
              style={{ listStyle: "none", margin: 0, padding: 0 }}
            >
              {STEPS.map((s, i) => (
                <li className={styles.step} key={s.title}>
                  <div className={styles.stepNum}>
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
            <div className={`${styles.features} ${styles.featuresAfterSteps}`}>
              {FEATURES.map((f) => (
                <div className={styles.feature} key={f.title}>
                  <Icon d={f.icon} />
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.trustSection}`} id="trust">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>
                  Why it&apos;s safe to run on your store
                </span>
                <h2 className={styles.h2}>
                  Built to be trusted <em>with a live store.</em>
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                Bulk tools are only useful if you can trust them. Every change
                is previewed, reversible and paid for only when it lands.
              </p>
            </div>
            <TrustGrid packs={packs} />
          </div>
        </section>

        <section className={`${styles.section} ${styles.dark}`} id="ways">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>Two ways to use it</span>
                <h2 className={styles.h2}>
                  One engine. <em>Your platform.</em>
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                The same image engine powers the Shopify app first, then a web
                app and API for WooCommerce, Etsy and Amazon sellers,
                marketplaces and agencies.
              </p>
            </div>
            <div className={styles.ways}>
              <div className={styles.way}>
                {appStoreUrl ? (
                  <span className={`${styles.wayBadge} ${styles.wayBadgeLive}`}>
                    Available now
                  </span>
                ) : (
                  <span className={styles.wayBadge}>Coming soon</span>
                )}
                <h3>Shopify app</h3>
                <p>
                  Works inside your Shopify admin and writes straight back to
                  your products.
                </p>
                <ul className={styles.wayList}>
                  <li>Bulk by collection, vendor, type or tag</li>
                  <li>Replaced in place: order, alt text and variants kept</li>
                  <li>Billed through your Shopify invoice</li>
                  <li>{freeCredits} free credits to try it</li>
                </ul>
                <div className={styles.wayCta}>
                  <InstallCta url={appStoreUrl} />
                  <p className={styles.formNote}>
                    {appStoreUrl
                      ? `Installs from the Shopify App Store and opens inside your Shopify admin. Questions?`
                      : `${BRAND.name} will install from the Shopify App Store. Questions in the meantime?`}{" "}
                    <a href={`mailto:${BRAND.supportEmail}`}>Email us</a>.
                  </p>
                </div>
              </div>

              <div className={styles.way}>
                <span className={styles.wayBadge}>Next · waitlist open</span>
                <h3>Web app &amp; API</h3>
                <p>
                  For every other store: upload photos or send links, get the
                  same studio-clean results back.
                </p>
                <ul className={styles.wayList}>
                  <li>Drag and drop, or a list of image links</li>
                  <li>REST API with keys for your own tools</li>
                  <li>Download as a ZIP or send to your store</li>
                  <li>Presets for Amazon, Etsy and Google Shopping</li>
                </ul>
                {result && "ok" in result ? (
                  <p
                    className={`${styles.formNote} ${styles.formOk}`}
                    role="status"
                  >
                    You&apos;re on the list. We&apos;ll email you once, when it
                    launches.
                  </p>
                ) : (
                  <Form className={styles.waitlist} method="post">
                    <input
                      className={styles.honeypot}
                      type="text"
                      name="company"
                      tabIndex={-1}
                      autoComplete="off"
                      aria-hidden="true"
                    />
                    <input
                      className={styles.input}
                      type="email"
                      name="email"
                      placeholder="you@yourstore.com"
                      aria-label="Email address"
                      autoComplete="email"
                      required
                    />
                    <select
                      className={`${styles.input} ${styles.select}`}
                      name="interest"
                      aria-label="What would you use?"
                      defaultValue="web"
                    >
                      <option value="web">Web app</option>
                      <option value="api">API</option>
                      <option value="woocommerce">WooCommerce</option>
                      <option value="other">Something else</option>
                    </select>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      type="submit"
                      disabled={joining}
                    >
                      {joining ? "Joining…" : "Join the waitlist"}
                    </button>
                    <p
                      className={`${styles.formNote} ${result && "error" in result ? styles.formErr : ""}`}
                      role={result && "error" in result ? "alert" : undefined}
                    >
                      {result && "error" in result
                        ? result.error
                        : "One email when it launches. No spam, no sharing."}
                    </p>
                    <p className={styles.formNote}>
                      <a href={`${PAGES.privacy}#website-data`}>
                        How we use your email — Privacy policy
                      </a>
                    </p>
                  </Form>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section} id="pricing">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>Pricing</span>
                <h2 className={styles.h2}>
                  Pay for results, <em>not attempts.</em>
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                1 credit per image you apply, plus 1 when AI upscaling runs on
                it. You&apos;re only charged for images you apply.{" "}
                {CREDITS_EXPIRY}
              </p>
            </div>
            <div className={styles.plans}>
              <div className={styles.plan}>
                <span className={styles.planName}>Free</span>
                <span className={styles.planPrice}>$0</span>
                <span className={styles.planCredits}>
                  {freeCredits} credits
                </span>
                <span className={styles.planPer}>
                  On install, no card needed
                </span>
              </div>
              {packs.map((p) => (
                <div
                  className={`${styles.plan} ${p.id === "growth" ? styles.planFeatured : ""}`}
                  key={p.id}
                >
                  <span className={styles.planName}>
                    {p.name.replace(" pack", "")}
                  </span>
                  <span className={styles.planPrice}>
                    ${p.price}
                    <span className={styles.planCurrency}>USD</span>
                  </span>
                  <span className={styles.planCredits}>
                    {p.credits.toLocaleString("en-US")} credits
                  </span>
                  <span className={styles.planPer}>
                    {((p.price / p.credits) * 100).toFixed(1)}¢ per credit
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.pricingNotes}>
              <span>✓ Charged only when an image is applied</span>
              <span>✓ Failed and rejected images are free</span>
              <span>
                ✓ Restores are free (spent credits aren&apos;t returned)
              </span>
              <span>✓ One-time packs, billed through Shopify in USD</span>
            </div>
          </div>
        </section>

        <section className={styles.section} id="faq" style={{ paddingTop: 0 }}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.kicker}>FAQ</span>
                <h2 className={styles.h2}>
                  Good questions, <em>straight answers.</em>
                </h2>
              </div>
            </div>
            <div className={styles.faq}>
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
            <p className={styles.faqMore}>
              More answers, refunds and contact details on the{" "}
              <a href={PAGES.support}>support page</a>.
            </p>
          </div>
        </section>
      </main>

      {donateUrl && (
        <section className={styles.support} aria-label="Support the project">
          <div className={`${styles.wrap} ${styles.supportInner}`}>
            <p className={styles.supportText}>
              <span className={styles.heart} aria-hidden="true">
                ♥
              </span>{" "}
              {BRAND.name} is built independently. If it saved you time, you can
              support its development.
            </p>
            <a
              className={`${styles.btn} ${styles.btnGhost}`}
              href={donateUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Support the project
            </a>
          </div>
        </section>
      )}

      <footer className={styles.footer}>
        <div className={`${styles.wrap} ${styles.footerGrid}`}>
          <a className={styles.brand} href="/">
            <span className={styles.brandMark} />
            <span>{BRAND.name}</span>
          </a>
          <nav className={styles.footerLinks} aria-label="Footer">
            <a href={PAGES.privacy}>Privacy</a>
            <a href={PAGES.terms}>Terms</a>
            <a href={PAGES.support}>Support</a>
            <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
          </nav>
        </div>
        <div className={styles.wrap}>
          <p className={styles.credit}>
            © {year} {BRAND.name} · Example photos from Pexels (free license),
            processed by {BRAND.name} and not retouched.
          </p>
        </div>
      </footer>
    </div>
  );
}
