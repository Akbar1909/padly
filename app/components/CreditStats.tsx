import { num } from "../lib/format";
import { COLUMNS_3 } from "./layout";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{num(value)}</s-heading>
    </s-box>
  );
}

/**
 * Credit balance boxes. Reserved and the full balance only matter while a job holds credits,
 * so with nothing reserved there's a single number.
 */
export function CreditStats({ credits }: { credits: { available: number; reserved: number; balance: number } }) {
  return (
    <s-stack direction="block" gap="small">
      <s-query-container>
        <s-grid gridTemplateColumns={COLUMNS_3} gap="base">
          <Stat label="Available credits" value={credits.available} />
          {credits.reserved > 0 && (
            <>
              <Stat label="Reserved by open jobs" value={credits.reserved} />
              <Stat label="Balance" value={credits.balance} />
            </>
          )}
        </s-grid>
      </s-query-container>
      {credits.reserved > 0 && (
        <s-text color="subdued">
          Reserved credits are held for images in open jobs. They&apos;re only used when an image is applied, and
          are freed if you don&apos;t apply it.
        </s-text>
      )}
    </s-stack>
  );
}
