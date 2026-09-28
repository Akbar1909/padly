import prisma from "../../app/db.server";
import { env } from "../../app/lib/env.server";
import { emailSender, notifyEmailEnabled } from "../../app/lib/notifications.server";
import { shopifyClientFor } from "../../app/lib/shopify/client.server";
import { log } from "../log";

/**
 * Email one notification to the shop owner. Only enqueued when an email provider is configured
 * (none is implemented today) and the shop turned emails on. The address is fetched from
 * Shopify at send time and never stored.
 */
export async function sendNotificationEmail(notificationId: string): Promise<void> {
  const sender = emailSender();
  if (!sender) return;
  const n = await prisma.notification.findUnique({ where: { id: notificationId }, include: { shop: true } });
  if (!n || n.emailedAt || n.shop.uninstalledAt || !notifyEmailEnabled(n.shop.settings)) return;

  const client = await shopifyClientFor(n.shop.domain);
  const data = await client.request<{ shop: { email: string | null } }>(
    `#graphql
    query NotificationEmail { shop { email } }`,
    {},
    { cost: 1 },
  );
  const to = data.shop.email;
  if (!to) return;

  const handle = n.shop.domain.replace(/\.myshopify\.com$/, "");
  const link = `https://admin.shopify.com/store/${handle}/apps/${env().SHOPIFY_API_KEY}${n.url.replace(/^\/app/, "")}`;
  await sender.send({
    to,
    subject: n.title,
    text: [n.title, n.body, `Review results: ${link}`].filter(Boolean).join("\n\n"),
    idempotencyKey: `notification:${n.id}`,
  });
  await prisma.notification.updateMany({ where: { id: n.id, emailedAt: null }, data: { emailedAt: new Date() } });
  log.info("notification emailed", { notificationId: n.id, provider: sender.name });
}
