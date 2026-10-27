import { describe, expect, it } from 'vitest';
import type { IptcFields } from '@ee/contracts';
import { expandVariables, VARIABLE_NAMES, type CaptionContext } from '../src/variables';

const iptc: IptcFields = {
  headline: 'H',
  caption: 'C',
  keywords: ['k1', 'k2'],
  byline: 'Ada',
  bylineTitle: 'Staff',
  credit: 'Cr',
  source: 'Src',
  copyright: '©',
  city: 'Göteborg',
  state: 'VG',
  country: 'Sweden',
  countryCode: 'SE',
  location: 'Gamla Ullevi',
  event: 'Event',
  objectName: 'Obj',
  jobId: 'J-1',
  instructions: 'Inst',
  captionWriter: 'CW',
  dateCreated: '2024-05-06T19:08:09+02:00',
};

const context: CaptionContext = {
  filePath: '/photos/day1/ABC123.NEF',
  captureTime: '2024-05-06T19:08:09',
  now: new Date(2024, 0, 2, 3, 4, 5),
  camera: { make: 'NIKON CORPORATION', model: 'NIKON Z 6', serialNumber: '6001234' },
  fields: iptc,
  sequence: 7,
};

describe('Photo Mechanic variables', () => {
  it('expands every variable in the table without leaving braces', () => {
    expect(VARIABLE_NAMES.length).toBeGreaterThan(50);
    for (const name of VARIABLE_NAMES) {
      const result = expandVariables(`{${name}}`, context);
      expect(result.unknownVariables, name).toEqual([]);
      expect(result.text, name).not.toMatch(/[{}]/);
    }
  });

  it.each([
    ['filename', 'ABC123.NEF'],
    ['file', 'ABC123.NEF'],
    ['filenamebase', 'ABC123'],
    ['fbas', 'ABC123'],
    ['folder', 'day1'],
    ['fldr', 'day1'],
    ['folderpath', '/photos/day1'],
    ['path', '/photos/day1/ABC123.NEF'],
    ['date', '2024-05-06'],
    ['time', '19:08:09'],
    ['year4', '2024'],
    ['year2', '24'],
    ['month', '5'],
    ['month0', '05'],
    ['day', '6'],
    ['day0', '06'],
    ['hour', '7'],
    ['hour0', '07'],
    ['hour24', '19'],
    ['minute', '08'],
    ['second', '09'],
    ['ampm', 'PM'],
    ['dow', 'Monday'],
    ['dow3', 'Mon'],
    ['monthname', 'May'],
    ['monthname3', 'May'],
    ['monthnameap', 'May.'],
    ['datesort', '20240506'],
    ['datesortdash', '2024-05-06'],
    ['timesort', '190809'],
    ['timesortdash', '19-08-09'],
    ['datemil', '06MAY24'],
    ['now', '2024-01-02 03:04:05'],
    ['today', '2024-01-02'],
    ['make', 'NIKON CORPORATION'],
    ['model', 'NIKON Z 6'],
    ['camera', 'NIKON Z 6'],
    ['serial', '6001234'],
    ['sequence', '7'],
    ['seqn', '7'],
    ['auto', '7'],
    ['seq:4', '0007'],
    ['seq:1', '7'],
    ['iptcdate', '20240506'],
    ['iptctime', '190809'],
    ['nl', '\n'],
    ['tab', '\t'],
  ])('{ %s } → %j', (name, expected) => {
    expect(expandVariables(`{${name}}`, context).text).toBe(expected);
  });

  it.each([
    ['caption', 'C'],
    ['headline', 'H'],
    ['keywords', 'k1, k2'],
    ['byline', 'Ada'],
    ['title', 'Staff'],
    ['credit', 'Cr'],
    ['source', 'Src'],
    ['copyright', '©'],
    ['city', 'Göteborg'],
    ['state', 'VG'],
    ['country', 'Sweden'],
    ['countrycode', 'SE'],
    ['location', 'Gamla Ullevi'],
    ['event', 'Event'],
    ['object', 'Obj'],
    ['iptctitle', 'Obj'],
    ['transref', 'J-1'],
    ['instructions', 'Inst'],
    ['captionwriter', 'CW'],
  ])('IPTC variable {%s} → %j', (name, expected) => {
    expect(expandVariables(`{${name}}`, context).text).toBe(expected);
  });

  it('accepts EXIF-style capture times from ExifTool', () => {
    expect(expandVariables('{date} {time}', { captureTime: '2024:05:06 19:08:09' }).text).toBe(
      '2024-05-06 19:08:09',
    );
  });

  it('uses the wall-clock components of a capture time with an offset', () => {
    expect(
      expandVariables('{date} {time} {hour24}', {
        captureTime: '2024-05-06T19:08:09-05:00',
      }).text,
    ).toBe('2024-05-06 19:08:09 19');
  });

  it('falls back to file modified time, then now', () => {
    expect(
      expandVariables('{year4}', {
        fileModifiedTime: '2023-11-12T01:02:03',
        now: new Date(2024, 0, 2),
      }).text,
    ).toBe('2023');
    expect(expandVariables('{year4}', { now: new Date(2024, 0, 2) }).text).toBe('2024');
  });

  it('leaves unknown variables verbatim and reports them', () => {
    const result = expandVariables('{nope} {also-nope} {city}', {});
    expect(result.text).toBe('{nope} {also-nope} ');
    expect(result.unknownVariables).toEqual(['nope', 'also-nope']);
  });

  it('reports sequence variables when no sequence is available', () => {
    const result = expandVariables('{seq:4} {seqn}', {});
    expect(result.text).toBe('{seq:4} {seqn}');
    expect(result.unknownVariables).toEqual(['seq:4', 'seqn']);
  });
});
