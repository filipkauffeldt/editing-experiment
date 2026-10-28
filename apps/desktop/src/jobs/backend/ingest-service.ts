import {
  IpcError,
  type IngestConfig,
  type IngestJobInfo,
  type JobEvent,
  type SourceId,
} from '@ee/contracts';
import {
  startIngest,
  type GetSecret,
  type IngestHandle,
  type OnFileIngested,
  type SeenStore,
} from '@ee/ingest';
import { expandIngestTemplate } from './ingest-template';

export interface IngestServiceDeps {
  seenStore: SeenStore;
  getSecret: GetSecret;
  /** Builds the per-file hook for a run (it depends on the run's template settings). */
  onFileIngested(config: IngestConfig): OnFileIngested;
  onEvent(event: JobEvent): void;
}

/** Runs `@ee/ingest` and keeps the last known state of every source. */
export class IngestService {
  private readonly runs = new Set<IngestHandle>();
  private readonly finished = new Map<SourceId, IngestJobInfo>();

  constructor(private readonly deps: IngestServiceDeps) {}

  async start(config: IngestConfig): Promise<IngestJobInfo[]> {
    if (
      !Array.isArray(config?.sources) ||
      typeof config.renameTemplate !== 'string' ||
      typeof config.destination?.path !== 'string'
    ) {
      throw new IpcError(
        'invalid_argument',
        'ingest config needs sources, renameTemplate and destination.path',
      );
    }
    // Starting a source that is still running replaces its run.
    for (const source of config.sources) await this.stop(source.id);
    if (config.sources.length === 0) return [];

    const handle = startIngest(config, {
      expandTemplate: expandIngestTemplate,
      onFileIngested: this.deps.onFileIngested(config),
      getSecret: this.deps.getSecret,
      seenStore: this.deps.seenStore,
    });
    this.runs.add(handle);
    handle.on(this.deps.onEvent);
    void handle.done.then(() => {
      for (const info of handle.status()) this.finished.set(info.sourceId, info);
      this.runs.delete(handle);
    });
    for (const source of config.sources) this.finished.delete(source.id);
    return handle.status();
  }

  async stop(sourceId?: SourceId): Promise<void> {
    await Promise.all([...this.runs].map((run) => run.stop(sourceId)));
  }

  status(): IngestJobInfo[] {
    // Later runs replace earlier ones for the same source.
    const bySource = new Map(this.finished);
    for (const run of this.runs) {
      for (const info of run.status()) bySource.set(info.sourceId, info);
    }
    return [...bySource.values()];
  }

  /** Stop everything and wait until the runs have wound down. */
  async dispose(): Promise<void> {
    await this.stop();
  }
}
