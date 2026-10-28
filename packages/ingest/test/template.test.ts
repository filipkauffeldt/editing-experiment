import { asSourceId } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { createTemplateContext, defaultExpandTemplate } from '../src/template';

const context = createTemplateContext({
  sourceId: asSourceId('source'),
  sourceName: 'Card A',
  sourcePath: '/card/DCIM/_DSC9.NEF',
  fileName: '_DSC9.NEF',
  seq: 7,
  mtimeMs: new Date(2026, 9, 27, 12, 0, 0).getTime(),
  now: new Date(2026, 9, 27),
});

describe('defaultExpandTemplate', () => {
  it('expands the tokens ingest tests rely on', () => {
    expect(defaultExpandTemplate('{filenamebase}_{seq:4}_{date}', context)).toBe(
      '_DSC9_0007_2026-10-27',
    );
  });

  it('leaves unknown tokens for the metadata implementation', () => {
    expect(defaultExpandTemplate('{event}-{filenamebase}', context)).toBe('{event}-_DSC9');
  });
});
