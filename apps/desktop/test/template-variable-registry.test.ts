// @vitest-environment node
import { asSourceId } from '@ee/contracts';
import { createTemplateContext, type TemplateContext } from '@ee/ingest';
import {
  expandVariables,
  listedInContext,
  TEMPLATE_VARIABLES,
  templateVariablesFor,
  unknownTemplateVariables,
  type CaptionContext,
  type TemplateVariableContext,
} from '@ee/metadata/variables';
import { describe, expect, it } from 'vitest';
import { expandIngestTemplate } from '../src/shared/ingest-template';
import { resolveExportFileName } from '../src/jobs/backend/export-service';
import { defaultExportPreset } from '../src/shared/settings';

const CONTEXTS: readonly TemplateVariableContext[] = [
  'export',
  'exportFolder',
  'ingest',
  'destination',
];

const fields = {
  headline: 'FCB 2–1 Sevilla',
  caption: 'Lewandowski scores the winner',
  keywords: ['football', 'la liga'],
  byline: 'Ada Lind',
  bylineTitle: 'Staff photographer',
  credit: 'Sportfotografen',
  source: 'Sportfotografen',
  copyright: '© Ada Lind',
  city: 'Barcelona',
  state: 'Catalonia',
  country: 'Spain',
  countryCode: 'ES',
  location: 'Spotify Camp Nou',
  event: 'La Liga matchday 8',
  objectName: 'FCB-SEV-001',
  jobId: 'JOB-2026-042',
  instructions: 'Credit required',
  captionWriter: 'Ada Lind',
  dateCreated: '2026-10-27T20:15:04+01:00',
};

const camera = {
  make: 'NIKON CORPORATION',
  model: 'NIKON Z 9',
  serialNumber: '6012345',
};

const captureTime = '2026-10-27T20:15:04.123+01:00';

/** What ExportService gives the folder and file name templates, minus sequence. */
const exportContext: CaptionContext = {
  filePath: '/photos/card/2026-10-27_FCB_001.NEF',
  photoFolder: '/photos/card',
  fileName: '2026-10-27_FCB_001.NEF',
  fileNameBase: '2026-10-27_FCB_001',
  captureTime,
  now: new Date(2026, 9, 27, 22, 10, 0),
  camera,
  fields,
};

/** What the upload queue gives the destination remote path template. */
const destinationContext: CaptionContext = {
  fileName: '2026-10-27_FCB_001.jpg',
  fileNameBase: '2026-10-27_FCB_001',
  captureTime,
  now: new Date(2026, 9, 27, 22, 10, 0),
  camera,
  fields,
};

/** What the ingest engine gives the rename and subfolder templates. */
const ingestContext: TemplateContext = createTemplateContext({
  sourceId: asSourceId('card-a'),
  sourceName: 'Card A',
  sourcePath: '/card/DCIM/2026-10-27_FCB_001.NEF',
  fileName: '2026-10-27_FCB_001.NEF',
  seq: 7,
  mtimeMs: new Date(2026, 9, 27, 20, 15, 4, 123).getTime(),
  now: new Date(2026, 9, 27, 22, 10, 0),
});

function expand(context: TemplateVariableContext, template: string): string {
  if (context === 'ingest') return expandIngestTemplate(template, ingestContext);
  if (context === 'destination') return expandVariables(template, destinationContext).text;
  // The folder and file name templates share one expander; only what is listed differs.
  // Export replaces {preset} before the shared expander sees the template.
  return expandVariables(template.replaceAll('{preset}', 'Desk 2048'), exportContext).text;
}

/** Expanded means the token became a value; empty and verbatim do not count. */
function expands(context: TemplateVariableContext, template: string): boolean {
  const result = expand(context, template);
  return result !== template && result !== '';
}

