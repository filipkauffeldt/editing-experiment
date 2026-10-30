import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExifToolService } from '../src/exiftool';
import { readPhotoLabels, writePhotoLabels } from '../src/labels';
import {
  cleanupTempDirs,
  copyFixture,
  fixtureAvailable,
  makeJpeg,
  makeTempDir,
  sha256File,
} from './helpers';

const PHOTOMECHANIC_NS = 'http://ns.camerabits.com/photomechanic/1.0/';
const XMP_NS = 'http://ns.adobe.com/xap/1.0/';

/** A minimal XMP packet with only the properties PM would put in it. */
function xmpPacket(properties: string): string {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:photomechanic="${PHOTOMECHANIC_NS}"
   xmlns:xmp="${XMP_NS}">
   ${properties}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

async function writeXmp(path: string, properties: string): Promise<void> {
  await writeFile(path, xmpPacket(properties), 'utf8');
}

function prefsValue(value: string): string {
  return `<photomechanic:Prefs>${value}</photomechanic:Prefs>`;
}

describe('Photo Mechanic labels', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  it('writes tag, colour class, combined Prefs and label to a raw sidecar', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    const originalBytes = Buffer.from('pretend this is a NEF');
    await writeFile(raw, originalBytes);
    const before = await sha256File(raw);

    await writePhotoLabels(raw, { tagged: true, colorClass: 3, rating: 0 }, { service });

    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: true,
      colorClass: 3,
      rating: 0,
    });
    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-photomech:Tagged'])).toMatch(/yes|true/i);
    expect(String(tags['XMP-photomech:ColorClass'])).toMatch(/^3\b/);
    expect(String(tags['XMP-xmp:Label'])).toBe('Superior');
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:1, ColorClass:3, Rating:0, FrameNum:0',
    );

    // The raw itself is never written, even though it is the path we passed.
    expect(await sha256File(raw)).toBe(before);
  });

  it.skipIf(!fixtureAvailable('z30_14bit.NEF'))(
    'never touches a real NEF when writing labels',
    async () => {
      const dir = await makeTempDir();
      const raw = await copyFixture('z30_14bit.NEF', dir);
      const before = await sha256File(raw);

      await writePhotoLabels(raw, { tagged: true, colorClass: 3, rating: 0 }, { service });

      expect(await sha256File(raw)).toBe(before);
      expect(await readPhotoLabels(raw, { service })).toEqual({
        tagged: true,
        colorClass: 3,
        rating: 0,
      });
    },
  );

  it('embeds labels in a JPEG', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writePhotoLabels(jpeg, { tagged: true, colorClass: 7, rating: 0 }, { service });
    expect(await readPhotoLabels(jpeg, { service })).toEqual({
      tagged: true,
      colorClass: 7,
      rating: 0,
    });

    const tags = await service.read(jpeg);
    expect(String(tags['XMP-photomech:ColorClass'])).toMatch(/^7\b/);
    expect(String(tags['XMP-xmp:Label'])).toBe('Extras');
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:1, ColorClass:7, Rating:0, FrameNum:0',
    );
  });

  it('preserves the rating and frame number of an existing Prefs value', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeFile(raw, 'raw bytes');
    await writeXmp(join(dir, 'photo.xmp'), prefsValue('0:3:4:1234'));

    await writePhotoLabels(raw, { tagged: true, colorClass: 5 }, { service });

    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:1, ColorClass:5, Rating:4, FrameNum:1234',
    );
  });

  it('takes the rating from xmp:Rating and frame 0 when there is no Prefs yet', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeFile(raw, 'raw bytes');
    await writeXmp(join(dir, 'photo.xmp'), '<xmp:Rating>5</xmp:Rating>');

    await writePhotoLabels(raw, { colorClass: 2 }, { service });

    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:0, ColorClass:2, Rating:5, FrameNum:0',
    );
  });

  it('round-trips a rating through a raw sidecar and keeps Prefs and xmp:Rating in sync', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    const originalBytes = Buffer.from('pretend this is a NEF');
    await writeFile(raw, originalBytes);
    const before = await sha256File(raw);
    await writeXmp(join(dir, 'photo.xmp'), prefsValue('0:3:4:1234'));

    await writePhotoLabels(raw, { rating: 2 }, { service });

    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:0, ColorClass:3, Rating:2, FrameNum:1234',
    );
    expect(String(tags['XMP-xmp:Rating'])).toBe('2');
    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: false,
      colorClass: 3,
      rating: 2,
    });
    expect(await sha256File(raw)).toBe(before);
  });

  it('round-trips a rating in a JPEG and removes xmp:Rating when it is cleared', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writePhotoLabels(jpeg, { rating: 5 }, { service });
    expect(await readPhotoLabels(jpeg, { service })).toEqual({
      tagged: false,
      colorClass: 0,
      rating: 5,
    });
    let tags = await service.read(jpeg);
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:0, ColorClass:0, Rating:5, FrameNum:0',
    );
    expect(String(tags['XMP-xmp:Rating'])).toBe('5');

    await writePhotoLabels(jpeg, { rating: 0 }, { service });
    expect(await readPhotoLabels(jpeg, { service })).toEqual({
      tagged: false,
      colorClass: 0,
      rating: 0,
    });
    tags = await service.read(jpeg);
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:0, ColorClass:0, Rating:0, FrameNum:0',
    );
    expect(tags['XMP-xmp:Rating']).toBeUndefined();
  });

  it('mirrors an existing Prefs rating to xmp:Rating when another label is written', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeFile(raw, 'raw bytes');
    await writeXmp(join(dir, 'photo.xmp'), `${prefsValue('0:3:4:1234')}<xmp:Rating>5</xmp:Rating>`);

    await writePhotoLabels(raw, { colorClass: 2 }, { service });

    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-photomech:Prefs'])).toBe(
      'Tagged:0, ColorClass:2, Rating:4, FrameNum:1234',
    );
    expect(String(tags['XMP-xmp:Rating'])).toBe('4');
    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: false,
      colorClass: 2,
      rating: 4,
    });
  });

  it('reads a sidecar written the way PM writes it, with only Prefs', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeXmp(join(dir, 'photo.xmp'), prefsValue('0:3:4:1234'));

    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: false,
      colorClass: 3,
      rating: 4,
    });
  });

  it('prefers the Prefs rating over xmp:Rating', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeXmp(join(dir, 'photo.xmp'), `${prefsValue('0:0:2:7')}<xmp:Rating>5</xmp:Rating>`);

    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: false,
      colorClass: 0,
      rating: 2,
    });
  });

  it('prefers Prefs over the separate Tagged and ColorClass properties', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeXmp(
      join(dir, 'photo.xmp'),
      `${prefsValue('0:3:4:1234')}<photomechanic:Tagged>True</photomechanic:Tagged><photomechanic:ColorClass>7</photomechanic:ColorClass>`,
    );

    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: false,
      colorClass: 3,
      rating: 4,
    });
  });

  it('maps xmp:Label back to a colour class when nothing else is present', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeXmp(join(dir, 'photo.xmp'), '<xmp:Label>Extras</xmp:Label>');

    expect(await readPhotoLabels(raw, { service })).toEqual({
      tagged: false,
      colorClass: 7,
      rating: 0,
    });
  });

  it('uses an overridable colour class name table for reading and writing', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeFile(raw, 'raw bytes');
    await writeXmp(join(dir, 'photo.xmp'), '<xmp:Label>Hero</xmp:Label>');
    const colorClassNames = ['', 'Pick', 'Hero', 'Superior', 'Superior alt'];

    expect(await readPhotoLabels(raw, { service, colorClassNames })).toEqual({
      tagged: false,
      colorClass: 2,
      rating: 0,
    });

    await writePhotoLabels(raw, { colorClass: 1 }, { service, colorClassNames });
    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-xmp:Label'])).toBe('Pick');
  });

  it('leaves xmp:Label alone when syncLabel is false', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeFile(raw, 'raw bytes');
    await writeXmp(join(dir, 'photo.xmp'), '<xmp:Label>Client pick</xmp:Label>');

    await writePhotoLabels(raw, { colorClass: 3 }, { service, syncLabel: false });

    const tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-xmp:Label'])).toBe('Client pick');
  });

  it('clears the label with the colour class only when it is one of our names', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'photo.NEF');
    await writeFile(raw, 'raw bytes');

    await writeXmp(
      join(dir, 'photo.xmp'),
      `${prefsValue('0:3:4:0')}<xmp:Label>Superior</xmp:Label>`,
    );
    await writePhotoLabels(raw, { colorClass: 0 }, { service });
    let tags = await service.read(join(dir, 'photo.xmp'));
    expect(tags['XMP-xmp:Label']).toBeUndefined();

    await writeXmp(
      join(dir, 'photo.xmp'),
      `${prefsValue('0:3:4:0')}<xmp:Label>Client pick</xmp:Label>`,
    );
    await writePhotoLabels(raw, { colorClass: 0 }, { service });
    tags = await service.read(join(dir, 'photo.xmp'));
    expect(String(tags['XMP-xmp:Label'])).toBe('Client pick');
  });

  it('rejects a colour class outside 0..8', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await expect(writePhotoLabels(jpeg, { colorClass: 9 }, { service })).rejects.toThrow(
      /colorClass/,
    );
  });

  it('rejects a rating outside 0..5', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await expect(writePhotoLabels(jpeg, { rating: 6 }, { service })).rejects.toThrow(/rating/);
  });
});
