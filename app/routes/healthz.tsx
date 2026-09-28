import prisma from "../db.server";
import { env } from "../lib/env.server";

/** Health for docker-compose / uptime checks. Not authenticated; reveals nothing. */
export const loader = async () => {
  env(); // throws on missing/invalid config, so a misconfigured deploy never turns healthy
  await prisma.$queryRaw`SELECT 1`;
  return new Response("ok", { headers: { "Cache-Control": "no-store" } });
};