describe('template variable registry', () => {
  it('lists exactly the variables each template path expands', () => {
    for (const context of CONTEXTS) {
      for (const variable of TEMPLATE_VARIABLES) {
        const listed = listedInContext(variable.contexts, context);
        // A variable for the folder template alone is expanded by the shared expander in the
        // file name template too, but that template refuses it (see the test below), so the
        // two-way check is made where it is listed.
        if (context === 'export' && variable.contexts.every((c) => c === 'exportFolder')) continue;
        const token = `{${variable.name}}`;
        expect(expands(context, token), `${context} {${variable.name}} listed=${listed}`).toBe(
          listed,
        );
        for (const alias of variable.aliases) {
          expect(expands(context, `{${alias}}`), `${context} {${alias}} listed=${listed}`).toBe(
            listed,
          );
        }
        for (const format of variable.formats) {
          const formatListed = listedInContext(format.contexts, context);
          expect(expands(context, format.template), `${context} ${format.template}`).toBe(
            formatListed,
          );
        }
      }
    }
  });

  it('keeps a folder-only variable out of the file name template, which refuses it', () => {
    const folderOnly = TEMPLATE_VARIABLES.filter((variable) =>
      variable.contexts.every((context) => context === 'exportFolder'),
    );
    expect(folderOnly.map((variable) => variable.name)).toEqual(['photofolder']);
    for (const variable of folderOnly) {
      const token = `{${variable.name}}`;
      expect(templateVariablesFor('exportFolder')).toContain(variable);
      expect(templateVariablesFor('export')).not.toContain(variable);
      expect(unknownTemplateVariables(token, 'exportFolder')).toEqual([]);
      expect(unknownTemplateVariables(token, 'export')).toEqual([variable.name]);
      expect(() =>
        resolveExportFileName({ ...defaultExportPreset(), fileNameTemplate: token }, exportContext),
      ).toThrowError(/file name/i);
    }
  });

  it('offers everything the file name template does in the folder template, plus {photofolder}', () => {
    const fileNames = templateVariablesFor('export').map((variable) => variable.name);
    const folders = templateVariablesFor('exportFolder').map((variable) => variable.name);
    expect(folders).toEqual(expect.arrayContaining(fileNames));
    expect(folders).toContain('photofolder');
    expect(folders).toContain('preset');
    for (const context of ['ingest', 'destination'] as const) {
      expect(templateVariablesFor(context).map((variable) => variable.name)).not.toContain(
        'photofolder',
      );
    }
    const photofolder = TEMPLATE_VARIABLES.find((variable) => variable.name === 'photofolder');
    expect(photofolder?.example).toBe('/Photos/20261104_GAIS-AIK');
    expect(photofolder?.description).toMatch(/start of the folder template/);
    expect(unknownTemplateVariables('{photofolder}/export/{preset}', 'exportFolder')).toEqual([]);
  });

  it('offers only entries that work in the field', () => {
    expect(templateVariablesFor('export').map((variable) => variable.name)).toEqual(
      expect.arrayContaining(['folder', 'filename', 'preset']),
    );
    expect(templateVariablesFor('export').map((variable) => variable.name)).not.toContain(
      'sequence',
    );
    expect(templateVariablesFor('ingest').map((variable) => variable.name)).toEqual(
      expect.arrayContaining(['sequence', 'sourceName', 'ext']),
    );
    expect(templateVariablesFor('ingest').map((variable) => variable.name)).not.toContain('preset');
    expect(templateVariablesFor('ingest').map((variable) => variable.name)).not.toContain('model');
    expect(templateVariablesFor('destination').map((variable) => variable.name)).not.toContain(
      'folder',
    );
  });

  it('reports an unknown variable from the same entries without changing expansion', () => {
    expect(unknownTemplateVariables('{folder}/{preset}', 'export')).toEqual([]);
    expect(unknownTemplateVariables('{folder}/{seq:4}/{bogus}', 'export')).toEqual([
      'seq:4',
      'bogus',
    ]);
    expect(unknownTemplateVariables('{seq:4}/{sourceName}/{date:YYYY-MM-DD}', 'ingest')).toEqual(
      [],
    );
    expect(unknownTemplateVariables('{preset}/{model}/{bogus}', 'ingest')).toEqual([
      'preset',
      'model',
      'bogus',
    ]);
    expect(unknownTemplateVariables('{fileName}/{event}/{date}', 'destination')).toEqual([]);
    expect(unknownTemplateVariables('{folder}/{preset}/{Bogus}', 'destination')).toEqual([
      'folder',
      'preset',
      'Bogus',
    ]);
    // The reporting does not alter what expansion does.
    expect(expandVariables('{bogus}', exportContext)).toMatchObject({
      text: '{bogus}',
      unknownVariables: ['bogus'],
    });
  });

  it('has a description, an example and a context for every entry', () => {
    const names = new Set<string>();
    for (const variable of TEMPLATE_VARIABLES) {
      expect(variable.name, variable.description).not.toBe('');
      expect(variable.description, variable.name).not.toBe('');
      expect(variable.example, variable.name).not.toBe('');
      expect(variable.contexts.length, variable.name).toBeGreaterThan(0);
      for (const name of [variable.name, ...variable.aliases]) {
        expect(names.has(name), name).toBe(false);
        names.add(name);
      }
      for (const format of variable.formats) {
        expect(format.template, variable.name).toMatch(/^\{.+\}$/);
        expect(format.description, variable.name).not.toBe('');
        expect(format.example, variable.name).not.toBe('');
        expect(format.contexts.length, variable.name).toBeGreaterThan(0);
      }
    }
  });
});
