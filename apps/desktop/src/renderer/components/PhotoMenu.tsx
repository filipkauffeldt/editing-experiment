import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { COLOR_CLASSES, COLOR_CLASS_NAMES } from './PhotoOverlays';
import styles from './PhotoMenu.module.css';

/**
 * The right-click menu of a photo in the grid or film strip: Tag, a rating row and a colour row
 * (which act on the Library's selection, or the open photo in Develop), then Delete… and
 * Remove from Library….
 */
export function PhotoMenu() {
  const store = useAppStore();
  const { photoMenu, photos, selection, selectedId, module } = useAppState();
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
  // The photos Tag, rating and colour apply to: the same ones the shortcuts act on.
  const targetIds = module === 'library' && selection.length > 0 ? selection : [selectedId];
  const targets = photos.filter((photo) => targetIds.includes(photo.id));
  const allTagged = targets.length > 0 && targets.every((photo) => photo.tagged);
  const sharedRating = targets.every((photo) => photo.rating === targets[0]?.rating)
    ? targets[0]?.rating
    : undefined;
  const sharedClass = targets.every((photo) => photo.colorClass === targets[0]?.colorClass)
    ? targets[0]?.colorClass
    : undefined;
  const apply = (action: () => void): void => {
    action();
    store.closePhotoMenu();
  };
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
        data-testid="photo-menu-tag"
        onClick={() => apply(() => store.toggleTag())}
      >
        {allTagged ? 'Untag' : 'Tag'}
        <span className={`${styles.hint} mono`}>T</span>
      </button>
      <div className={styles.row} role="group" aria-label="Rating">
        <span className={styles.rowLabel}>Rating</span>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={sharedRating === 0}
          className={styles.swatch}
          aria-label="No rating"
          title="No rating (0)"
          onClick={() => apply(() => store.setRating(0))}
        >
          ×
        </button>
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            role="menuitemradio"
            aria-checked={sharedRating === rating}
            className={`${styles.swatch} mono`}
            aria-label={`Rate ${rating}`}
            title={`Rating ${rating} of 5`}
            onClick={() => apply(() => store.setRating(rating))}
          >
            {rating}
          </button>
        ))}
      </div>
      <div className={styles.row} role="group" aria-label="Class">
        <span className={styles.rowLabel}>Class</span>
        {COLOR_CLASSES.slice(1).map((color, index) => (
          <button
            key={color}
            type="button"
            role="menuitemradio"
            aria-checked={sharedClass === index + 1}
            className={styles.swatch}
            aria-label={`Set class ${index + 1}`}
            title={`Class ${index + 1} · ${COLOR_CLASS_NAMES[index + 1]}`}
            onClick={() => apply(() => store.setColorClass(index + 1))}
          >
            <span className={styles.dot} style={{ background: color }} />
          </button>
        ))}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={sharedClass === 0}
          className={styles.swatch}
          aria-label="Clear class"
          title="Clear class"
          onClick={() => apply(() => store.setColorClass(0))}
        >
          ×
        </button>
      </div>
      <hr className={styles.separator} />
      <button
        type="button"
        role="menuitem"
        className={styles.item}
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
