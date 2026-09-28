import { useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireShop } from "../lib/app-context.server";
import { getCreditSummary } from "../lib/credits.server";
import { ANY, parseFilterForm } from "../lib/filters";
import { num } from "../lib/format";
import { createJob } from "../lib/jobs.server";
import { parsePresetForm, toPresetSettings } from "../lib/presets";
import { getDefaultPreset } from "../lib/shops.server";
import { SupportLink } from "../components/HelpFooter";
import { COLUMNS_2 } from "../components/layout";
import { PresetFields } from "../components/PresetFields";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

type Admin = Awaited<ReturnType<typeof requireShop>>["admin"];

/** Suggestions are a convenience: if a list can't load, the UI falls back to a text field. */
async function optionalList<T>(
  admin: Admin,
  query: string,
  pick: (data: Record<string, { nodes: T[] }>) => T[],
): Promise<T[] | null> {
  try {
    const res = await admin.graphql(query);
    const json = (await res.json()) as { data: Record<string, { nodes: T[] }> };
    return pick(json.data);
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop } = await requireShop(request);
  const [preset, credits, collections, vendors, productTypes] = await Promise.all([
    getDefaultPreset(shop.id),
    getCreditSummary(shop.id),
    optionalList<{ id: string; title: string }>(
      admin,
      `#graphql
      query PickerCollections { collections(first: 250, sortKey: TITLE) { nodes { id title } } }`,
      (d) => d.collections.nodes,
    ),
    optionalList<string>(
      admin,
      `#graphql
      query PickerVendors { productVendors(first: 250) { nodes } }`,
      (d) => d.productVendors.nodes,
    ),
    optionalList<string>(
      admin,
      `#graphql
      query PickerTypes { productTypes(first: 250) { nodes } }`,
      (d) => d.productTypes.nodes,
    ),
  ]);
  return { preset: toPresetSettings(preset as never), credits, collections, vendors, productTypes };
};

/** A fresh idempotency key for one render of the form (see NewJob). */
function newRequestKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // randomUUID needs a secure context; the admin always is one, plain-http dev may not be.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, redirect } = await requireShop(request);
  const form = await request.formData();
  const filter = parseFilterForm(form);
  const preset = parsePresetForm(form);
  // Same key → same job: a double click, a retried request or a second submit of this form
  // opens the job the first one created.
  const requestKey = String(form.get("requestKey") ?? "").trim() || null;

  if (!filter.success || !preset.success) {
    const errors: Record<string, string> = {};
    for (const issue of [...(filter.error?.issues ?? []), ...(preset.error?.issues ?? [])]) {
      errors[String(issue.path[0])] = issue.message;
    }
    return { errors };
  }

  const selection = filter.data;
  if (selection.collectionId) {
    try {
      const res = await admin.graphql(
        `#graphql
        query CollectionTitle($id: ID!) { collection(id: $id) { title } }`,
        { variables: { id: selection.collectionId } },
      );
      const json = await res.json();
      selection.collectionTitle = json.data?.collection?.title ?? undefined;
    } catch {
      // Title is only for display.
    }
  }

  let jobId: string;
  try {
    if (form.get("saveDefault") === "on") {
      await prisma.preset.updateMany({
        where: { shopId: shop.id, isDefault: true },
        data: preset.data,
      });
    }
    jobId = (await createJob(shop.id, selection, preset.data, { requestKey, source: "ui" })).id;
  } catch (error) {
    console.error(`[jobs] couldn't create a job for shop ${shop.id}:`, error);
    return { formError: "We couldn't start this job. Please try again in a moment." };
  }
  return redirect(`/app/jobs/${jobId}`);
};

