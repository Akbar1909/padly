import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireShop } from "../lib/app-context.server";
import { emailNotificationsAvailable, notifyEmailEnabled, setNotifyEmail } from "../lib/notifications.server";
import { parsePresetForm, toPresetSettings } from "../lib/presets";
import { getDefaultPreset } from "../lib/shops.server";
import { PAGES } from "../lib/brand";
import { HelpFooter, siteUrl } from "../components/HelpFooter";
import { ERASURE_WINDOW } from "../components/legal/copy";
import { PresetFields } from "../components/PresetFields";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const preset = await getDefaultPreset(shop.id);
  return {
    preset: toPresetSettings(preset as never),
    // Only when an email provider is configured (none is today): no toggle that does nothing.
    email: emailNotificationsAvailable() ? { enabled: notifyEmailEnabled(shop.settings) } : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const form = await request.formData();
  const parsed = parsePresetForm(form);
  if (!parsed.success) {
    return {
      errors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    };
  }
  const preset = await getDefaultPreset(shop.id);
  await prisma.preset.update({ where: { id: preset.id }, data: parsed.data });
  // The checkbox is only on the page when a sender exists; otherwise leave the setting alone.
  if (emailNotificationsAvailable()) await setNotifyEmail(shop.id, form.get("notifyEmail") === "on");
  return { saved: true };
};

export default function Settings() {
  const { preset, email } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = navigation.state === "submitting";
  const hasEmail = email !== null;

  useEffect(() => {
    if (actionData && "saved" in actionData) shopify.toast.show(hasEmail ? "Settings saved" : "Default preset saved");
  }, [actionData, shopify, hasEmail]);

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => formRef.current && submit(new FormData(formRef.current), { method: "post" })}
        {...(busy ? { loading: true } : {})}
      >
        Save
      </s-button>

      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <s-section heading="Default “Clean & match” preset">
          <PresetFields preset={preset} errors={actionData && "errors" in actionData ? actionData.errors : undefined} />
        </s-section>

        {email && (
          <s-section heading="Notifications">
            <s-checkbox
              label="Email me when a job finishes"
              name="notifyEmail"
              value="on"
              details="We send it to your store's contact email when processing or applying finishes. You'll always see it on Home too."
              {...(email.enabled ? { checked: true } : {})}
            />
          </s-section>
        )}
      </form>

      <s-section slot="aside" heading="Your data">
        <s-paragraph>
          Every original image is backed up before it&apos;s changed and kept for as long as the app is installed,
          so you can restore it at any time.
        </s-paragraph>
        <s-paragraph>
          If you uninstall, your backups, previews and unused credits are deleted {ERASURE_WINDOW}. Server backup
          copies expire 14 days after that. Restore anything you want to keep before uninstalling.
        </s-paragraph>
        <s-paragraph>We never read orders or customer data.</s-paragraph>
        <s-link href={siteUrl(PAGES.privacy)} target="_blank">
          Privacy policy
        </s-link>
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
