import type { SourceConfig } from '@ee/contracts';
import { useId, useMemo, useState } from 'react';
import { sourcesToIngest } from '../cards';
import { ingestPreview } from '../ingest-preview';
import { ingestLabel, photoCount, reportedCount, sourceKinds, totalCount } from '../ingest-summary';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { useAppState, useAppStore } from '../store-context';
import { useIngestSettings } from '../use-ingest-settings';
import { ActionBar, barStyles } from './ActionBar';
import { IngestFrom } from './IngestFrom';
import { IngestTo } from './IngestTo';
import { Button } from './ui/Button';
import { PanelResizeHandle } from './ui/PanelResizeHandle';
import styles from './IngestView.module.css';

const PANELS = [
  { id: 'ingest-sources', side: 'left' },
] as const satisfies readonly ResizablePanelDefinition[];

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Ingest, as one sentence read left to right: copy these sources (From) to that folder (To), then
 * the bar with the one action. The settings save themselves; the button flushes them first.
 */
export function IngestView() {
  const store = useAppStore();
  const state = useAppState();
  const settings = useIngestSettings();
  const { containerRef, panels } = usePanelLayout(PANELS);
  const sourcesPanel = panels['ingest-sources'];
  const [starting, setStarting] = useState(false);
  const reasonId = useId();

  // What an ingest would copy: unticked cards and folders are left out.
  const toRun = sourcesToIngest(state.sources, state.pickedCards, state.unpickedSources);
  const activeRuns = Object.values(state.ingest).filter(
    (run) => run.state === 'running' || run.state === 'watching',
  );
  const activeIds = new Set(activeRuns.map((run) => run.sourceId as string));
  const remaining = toRun.filter((source) => !activeIds.has(source.id));
  const stoppingAll =
    activeRuns.length > 0 && activeRuns.every((run) => state.ingestStopping[run.sourceId]);
  const countOf = (sources: readonly SourceConfig[]): number | undefined =>
    totalCount(sources.map((source) => reportedCount(source, state.cards, state.sources)));

  const preview = useMemo(
    () => ingestPreview(settings.form, toRun[0], new Date()),
    // `toRun[0]` is rebuilt every render; its identity is what the source is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.form, toRun[0]?.id, toRun[0]?.name],
  );

  const reason =
    toRun.length === 0
      ? 'Nothing to ingest. Tick a card, folder or server.'
      : !settings.settings
        ? Object.values(settings.errors)[0]
        : undefined;
  const target = preview.ok ? preview.directory : settings.form.destination.trim();
  const count = toRun.length > 0 ? countOf(toRun) : undefined;

  const start = async (only?: ReadonlySet<string>): Promise<void> => {
    setStarting(true);
    try {
      const saved = await settings.flush();
      if (!saved.ok) {
        store.notify(
          'error',
          saved.reason === 'failed'
            ? `Could not save the ingest settings, so nothing was started: ${saved.message}`
            : saved.message,
        );
        return;
      }
      await store.startIngest(saved.settings, only);
    } catch (cause) {
      store.notify('error', `Could not start the ingest: ${messageOf(cause)}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className={styles.view}
      data-testid="ingest-view"
      style={{ '--from-width': `${sourcesPanel.width}px` } as React.CSSProperties}
    >
      <IngestFrom className={styles.from} />
      <PanelResizeHandle
        panel="ingest-sources"
        label="Ingest sources"
        side="left"
        controller={sourcesPanel}
        className={styles.sourcesHandle}
      />
      <IngestTo className={styles.to} settings={settings} preview={preview} />
      <div className={styles.bar}>
        <ActionBar
          testId="ingest-bar"
          left={
            <span className={barStyles.summary} id={reasonId} data-testid="ingest-summary">
              {reason ??
                [sourceKinds(toRun), count === undefined ? '' : photoCount(count)]
                  .filter(Boolean)
                  .join(' · ') + (target ? ` → ${target}` : '')}
            </span>
          }
          right={
            activeRuns.length > 0 ? (
              <>
                {remaining.length > 0 && (
                  <Button
                    disabled={starting || reason !== undefined}
                    title={reason ?? `Start the ${remaining.length} source(s) that are not running`}
                    onClick={() => void start(new Set(remaining.map((source) => source.id)))}
                  >
                    {ingestLabel(countOf(remaining))}
                  </Button>
                )}
                <Button
                  variant="primary"
                  aria-label="Stop all ingests"
                  title="Stop every running and watching source"
                  disabled={stoppingAll}
                  onClick={() => void store.stopIngest()}
                >
                  {stoppingAll ? 'Stopping…' : 'Stop all'}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={starting || reason !== undefined}
                title={reason}
                aria-describedby={reason ? reasonId : undefined}
                onClick={() => void start()}
              >
                {ingestLabel(count)}
              </Button>
            )
          }
        />
      </div>
    </div>
  );
}