export default function NewJob() {
  const { preset, credits, collections, vendors, productTypes } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && "errors" in actionData ? actionData.errors : undefined;
  const formError = actionData && "formError" in actionData ? actionData.formError : undefined;
  const submit = useSubmit();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = navigation.state !== "idle" && navigation.formMethod === "POST";
  // One idempotency key per visit to this form: made in the browser on the first submit (a
  // server-rendered one would differ from the hydrated client's) and sent with every submit
  // after it, so a double click or a resubmit opens the job the first one created. A new
  // visit (a new mount) gets a new key, so a deliberate second job is a new job.
  const requestKey = useRef<string | null>(null);

  const findImages = () => {
    if (!formRef.current) return;
    requestKey.current ??= newRequestKey();
    const form = new FormData(formRef.current);
    form.set("requestKey", requestKey.current);
    submit(form, { method: "post" });
  };

  return (
    <s-page heading="New job">
      <s-button slot="primary-action" variant="primary" onClick={findImages} {...(busy ? { loading: true } : {})}>
        Find images
      </s-button>

      {formError && (
        <s-banner tone="critical" heading="Something went wrong">
          {formError} If it keeps happening, <SupportLink>contact support</SupportLink>.
        </s-banner>
      )}

      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <s-section heading="Which products">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Leave everything as “Any” to include your whole catalog. We&apos;ll count the images and show the
              cost before anything is processed.
            </s-paragraph>
            {collections ? (
              <s-select label="Collection" name="collectionId" value={ANY} error={errors?.collectionId}>
                <s-option value={ANY}>Any collection</s-option>
                {collections.map((c) => (
                  <s-option key={c.id} value={c.id}>
                    {c.title}
                  </s-option>
                ))}
              </s-select>
            ) : (
              <s-text-field label="Collection ID" name="collectionId" placeholder="gid://shopify/Collection/123" />
            )}
            <s-query-container>
              <s-grid gridTemplateColumns={COLUMNS_2} gap="base">
                {vendors ? (
                  <s-select label="Vendor" name="vendor" value={ANY}>
                    <s-option value={ANY}>Any vendor</s-option>
                    {vendors.map((v) => (
                      <s-option key={v} value={v}>
                        {v}
                      </s-option>
                    ))}
                  </s-select>
                ) : (
                  <s-text-field label="Vendor" name="vendor" placeholder="Any vendor" />
                )}
                {productTypes ? (
                  <s-select label="Product type" name="productType" value={ANY}>
                    <s-option value={ANY}>Any type</s-option>
                    {productTypes.filter(Boolean).map((t) => (
                      <s-option key={t} value={t}>
                        {t}
                      </s-option>
                    ))}
                  </s-select>
                ) : (
                  <s-text-field label="Product type" name="productType" placeholder="Any type" />
                )}
              </s-grid>
            </s-query-container>
            <s-text-field label="Tag" name="tag" placeholder="Any tag" error={errors?.tag} />
            <s-select label="Images" name="imageScope" value="first">
              <s-option value="first">First image of each product</s-option>
              <s-option value="all">All images</s-option>
            </s-select>
          </s-stack>
        </s-section>

        <s-section heading="Clean & match preset">
          <PresetFields preset={preset} errors={errors} />
          <s-box paddingBlockStart="base">
            <s-checkbox label="Save these settings as my default" name="saveDefault" value="on" />
          </s-box>
        </s-section>
      </form>

      <s-section slot="aside" heading="Credits">
        <s-paragraph>
          <s-text type="strong">{num(credits.available)}</s-text> available
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            1 credit per applied image, 2 with AI upscaling. You&apos;ll see the exact cost before processing
            starts. Credits are reserved when you start and only charged for images you apply.
          </s-text>
        </s-paragraph>
        <s-link href="/app/billing">Buy credits</s-link>
      </s-section>
      <s-section slot="aside" heading="Safe by design">
        <s-unordered-list>
          <s-list-item>Every original is backed up before any change.</s-list-item>
          <s-list-item>Products are padded, never cropped.</s-list-item>
          <s-list-item>Flagged images always need your eyes.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
