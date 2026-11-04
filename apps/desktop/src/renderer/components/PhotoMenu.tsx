import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import styles from './PhotoMenu.module.css';

/** The right-click menu of a photo in the grid or film strip. It has two items: Delete… and Remove from Library…. */
export function PhotoMenu() {
  const store = useAppStore();
  const { photoMenu } = useAppState();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  // Keep the menu inside the window when the click is near an edge. The menu's own size is
  // measured before it is painted, so adding an item needs no number changed here.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!photoMenu || !menu) {
      setPosition(undefined);
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(photoMenu.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(photoMenu.y, window.innerHeight - height - 4)),
    });
  }, [photoMenu]);

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
  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label="Photo"
      style={position ?? { left: photoMenu.x, top: photoMenu.y }}
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
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        data-testid="photo-menu-remove-from-library"
        onClick={() => store.requestRemoveFromLibrary()}
      >
        Remove from Library…
      </button>
    </div>
  );
}
