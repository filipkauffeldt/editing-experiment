import type { Photo } from '@ee/contracts';
import { asSourceId } from '@ee/contracts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  STATUS_FILTERS,
  TAG_FILTERS,
  cameraOptions,
  filterCounts,
  isFiltering,
  toggleMinRating,
} from '../filters';
import type { SortMode } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { COLOR_CLASSES, COLOR_CLASS_NAMES } from './PhotoOverlays';
import { Button } from './ui/Button';
import { Menu, MenuHeading, MenuItem } from './ui/Menu';
import styles from './FilterBar.module.css';

/** Typing waits this long before the search runs. */
export const SEARCH_DEBOUNCE_MS = 250;

const SORTS: readonly { id: SortMode; label: string }[] = [
  { id: 'filename', label: 'Name' },
  { id: 'capture-time', label: 'Time' },
];

/**
 * The one filter bar of the Library and Develop: tag, rating, colour, status, camera and
 * source, text search, clear, count and sort. It reads and writes the store's single filter, so
 * what is set in one view is still set in the other.
 *
 * `scope` is the photos the view could show before any filter (the Library's folder, or every
 * photo in Develop); the counts and "N of M" are measured against it. `children` is the
 * right-hand slot: the Library puts its thumbnail size there and Develop its export actions.
 */
export function FilterBar({
  scope,
  shown,
  children,
}: {
  scope: readonly Photo[];
  /** How many photos the view shows after the filter. */
  shown: number;
  children?: ReactNode;
}) {
  const store = useAppStore();
  const state = useAppState();
  const { filter } = state;
  const searchIds = state.searchResult?.ids;
  const counts = useMemo(() => filterCounts(scope, filter, searchIds), [scope, filter, searchIds]);
  const cameras = useMemo(() => cameraOptions(state.photos), [state.photos]);
  const filtering = isFiltering(filter);
  const sort = SORTS.find((candidate) => candidate.id === state.sort) ?? SORTS[0];

  return (
    <div className={styles.bar} role="search" aria-label="Filter photos" data-testid="filter-bar">
      <div className={styles.group} role="group" aria-label="Tag">
        {TAG_FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`${styles.tab} ${filter.tag === id ? styles.tabActive : ''}`}
            aria-pressed={filter.tag === id}
            onClick={() => store.setTagFilter(id)}
          >
            {label}
            <span className={`${styles.tabCount} mono`}>{counts.tag[id]}</span>
          </button>
        ))}
      </div>

      <div className={styles.stars} role="group" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`${styles.star} ${n <= filter.minRating ? styles.starOn : ''}`}
            aria-label={`${n} star${n === 1 ? '' : 's'} and up`}
            aria-pressed={filter.minRating === n}
            title={
              filter.minRating === n ? 'Click to clear' : `${n} star${n === 1 ? '' : 's'} and up`
            }
            onClick={() => store.setMinRating(toggleMinRating(filter.minRating, n))}
          >
            ★
          </button>
        ))}
      </div>

      <div className={styles.colors} role="group" aria-label="Colour class">
        {COLOR_CLASSES.slice(1).map((color, index) => {
          const colorClass = index + 1;
          const on = filter.colorClasses.includes(colorClass);
          return (
            <button
              key={colorClass}
              type="button"
              className={`${styles.colorButton} ${on ? styles.colorOn : ''}`}
              aria-pressed={on}
              aria-label={`Class ${colorClass}`}
              title={`Class ${colorClass} · ${COLOR_CLASS_NAMES[colorClass]}`}
              onClick={() => store.toggleColorFilter(colorClass)}
            >
              <span className={styles.dot} style={{ background: color }} />
            </button>
          );
        })}
      </div>

      <Menu
        label="Status"
        testId="filter-status"
        active={filter.statuses.length > 0}
        badge={filter.statuses.length > 0 ? filter.statuses.length : undefined}
      >
        <MenuHeading>Matches all ticked</MenuHeading>
        {STATUS_FILTERS.map(({ id, label }) => (
          <MenuItem
            key={id}
            kind="check"
            checked={filter.statuses.includes(id)}
            count={counts.status[id]}
            onSelect={() => store.toggleStatusFilter(id)}
          >
            {label}
          </MenuItem>
        ))}
      </Menu>

      <Menu
        label="Camera"
        testId="filter-camera"
        active={filter.camera !== undefined || filter.sourceId !== undefined}
        badge={
          (filter.camera === undefined ? 0 : 1) + (filter.sourceId === undefined ? 0 : 1) ||
          undefined
        }
      >
        <MenuHeading>Camera</MenuHeading>
        <MenuItem
          kind="radio"
          checked={filter.camera === undefined}
          onSelect={() => store.setCameraFilter(undefined)}
        >
          All bodies
        </MenuItem>
        {cameras.map((camera) => (
          <MenuItem
            key={camera.key}
            kind="radio"
            checked={filter.camera === camera.key}
            onSelect={() => store.setCameraFilter(camera.key)}
          >
            {camera.label}
          </MenuItem>
        ))}
        <MenuHeading>Source</MenuHeading>
        <MenuItem
          kind="radio"
          checked={filter.sourceId === undefined}
          onSelect={() => store.setSourceFilter(undefined)}
        >
          All sources
        </MenuItem>
        {state.sources.map((source) => (
          <MenuItem
            key={source.id}
            kind="radio"
            checked={filter.sourceId === asSourceId(source.id)}
            onSelect={() => store.setSourceFilter(asSourceId(source.id))}
          >
            {source.name}
          </MenuItem>
        ))}
      </Menu>

      <SearchBox />

      {filtering && (
        <button
          type="button"
          className={styles.clear}
          aria-label="Clear filters"
          title="Clear all filters"
          data-testid="filter-clear"
          onClick={() => store.clearFilters()}
        >
          ×
        </button>
      )}
      <span className={`${styles.count} mono`} data-testid="filter-count" aria-live="polite">
        {filtering ? `${shown} of ${scope.length}` : scope.length}
      </span>

      <span className={styles.spacer} />

      <Menu label={`Sort: ${sort?.label ?? ''}`} testId="filter-sort" closeOnPick align="right">
        {SORTS.map(({ id, label }) => (
          <MenuItem
            key={id}
            kind="radio"
            checked={state.sort === id}
            onSelect={() => store.setSort(id)}
          >
            {label}
          </MenuItem>
        ))}
      </Menu>

      {children && (
        <div className={styles.slot} data-testid="filter-slot">
          {children}
        </div>
      )}
    </div>
  );
}

