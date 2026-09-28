import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireShop } from "../lib/app-context.server";
import { JOB_LIST_FIELDS, jobListRow } from "../lib/format";
import { itemCountsByJob } from "../lib/jobs.server";
import { listUnreadNotifications } from "../lib/notifications.server";
import { JobsTable } from "../components/JobsTable";
import { NotificationBanners } from "../components/NotificationBanners";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const page = Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1);
  const [jobs, total, notifications] = await Promise.all([
    prisma.job.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: JOB_LIST_FIELDS,
    }),
    prisma.job.count({ where: { shopId: shop.id } }),
    listUnreadNotifications(shop.id, 5),
  ]);
  // Live counts for the whole page in one query (the stored Job counters are phase-scoped).
  const counts = await itemCountsByJob(jobs.map((j) => j.id));
  return {
    jobs: jobs.map((j) => jobListRow(j, counts.get(j.id) ?? {})),
    notifications: notifications.map((n) => ({
      id: n.id,
      kind: n.kind,
      tone: n.tone,
      title: n.title,
      body: n.body,
      url: n.url,
    })),
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
};

export default function Jobs() {
  const { jobs, notifications, page, pages } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Jobs">
      <s-button slot="primary-action" variant="primary" href="/app/jobs/new">
        New job
      </s-button>
      <NotificationBanners notifications={notifications} />
      <s-section padding="none">
        {jobs.length ? (
          <JobsTable jobs={jobs} />
        ) : (
          <s-box padding="base">
            <s-paragraph>
              No jobs yet. <s-link href="/app/jobs/new">Pick some products</s-link> to see previews. Nothing on
              your store changes until you approve.
            </s-paragraph>
          </s-box>
        )}
      </s-section>
      {pages > 1 && (
        <s-stack direction="inline" gap="base" justifyContent="center">
          {page > 1 && <s-button href={`/app/jobs?page=${page - 1}`}>Previous</s-button>}
          <s-text color="subdued">
            Page {page} of {pages}
          </s-text>
          {page < pages && <s-button href={`/app/jobs?page=${page + 1}`}>Next</s-button>}
        </s-stack>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
