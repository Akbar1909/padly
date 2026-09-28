import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireShop } from "../lib/app-context.server";
import { BillingError, confirmPurchase, createPurchase, CREDIT_PACKS } from "../lib/billing.server";
import { BRAND, PAGES } from "../lib/brand";
import { getCreditSummary } from "../lib/credits.server";
import { formatDate, ledgerLabel, num } from "../lib/format";
import { CreditStats } from "../components/CreditStats";
import { HelpFooter, siteUrl, SupportLink } from "../components/HelpFooter";
import { CREDITS_EXPIRY } from "../components/legal/copy";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

const PURCHASE_FAILED = "Shopify couldn't start the purchase. Try again, or contact support if it keeps happening.";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop } = await requireShop(request);

  // Back from Shopify's confirmation page: verify the charge before crediting.
  const purchaseId = new URL(request.url).searchParams.get("purchase");
  let returned: Awaited<ReturnType<typeof confirmPurchase>> = null;
  let confirming = false;
  if (purchaseId) {
    try {
      returned = await confirmPurchase(admin, shop.id, purchaseId);
    } catch (error) {
      // Auth responses from the Shopify library (re-auth, retry with a new token) must pass through.
      if (error instanceof Response) throw error;
      // The app_purchases_one_time/update webhook credits an approved pack without this check.
      console.error(`[billing] couldn't confirm purchase ${purchaseId}:`, error);
      confirming = true;
    }
  }

  const [credits, ledger] = await Promise.all([
    getCreditSummary(shop.id),
    prisma.creditLedger.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return {
    credits,
    ledger: ledger.map((row) => ({ id: row.id, createdAt: row.createdAt, delta: row.delta, label: ledgerLabel(row, CREDIT_PACKS) })),
    returned,
    confirming: confirming || returned?.status === "pending",
    packs: CREDIT_PACKS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, redirect } = await requireShop(request);
  const form = await request.formData();
  const packId = String(form.get("pack") ?? "");
  if (!CREDIT_PACKS.some((p) => p.id === packId)) {
    return { error: "Choose one of the credit packs below." };
  }

  let confirmationUrl: string;
  try {
    confirmationUrl = await createPurchase(admin, shop, packId);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(`[billing] couldn't create a purchase for shop ${shop.id}:`, error);
    return { error: error instanceof BillingError ? error.message : PURCHASE_FAILED };
  }
  // Shopify's approval page must open in the top window, outside the admin iframe.
  return redirect(confirmationUrl, { target: "_top" });
};

export default function Billing() {
  const { credits, ledger, returned, confirming, packs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const pending = navigation.state === "submitting" ? navigation.formData?.get("pack") : null;

  return (
    <s-page heading="Credits">
      {actionData?.error && (
        <s-banner tone="critical" heading="We couldn't start the purchase">
          {actionData.error} You haven&apos;t been charged. <SupportLink />
        </s-banner>
      )}
      {returned?.status === "active" && (
        <s-banner tone="success" heading="Credits added">
          {num(returned.credits)} credits are now in your balance.
        </s-banner>
      )}
      {confirming && (
        <s-banner tone="info" heading="Confirming your purchase">
          We&apos;re confirming your purchase with Shopify; credits will appear within a minute. Refresh this page to
          see them.
        </s-banner>
      )}
      {returned && !["active", "pending"].includes(returned.status) && (
        <s-banner tone="warning" heading="Purchase not completed">
          The charge was {returned.status}. No credits were added and you were not charged.
        </s-banner>
      )}

      <s-section heading="Balance">
        <CreditStats credits={credits} />
      </s-section>

      <s-section heading="Buy credits">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            {packs.map((pack) => (
              <s-box key={pack.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-heading>{pack.name}</s-heading>
                  <s-text>
                    <s-text type="strong">{num(pack.credits)}</s-text> credits
                  </s-text>
                  <s-text color="subdued">
                    ${pack.price} USD · {((pack.price / pack.credits) * 100).toFixed(1)}¢ per credit
                  </s-text>
                  <s-button
                    variant="primary"
                    onClick={() => submit({ pack: pack.id }, { method: "post" })}
                    {...(pending === pack.id ? { loading: true } : {})}
                  >
                    Buy
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-grid>
          <s-unordered-list>
            <s-list-item>
              1 credit per applied image, 2 with AI upscaling. Rejected, failed and unapplied images cost nothing.
            </s-list-item>
            <s-list-item>
              One-time purchases priced in US dollars (USD) and added to your Shopify bill. Shopify may show the charge
              in your billing currency and add taxes that apply to you. No subscription.
            </s-list-item>
            <s-list-item>{CREDITS_EXPIRY}</s-list-item>
            <s-list-item>Restores are free (they don&apos;t return credits).</s-list-item>
          </s-unordered-list>
          <s-paragraph>
            Unused credit packs can be refunded within 14 days of purchase (see{" "}
            <s-link href={`${siteUrl(PAGES.terms)}#refunds`} target="_blank">
              Refunds in our Terms
            </s-link>
            ). Billing question or refund request? Email <SupportLink>{BRAND.supportEmail}</SupportLink>.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="History">
        {ledger.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>What</s-table-header>
              <s-table-header format="numeric">Credits</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {ledger.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>{formatDate(row.createdAt)}</s-table-cell>
                  <s-table-cell>{row.label}</s-table-cell>
                  <s-table-cell>{row.delta > 0 ? `+${num(row.delta)}` : num(row.delta)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No credit activity yet.</s-paragraph>
        )}
      </s-section>

      <HelpFooter />
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
