'use client';

import { useEffect, useRef, type RefObject } from 'react';

const dialogStack: HTMLElement[] = [];
let lockedBodyOverflow = '';

function focusableElements(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0,
  );
}

function focusFirst(dialog: HTMLElement) {
  const preferred = dialog.querySelector<HTMLElement>('[data-dialog-autofocus]');
  (preferred ?? focusableElements(dialog)[0] ?? dialog).focus();
}

export function useDialogFocus(onClose: () => void, openerRef?: RefObject<HTMLElement | null>) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);

  // A parent's inline callback can change while the user is typing in the dialog.
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const currentDialog = dialogRef.current;
    if (!currentDialog) return;
    const dialog: HTMLElement = currentDialog;
    const activeElement = document.activeElement;
    const opener =
      openerRef?.current ?? (activeElement instanceof HTMLElement ? activeElement : null);

    if (dialogStack.length === 0) {
      lockedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    dialogStack.push(dialog);
    focusFirst(dialog);

    function handleKeyDown(event: KeyboardEvent) {
      if (dialogStack.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements(dialog);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    function keepFocusInside(event: FocusEvent) {
      if (
        dialogStack.at(-1) === dialog &&
        event.target instanceof Node &&
        !dialog.contains(event.target)
      ) {
        (focusableElements(dialog)[0] ?? dialog).focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', keepFocusInside);
      const wasTopDialog = dialogStack.at(-1) === dialog;
      const stackIndex = dialogStack.indexOf(dialog);
      if (stackIndex !== -1) dialogStack.splice(stackIndex, 1);
      if (dialogStack.length === 0) document.body.style.overflow = lockedBodyOverflow;
      if (!wasTopDialog) return;

      const remainingDialog = dialogStack.at(-1);
      if (
        opener?.isConnected &&
        !opener.matches(':disabled') &&
        !opener.closest('[inert]') &&
        opener.getClientRects().length > 0 &&
        (!remainingDialog || remainingDialog.contains(opener))
      ) {
        opener.focus();
      } else if (remainingDialog?.isConnected) {
        focusFirst(remainingDialog);
      } else {
        document.getElementById('main-content')?.focus();
      }
    };
  }, [openerRef]);

  return dialogRef;
}
