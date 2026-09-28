import { formatDate, type JobRow } from "../lib/format";

export type { JobRow };

/**
 * The jobs history (Home's recent jobs, the Jobs page). Rows are built on the server with
 * jobListRow from live item counts, so they carry display strings only: never the job's raw
 * filter, which can hold thousands of product ids.
 */
export function JobsTable({ jobs }: { jobs: JobRow[] }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Job</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header>Images</s-table-header>
        <s-table-header>Created</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {jobs.map((job) => (
          <s-table-row key={job.id}>
            <s-table-cell>
              <s-stack direction="block" gap="small-300">
                <s-link href={`/app/jobs/${job.id}`}>{job.name}</s-link>
                {job.scope && <s-text color="subdued">{job.scope}</s-text>}
              </s-stack>
            </s-table-cell>
            <s-table-cell>
              <s-badge tone={job.badge.tone}>{job.badge.label}</s-badge>
            </s-table-cell>
            <s-table-cell>{job.images}</s-table-cell>
            <s-table-cell>{formatDate(job.createdAt)}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
