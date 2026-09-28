/**
 * Responsive s-grid columns: side by side when the surrounding s-query-container is wide,
 * stacked on phones. Track lists avoid commas (no repeat(3, 1fr)): commas separate the
 * query's branches.
 */
export const COLUMNS_3 = "@container (inline-size > 500px) 1fr 1fr 1fr, 1fr";
export const COLUMNS_2 = "@container (inline-size > 500px) 1fr 1fr, 1fr";
