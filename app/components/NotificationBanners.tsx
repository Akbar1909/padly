import { useState } from "react";
import { useFetcher } from "react-router";
import type { NotificationKind, NotificationTone } from "../lib/notifications";

/** A notification as the browser gets it (from listUnreadNotifications). */
export interface NotificationBannerRow {
  id: string;
  kind: NotificationKind | string;
  tone: NotificationTone | string;
  title: string;
  /** The job's selection, e.g. "collection “Shoes” · first image". */
  body: string | null;
  url: string;
}

/**
 * Home's action handles dismissals, so any page can show these banners. An index route's
 * action needs `?index`. "Dismiss all" sends the ids of the banners on screen (one
 * `notificationId` field each), so a notification that arrived after the page loaded, or one
 * past the few shown, stays unread.
 */
export const NOTIFICATIONS_ACTION = "/app?index";
export const DISMISS_NOTIFICATION = "dismissNotification";
export const DISMISS_ALL_NOTIFICATIONS = "dismissAllNotifications";

type BannerTone = "success" | "warning" | "critical" | "info";
const TONES: BannerTone[] = ["success", "warning", "critical", "info"];
const toneOf = (tone: string): BannerTone => (TONES.includes(tone as BannerTone) ? (tone as BannerTone) : "info");

type DismissResult = { ok?: boolean; error?: string };

function NotificationBanner({ notification }: { notification: NotificationBannerRow }) {
  const fetcher = useFetcher<DismissResult>();
  // Hidden as soon as it's dismissed; comes back only if the server said no.
  if (fetcher.state !== "idle" || fetcher.data?.ok) return null;
  const dismiss = () =>
    fetcher.submit(
      { intent: DISMISS_NOTIFICATION, notificationId: notification.id },
      { method: "post", action: NOTIFICATIONS_ACTION },
    );
  const open = notification.kind === "job_processed" ? "Review results" : "View job";
  return (
    <s-banner tone={toneOf(notification.tone)} heading={notification.title}>
      {notification.body}
      {/* Opening the job marks its notifications read (the job page's loader). */}
      <s-button slot="secondary-actions" href={notification.url} accessibilityLabel={`${open}: ${notification.title}`}>
        {open}
      </s-button>
      {/* Not `dismissible`: React 18 doesn't wire the element's custom `dismiss` event, and a
          click always reaches us. */}
      <s-button
        slot="secondary-actions"
        variant="tertiary"
        onClick={dismiss}
        accessibilityLabel={`Dismiss: ${notification.title}`}
      >
        Dismiss
      </s-button>
    </s-banner>
  );
}

/** Unread notifications (a job finished processing or applying, an API job needs credits). */
export function NotificationBanners({ notifications }: { notifications: NotificationBannerRow[] }) {
  const dismissAll = useFetcher<DismissResult>();
  // The rows "Dismiss all" was pressed for: hidden while it runs and once it worked (back if
  // it failed). Rows that arrive later, while this page stays mounted, still show.
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const hideDismissed = dismissAll.state !== "idle" || dismissAll.data?.ok === true;
  const visible = hideDismissed ? notifications.filter((n) => !dismissedIds.has(n.id)) : notifications;
  if (!visible.length) return null;

  const onDismissAll = () => {
    const ids = visible.map((n) => n.id);
    setDismissedIds((prev) => new Set([...prev, ...ids]));
    const form = new FormData();
    form.set("intent", DISMISS_ALL_NOTIFICATIONS);
    ids.forEach((id) => form.append("notificationId", id));
    dismissAll.submit(form, { method: "post", action: NOTIFICATIONS_ACTION });
  };

  return (
    <s-stack direction="block" gap="small">
      {visible.map((n) => (
        <NotificationBanner key={n.id} notification={n} />
      ))}
      {visible.length > 1 && (
        <s-stack direction="inline" justifyContent="end">
          <s-button variant="tertiary" onClick={onDismissAll} accessibilityLabel="Dismiss all notifications">
            Dismiss all
          </s-button>
        </s-stack>
      )}
    </s-stack>
  );
}
