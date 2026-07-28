"use client";

import { useRef } from "react";

export function ConfirmationDialog({
  confirmLabel,
  description,
  disabled = false,
  onConfirm,
  title,
  triggerLabel,
}: Readonly<{
  confirmLabel: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
  title: string;
  triggerLabel: string;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeDialog() {
    dialogRef.current?.close();
    triggerRef.current?.focus();
  }

  function openDialog() {
    if (disabled) return;
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }

  return (
    <>
      <button
        className="button button--secondary"
        disabled={disabled}
        onClick={openDialog}
        ref={triggerRef}
        type="button"
      >
        {triggerLabel}
      </button>
      <dialog
        aria-describedby="confirmation-description"
        aria-labelledby="confirmation-title"
        className="confirmation-dialog"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        ref={dialogRef}
      >
        <div className="confirmation-dialog__body">
          <p className="dialog-label">Confirm action</p>
          <h2 id="confirmation-title">{title}</h2>
          <p id="confirmation-description">{description}</p>
          <div className="confirmation-dialog__actions">
            <button
              className="button button--secondary"
              onClick={closeDialog}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button--danger"
              onClick={() => {
                onConfirm();
                closeDialog();
              }}
              type="button"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
