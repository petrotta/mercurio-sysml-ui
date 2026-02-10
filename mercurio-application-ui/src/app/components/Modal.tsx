import type { ReactNode } from "react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  cardClassName?: string;
  ariaLabelledBy?: string;
  children: ReactNode;
};

export function Modal({ open, onClose, cardClassName, ariaLabelledBy, children }: ModalProps) {
  if (!open) return null;
  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className={`modal-card${cardClassName ? ` ${cardClassName}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
      >
        {children}
      </div>
    </div>
  );
}
