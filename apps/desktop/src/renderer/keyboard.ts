import { useEffect } from 'react';
import type { AppStore } from './store';

/** Focus the caption editor without threading a ref through every panel. */
export function focusCaptionField(): void {
  document.querySelector<HTMLTextAreaElement>('[data-caption-input]')?.focus();
}

function isTypingTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Global shortcuts. While an input, textarea, select or contenteditable has
 * focus only the explicit command shortcuts work (Ctrl/Cmd+Enter, Ctrl/Cmd+I,
 * Escape and Ctrl+Space inside the caption).
 */
export function useKeyboardShortcuts(store: AppStore): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = store.getState();
      const typing = isTypingTarget(event.target);
      const command = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape') {
        if (state.shortcutsOpen) {
          event.preventDefault();
          store.toggleShortcuts(false);
          return;
        }
        if (state.dialog) return;
        if (typing) {
          event.preventDefault();
          event.target.blur();
        }
        return;
      }

      if (state.dialog || state.shortcutsOpen) return;

      if (command && event.key === 'Enter') {
        event.preventDefault();
        void store.finishAndNext();
        return;
      }
      if (command && (event.key === 'i' || event.key === 'I')) {
        event.preventDefault();
        focusCaptionField();
        return;
      }

      if (typing) return;
      if (event.repeat && (event.key === 't' || event.key === 'T')) return;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          store.selectRelative(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          store.selectRelative(1);
          break;
        case '?':
        case '/':
          if (event.key === '/' && !event.shiftKey) break;
          event.preventDefault();
          store.toggleShortcuts(true);
          break;
        case 't':
        case 'T':
          event.preventDefault();
          store.toggleTag();
          break;
        default:
          if (/^[0-8]$/.test(event.key)) {
            event.preventDefault();
            store.setColorClass(Number(event.key));
          }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);
}