/** The search field. Typing is debounced; Enter applies it now and leaves; Esc clears and leaves. */
function SearchBox() {
  const store = useAppStore();
  const state = useAppState();
  const applied = state.filter.search;
  const [draft, setDraft] = useState(applied);
  const sent = useRef(applied);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleared from elsewhere (the × or the empty state): follow it, but never undo typing in flight.
  useEffect(() => {
    if (applied !== sent.current) {
      sent.current = applied;
      setDraft(applied);
    }
  }, [applied]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const apply = (value: string): void => {
    clearTimeout(timer.current);
    sent.current = value;
    store.setSearch(value);
  };

  return (
    <input
      type="search"
      className={styles.search}
      placeholder="Search…"
      title="Search file name, caption and keywords (Ctrl/⌘+F)"
      aria-label="Search file name, caption and keywords"
      data-filter-search
      data-testid="filter-search"
      autoComplete="off"
      spellCheck={false}
      value={draft}
      onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => apply(value), SEARCH_DEBOUNCE_MS);
      }}
      onKeyDown={(event) => {
        // Nothing typed here is a shortcut, and Esc must not also do what Esc does elsewhere.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDraft('');
          apply('');
          event.currentTarget.blur();
        } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          apply(draft);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Shown in place of the grid or film strip when the filter hides every photo. */
export function FilterEmpty({ hidden }: { hidden: number }) {
  const store = useAppStore();
  return (
    <div className={styles.empty} data-testid="filter-empty">
      <p>
        No photo matches the filter. {hidden} {hidden === 1 ? 'photo is' : 'photos are'} hidden,
        none are lost.
      </p>
      <Button onClick={() => store.clearFilters()}>Clear filters</Button>
    </div>
  );
}
