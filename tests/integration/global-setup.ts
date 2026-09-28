import { execSync } from "node:child_process";

/** Apply migrations to the dedicated test schema (non-destructive; tests truncate their own tables). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://vio:vio@localhost:55432/vio?schema=vitest";
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
