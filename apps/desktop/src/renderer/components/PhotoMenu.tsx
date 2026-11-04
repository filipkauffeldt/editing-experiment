import { useEffect, useRef } from 'react';
import { useAppState, useAppStore } from '../store-context';
import styles from './PhotoMenu.module.css';

/** The right-click menu of a photo in the grid or film strip. It has one item: Delete…. */
export function PhotoMenu() {
  const store = useAppStore();
  const { photoMenu } = useAppState();
  const menuRef = useRef<HTMLDivElement>(null);

  // Any click elsewhere, a scroll, a resize or the window losing focus closes it.
  useEffect(() => {
    if (!photoMenu) return;
    const close = (): void => store.closePhotoMenu();
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [store, photoMenu]);

  if (!photoMenu) return null;
  // Keep the menu inside the window when the click is near an edge.
  const left = Math.max(4, Math.min(photoMenu.x, window.innerWidth - 150));
  const top = Math.max(4, Math.min(photoMenu.y, window.innerHeight - 40));
  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label="Photo"
      style={{ left, top }}
      data-testid="photo-menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        autoFocus
        data-testid="photo-menu-delete"
        onClick={() => store.requestDelete()}
      >
        Delete…
      </button>
    </div>
  );
}
