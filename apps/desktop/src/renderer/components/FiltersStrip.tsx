import { asSourceId, type Photo } from '@ee/contracts';
import { useMemo } from 'react';
import { QUICK_FILTERS, cameraKey, cameraOptions, photoFlags, type QuickFilter } from '../store';
import { useAppState, useAppStore } from '../store-context';
import styles from './FiltersStrip.module.css';

function matches(photo: Photo, quick: QuickFilter, flags: { tagged: boolean }): boolean {
  switch (quick) {
    case 'all':
      return true;
    case 'untagged':
      return !flags.tagged;
    case 'tagged':
      return flags.tagged;
    case 'edited':
      return photo.status.edited;
    case 'not-uploaded':
      return photo.status.upload !== 'done';
    case 'failed-uploads':
      return photo.status.upload === 'failed';
    case 'metadata-differs':
      return photo.status.metadataDiffersFromTemplate;
  }
}

export function FiltersStrip({ visibleCount }: { visibleCount: number }) {
  const store = useAppStore();
  const state = useAppState();
  const cameras = useMemo(() => cameraOptions(state.photos), [state.photos]);

  const scoped = state.photos.filter((photo) => {
    if (state.filter.camera && cameraKey(photo) !== state.filter.camera) return false;
    if (state.filter.sourceId && photo.sourceId !== state.filter.sourceId) return false;
    return true;
  });

  const counts = QUICK_FILTERS.map(({ id }) => {
    const count = scoped.filter((photo) => matches(photo, id, photoFlags(state, photo.id))).length;
    return { id, count };
  });

  return (
    <div className={styles.strip} data-testid="filters">
      <div className={styles.quick}>
        {QUICK_FILTERS.map(({ id, label }, index) => (
          <button
            key={id}
            type="button"
            className={`${styles.filter} ${state.filter.quick === id ? styles.active : ''}`}
            onClick={() => store.setQuickFilter(id)}
          >
            {label}
            <span className={styles.count}>{counts[index]?.count ?? 0}</span>
          </button>
        ))}
      </div>

      <span className={styles.spacer} />

      <label className={styles.selectWrap}>
        <span className={styles.selectLabel}>Camera</span>
        <select
          className={styles.select}
          aria-label="Camera body"
          value={state.filter.camera ?? ''}
          onChange={(event) => store.setCameraFilter(event.target.value || undefined)}
        >
          <option value="">All bodies</option>
          {cameras.map((camera) => (
            <option key={camera.key} value={camera.key}>
              {camera.label}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.selectWrap}>
        <span className={styles.selectLabel}>Source</span>
        <select
          className={styles.select}
          aria-label="Source"
          value={state.filter.sourceId ?? ''}
          onChange={(event) =>
            store.setSourceFilter(event.target.value ? asSourceId(event.target.value) : undefined)
          }
        >
          <option value="">All sources</option>
          {state.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.sort} role="group" aria-label="Sort order">
        <span className={styles.selectLabel}>Sort</span>
        <button
          type="button"
          className={`${styles.sortButton} ${state.sort === 'filename' ? styles.active : ''}`}
          onClick={() => store.setSort('filename')}
        >
          Name
        </button>
        <button
          type="button"
          className={`${styles.sortButton} ${state.sort === 'capture-time' ? styles.active : ''}`}
          onClick={() => store.setSort('capture-time')}
        >
          Time
        </button>
      </div>

      <span className={styles.visibleCount}>{visibleCount} shown</span>
    </div>
  );
}
