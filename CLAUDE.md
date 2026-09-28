# Padly

Shopify embedded app (React Router template) + Node/BullMQ worker + Python GPU service. See README.md.

- Node 22 (`.nvmrc`). Shared server code lives in `app/lib/*.server.ts` and is imported by both routes and `worker/`.
- Shopify: GraphQL Admin API only, version `2026-07` (`app/shopify.server.ts`, `shopify.app.toml`). Background work uses `shopifyClientFor(shop)` (cost pacing + THROTTLED retries), never `admin.graphql` from a request.
- Polaris web components under React 18: boolean attributes must be spread only when true (`{...(x ? { checked: true } : {})}`); `onChange` on `s-*` elements is unreliable, so forms are read with `new FormData(form)` and submitted with `useSubmit`.
- Item state changes go through `app/lib/jobs.server.ts`; after any change that frees or creates work call `pumpShop(shopId)`. Credits: never edit `CreditLedger` rows; use `recordLedger` inside a transaction after `lockShop`.
- Never modify a Shopify image without a verified backup in storage (`applyItem` enforces this).
- The GPU service HTTP contract is `docs/gpu-service-contract.md`; change both sides together.
- Checks: `npx tsc --noEmit`, `npx eslint --ignore-path .gitignore .`, `npm test`, `npx vitest run -c vitest.integration.config.ts` (needs `docker-compose.dev.yml` services), `cd gpu-service && .venv/bin/pytest`.
