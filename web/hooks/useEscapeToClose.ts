'use client';
import { useEffect } from 'react';

/** Closes an open overlay (slide-over, modal) on Escape — standard behavior
 * for any dismissible panel that a mouse-only click-outside handler doesn't
 * cover for keyboard users. Only attaches the listener while `isOpen`, so it
 * costs nothing when the panel is closed. */
export function useEscapeToClose(isOpen: boolean, onClose: () => void) {
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);
}
