import type { ReactNode } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

interface Props {
  id: string;
  heading: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive or hard to undo: the confirm button is red. */
  critical?: boolean;
  onConfirm: () => void;
  children: ReactNode;
}

/**
 * Confirmation dialog for actions that change the live store or throw work away. Open it from
 * the triggering button with the function useConfirm() returns. Page actions are drawn in the
 * admin's title bar, where click handlers are proxied back to the page, so both opening and
 * closing go through App Bridge's modal API rather than `commandFor`.
 */
export function ConfirmModal({ id, heading, confirmLabel, cancelLabel = "Cancel", critical, onConfirm, children }: Props) {
  const shopify = useAppBridge();
  const close = () => void shopify.modal.hide(id);
  return (
    <s-modal id={id} heading={heading}>
      <s-stack direction="block" gap="base">
        {children}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        tone={critical ? "critical" : "auto"}
        onClick={() => {
          close();
          onConfirm();
        }}
      >
        {confirmLabel}
      </s-button>
      <s-button slot="secondary-actions" onClick={close}>
        {cancelLabel}
      </s-button>
    </s-modal>
  );
}

/** Returns a function that opens the ConfirmModal with the given id. */
export function useConfirm() {
  const shopify = useAppBridge();
  return (id: string) => void shopify.modal.show(id);
}
