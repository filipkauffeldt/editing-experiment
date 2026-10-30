import {
  asDestinationId,
  asPhotoId,
  asPresetId,
  asSourceId,
  asUploadId,
  asVersionId,
  type AppSettings,
  type Destination,
  type EditParams,
  type EditPreset,
  type ExportPreset,
  type IptcFields,
  type Photo,
  type PhotoId,
  type SourceConfig,
  type UploadItem,
  type UploadItemState,
} from '@ee/contracts';

/**
 * Deterministic mock data for `EE_MOCK=1`. Everything here is generated in
 * memory: no file on disk is touched, so screenshots and component tests can
 * run without a camera card or a server.
 */

/** Aspect ratio of every generated image (3:2, like a full-frame camera). */
const MOCK_WIDTH = 3;
const MOCK_HEIGHT = 2;

const SOURCE_A = asSourceId('mock-z9-card');
const SOURCE_B = asSourceId('mock-z8-ftp');
const DEST_OUTBOX = asDestinationId('mock-dest-outbox');
const DEST_DESK = asDestinationId('mock-dest-desk');

/** Photo Mechanic template used by the mock ingest settings. */
export const MOCK_TEMPLATE_PATH = '/mock/templates/premier-league.XMP';
/** Tab-delimited code replacement file configured for the mock ingest. */
export const MOCK_CODE_REPLACEMENT_PATH = '/mock/code-replacements.txt';

const PHOTOS_PER_SOURCE = 20;

/** Two simulated sources: a card and a remote FTP drop. */
export function mockSources(): SourceConfig[] {
  return [
    {
      id: SOURCE_A,
      kind: 'folder',
      name: 'Card A — Z 9',
      path: '/mock/cards/NIKON_Z9',
      recursive: true,
    },
    {
      id: SOURCE_B,
      kind: 'ftp',
      name: 'Pool FTP — Z 8',
      host: 'ftp.sportfotografen.se',
      port: 21,
      username: 'photographer',
      credentialRef: 'mock-credential-pool',
      remotePath: '/incoming/2026-10-24',
      pollIntervalMs: 5000,
      deleteAfterDownload: false,
      security: 'none',
    },
  ];
}

/** Export destinations used by the mock presets and the upload queue. */
export function mockDestinations(): Destination[] {
  return [
    {
      id: DEST_OUTBOX,
      kind: 'folder',
      name: 'Sportfotografen outbox',
      path: '/mock/exports/outbox',
      remotePathTemplate: '{date}/{fileName}',
    },
    {
      id: DEST_DESK,
      kind: 'ftp',
      name: 'Sportfotografen FTP',
      host: 'ftp.sportfotografen.se',
      port: 21,
      username: 'ftpuser',
      credentialRef: 'mock-credential-desk',
      remotePathTemplate: '/incoming/{event}/{fileName}',
      security: 'explicit-tls',
    },
  ];
}

/** Export presets shown by the mock export dialog. */
export function mockExportPresets(): ExportPreset[] {
  return [
    {
      id: asPresetId('mock-export-preset'),
      name: 'Sportfotografen',
      folderTemplate: '{folder}/Export/{preset}',
      fileNameTemplate: '{filenamebase}',
      ifExists: 'suffix',
      format: 'jpeg',
      quality: 90,
      colorSpace: 'srgb',
      resize: { mode: 'none' },
      outputSharpening: { target: 'none', amount: 'standard' },
      metadata: 'all',
      stripGps: false,
      version: 'top',
      sendTo: [DEST_OUTBOX, DEST_DESK],
    },
    {
      id: asPresetId('mock-export-preset-web'),
      name: 'Web',
      folderTemplate: '{folder}/Export/{preset}',
      fileNameTemplate: '{filenamebase}',
      ifExists: 'suffix',
      format: 'jpeg',
      quality: 82,
      colorSpace: 'srgb',
      resize: { mode: 'longEdge', pixels: 2400 },
      outputSharpening: { target: 'screen', amount: 'standard' },
      metadata: 'iptc',
      stripGps: true,
      version: 'top',
      sendTo: [DEST_OUTBOX],
    },
  ];
}

/** Persisted settings used in mock mode. */
export function mockSettings(): AppSettings {
  return {
    ingest: {
      destination: { path: '/mock/ingested', subfolderTemplate: '{date}/{sourceName}' },
      backupDestination: { path: '/mock/backup' },
      renameTemplate: '{date}_{event}_{seq:4}',
      metadataTemplatePath: MOCK_TEMPLATE_PATH,
      metadataTemplateMode: 'replace',
      codeReplacementPaths: [MOCK_CODE_REPLACEMENT_PATH],
    },
    exportRoot: '/mock/exports',
    exportPresets: mockExportPresets(),
    activePresetId: asPresetId('mock-export-preset'),
  };
}

const EDITED = new Set([3, 7, 12, 18, 23, 31, 35]);
const RETOUCHED = new Set([3, 12, 31]);

/** Upload state shown as a badge for the n-th (1-based) photo. */
function uploadStateFor(n: number): Exclude<UploadItemState, 'cancelled'> | undefined {
  if (n === 1 || n === 8) return 'done';
  if (n === 2 || n === 9) return 'queued';
  if (n === 3) return 'uploading';
  if (n === 4) return 'failed';
  return undefined;
}

/** A fixed set of 40 placeholder photos; deterministic so screenshots are stable. */
export function mockPhotos(): Photo[] {
  return Array.from({ length: PHOTOS_PER_SOURCE * 2 }, (_, index): Photo => {
    const n = index + 1;
    const fromCard = index < PHOTOS_PER_SOURCE;
    const sourceIndex = fromCard ? index : index - PHOTOS_PER_SOURCE;
    const seq = fromCard ? 8330 + sourceIndex : 9200 + sourceIndex;
    const fileName = `_DSC${seq}.NEF`;
    // Photos live in the local ingest copies; the card and the FTP drop are never opened.
    // The folders read like a real sports photographer's Pictures tree in the Library.
    const folder = fromCard ? '10-03 IFK–AIK' : '10-03 AIK–IFK';
    const path = `/home/alex/Pictures/2026/${folder}/${fileName}`;
    const hour = fromCard ? 14 : 15;
    const minute = fromCard ? 10 + sourceIndex : 5 + sourceIndex;
    const id = mockPhotoId(n);
    const upload = uploadStateFor(n);
    const versions: Photo['versions'] = [
      {
        id: asVersionId(`mock-${n}-develop`),
        kind: 'develop',
        name: 'Master',
        ops: mockEditParams(n),
      },
    ];
    if (RETOUCHED.has(n)) {
      versions.push({
        id: asVersionId(`mock-${n}-retouch`),
        kind: 'retouch',
        name: 'Retouch',
        ops: [
          {
            type: 'mosaic',
            shapes: [{ type: 'rect', x: 0.62, y: 0.32, w: 0.1, h: 0.16 }],
            blockSizeRel: 0.012,
          },
        ],
      });
    }
    return {
      id,
      path,
      sidecarPath: path.replace(/\.NEF$/, '.xmp'),
      fileName,
      captureTime: `2026-10-24T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:07`,
      camera: fromCard
        ? {
            make: 'NIKON CORPORATION',
            model: 'NIKON Z 9',
            lens: 'NIKKOR Z 70-200mm f/2.8 VR S',
            serialNumber: '3001234',
            iso: 3200,
            focalLength: 135,
            aperture: 2.8,
            shutter: 1 / 1000,
          }
        : {
            make: 'NIKON CORPORATION',
            model: 'NIKON Z 8',
            lens: 'NIKKOR Z 24-70mm f/2.8 S',
            serialNumber: '6005678',
            iso: 1600,
            focalLength: 24,
            aperture: 2.8,
            shutter: 1 / 640,
          },
      width: 8256,
      height: 5504,
      sourceId: fromCard ? SOURCE_A : SOURCE_B,
      tagged: [4, 9, 22, 31].includes(n),
      colorClass: n === 2 ? 1 : n === 12 ? 4 : n === 23 ? 6 : 0,
      rating: n === 1 ? 5 : n === 2 ? 3 : n === 4 ? 4 : n === 12 ? 2 : n === 23 ? 5 : 0,
      status: {
        ingest: 'done',
        edited: EDITED.has(n),
        metadataDiffersFromTemplate: n === 5,
        export: upload === 'done' ? 'done' : 'none',
        upload: upload === 'failed' ? 'failed' : (upload ?? 'none'),
      },
      versions,
    };
  });
}

/** Id of the n-th (1-based) mock photo. */
export function mockPhotoId(n: number): PhotoId {
  return asPhotoId(`mock-${String(n).padStart(2, '0')}`);
}

/** Develop settings seeded on the mock edited photos. */
export function mockEditParams(n: number): EditParams {
  if (!EDITED.has(n)) return {};
  return {
    Exposure2012: n === 3 ? 0.45 : 0.2,
    Contrast2012: 18,
    Highlights2012: -22,
    Shadows2012: 16,
    Whites2012: n === 12 ? 8 : undefined,
    Vibrance: 12,
    Saturation: 4,
    Temperature: n === 3 ? 5200 : undefined,
    Tint: n === 12 ? 6 : undefined,
    crop: undefined,
  };
}

/** The Photo Mechanic metadata template that mock ingest applies. */
export function mockTemplate(): IptcFields {
  return {
    headline: 'Manchester City v Liverpool — Premier League',
    caption: '=t1= {event} at the {location}.',
    keywords: ['football', 'premier league', 'manchester city', 'liverpool'],
    byline: 'Alex Morgan',
    bylineTitle: 'Staff Photographer',
    credit: 'Sportfotografen',
    source: 'Sportfotografen',
    copyright: '© 2026 Sportfotografen',
    city: 'Manchester',
    state: 'England',
    country: 'United Kingdom',
    countryCode: 'GBR',
    location: 'Etihad Stadium',
    event: 'Manchester City v Liverpool',
    objectName: 'MCILIV_2026',
    jobId: 'NP-20261024-MCILIV',
    instructions: 'Editorial use only',
    captionWriter: 'AM',
    dateCreated: '2026-10-24',
  };
}

/** Metadata as it currently sits in the sidecar for the n-th mock photo. */
export function mockMetadata(n: number): IptcFields {
  const template = mockTemplate();
  if (n === 5) {
    return {
      ...template,
      caption: 'Liverpool warm up at Anfield before kick-off.',
      city: 'Liverpool',
      location: 'Anfield',
      keywords: ['football', 'liverpool', 'warm-up'],
    };
  }
  if (n === 7) {
    return { ...template, caption: `${template.caption} {photographer}` };
  }
  return template;
}

/** Presets offered by the mock develop service. */
export function mockPresets(): EditPreset[] {
  return [
    {
      id: asPresetId('mock-preset-press'),
      name: 'Press — Punchy',
      path: '/mock/presets/Press Punchy.xmp',
      params: {
        Exposure2012: 0.2,
        Contrast2012: 15,
        Highlights2012: -20,
        Shadows2012: 20,
        Whites2012: 5,
        Blacks2012: -5,
        Vibrance: 15,
        Saturation: 5,
      },
    },
    {
      id: asPresetId('mock-preset-daylight'),
      name: 'Daylight — Neutral',
      path: '/mock/presets/Daylight Neutral.xmp',
      params: { Temperature: 5500, Tint: 8, Contrast2012: 5 },
    },
    {
      id: asPresetId('mock-preset-bw'),
      name: 'Black & White — High Contrast',
      path: '/mock/presets/Black and White.xmp',
      params: { Saturation: -100, Contrast2012: 28, Whites2012: 12 },
    },
  ];
}

/** Upload queue entries matching the badges on the first mock photos. */
export function mockUploads(): UploadItem[] {
  const photos = mockPhotos();
  return photos
    .map((photo, index) => ({ photo, n: index + 1 }))
    .filter(({ n }) => uploadStateFor(n) !== undefined)
    .map(({ photo, n }) => {
      const state = uploadStateFor(n) as UploadItemState;
      const toDesk = n % 2 === 0;
      const bytesTotal = 4_800_000 + n * 12_000;
      const fraction = state === 'done' ? 1 : state === 'uploading' ? 0.42 : 0;
      return {
        id: asUploadId(`mock-upload-${String(n).padStart(2, '0')}`),
        photoId: photo.id,
        destinationId: toDesk ? DEST_DESK : DEST_OUTBOX,
        localPath: `/mock/outbox/${photo.fileName.replace(/\.NEF$/, '.jpg')}`,
        remotePath: `/incoming/2026-10-24/${photo.fileName.replace(/\.NEF$/, '.jpg')}`,
        state,
        bytesSent: Math.round(bytesTotal * fraction),
        bytesTotal,
        attempts: state === 'failed' ? 3 : 1,
        error: state === 'failed' ? 'Connection timed out after 30 s' : undefined,
      } satisfies UploadItem;
    });
}

/**
 * Expand Photo Mechanic code replacements (`=t1=`) and `{variables}` the way
 * the metadata service will. Unknown codes stay verbatim and are reported so
 * the caption editor can show them inline.
 */
export function expandMockCaption(
  photo: Photo,
  fields: IptcFields,
  text: string,
): { text: string; unresolved: string[] } {
  const date = photo.captureTime?.slice(0, 10) ?? '';
  const variables: Record<string, string> = {
    event: fields.event ?? '',
    location: fields.location ?? '',
    city: fields.city ?? '',
    state: fields.state ?? '',
    country: fields.country ?? '',
    source: fields.source ?? '',
    headline: fields.headline ?? '',
    objectName: fields.objectName ?? '',
    jobId: fields.jobId ?? '',
    date,
    dateCreated: fields.dateCreated ?? date,
    filename: photo.fileName,
    seq: photo.id.replace(/\D/g, ''),
    byline: fields.byline ?? '',
  };
  const codes: Record<string, string> = {
    t1: 'Manchester City',
    t2: 'Liverpool',
    uk: 'United Kingdom',
  };
  const unresolved: string[] = [];
  const expanded = text
    .replace(/=([A-Za-z0-9_]+)=/g, (match, name: string) => {
      const value = codes[name];
      if (value === undefined) {
        unresolved.push(match);
        return match;
      }
      return value;
    })
    .replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
      const value = variables[name];
      if (value === undefined || value === '') {
        unresolved.push(match);
        return match;
      }
      return value;
    });
  return { text: expanded, unresolved };
}

/**
 * Placeholder image for a mock photo as SVG: sky/ground gradient, a few
 * silhouettes with round heads (so there is something to detect and pixelate
 * later) and the photo number. Returns `undefined` for ids that are not mock photos.
 */
export function mockImageSvg(photoId: string, size: { width: number }): string | undefined {
  const match = /^mock-(\d+)$/.exec(photoId);
  if (!match) return undefined;
  const n = Number(match[1]);
  const hue = (n * 47) % 360;
  const width = size.width;
  const height = Math.round((width * MOCK_HEIGHT) / MOCK_WIDTH);
  const people = [0.3, 0.5, 0.7].map((x, i) => {
    const cx = Math.round(width * (x + ((n + i) % 3) * 0.02));
    const headR = Math.round(width * 0.045);
    const top = Math.round(height * 0.5);
    return (
      `<circle cx="${cx}" cy="${top}" r="${headR}" fill="hsl(${hue} 25% 22%)"/>` +
      `<rect x="${cx - headR * 1.4}" y="${top + headR * 1.1}" width="${headR * 2.8}" ` +
      `height="${height * 0.4}" rx="${headR}" fill="hsl(${hue} 25% 22%)"/>`
    );
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 55% 62%)"/>` +
    `<stop offset="0.62" stop-color="hsl(${hue} 45% 38%)"/>` +
    `<stop offset="0.62" stop-color="hsl(${hue} 30% 26%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue} 30% 14%)"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#g)"/>` +
    people.join('') +
    `<text x="${width * 0.04}" y="${height * 0.14}" font-family="sans-serif" ` +
    `font-size="${Math.round(width * 0.07)}" font-weight="700" fill="white" fill-opacity="0.85">${n}</text>` +
    `</svg>`
  );
}

/**
 * Linear f32 pixels for a mock photo, matching {@link mockImageSvg}'s gradient
 * and silhouettes closely enough that the develop screenshots show a real
 * render. Returning this from `app://linear` in mock mode keeps the renderer
 * path identical between mock and real data.
 */
export function mockLinearImage(
  photoId: string,
  maxEdge = 960,
):
  | {
      header: {
        width: number;
        height: number;
        sourceWidth: number;
        sourceHeight: number;
        sampleType: 'f32';
        asShotMultipliers: { r: number; g: number; b: number };
        cameraToSrgb: number[];
        xyzToCamera: number[];
      };
      rgba: Float32Array;
    }
  | undefined {
  const match = /^mock-(\d+)$/.exec(photoId);
  if (!match) return undefined;
  const n = Number(match[1]);
  const width = Math.min(1600, Math.max(64, Math.round(maxEdge)));
  const height = Math.round((width * MOCK_HEIGHT) / MOCK_WIDTH);
  const rgba = new Float32Array(width * height * 4);
  const hue = (n * 47) % 360;

  const hsl = (h: number, s: number, l: number): [number, number, number] => {
    const saturation = s / 100;
    const lightness = l / 100;
    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let rgb: [number, number, number];
    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    const m = lightness - c / 2;
    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
  };
  const linear = (value: number): number =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const write = (index: number, rgb: [number, number, number]): void => {
    rgba[index] = linear(rgb[0]);
    rgba[index + 1] = linear(rgb[1]);
    rgba[index + 2] = linear(rgb[2]);
    rgba[index + 3] = 1;
  };

  const skyTop = hsl(hue, 55, 62);
  const skyBottom = hsl(hue, 45, 38);
  const groundTop = hsl(hue, 30, 26);
  const groundBottom = hsl(hue, 30, 14);
  const people = [0.3, 0.5, 0.7].map((x, i) => ({
    cx: width * (x + ((n + i) % 3) * 0.02),
    r: width * 0.045,
    top: height * 0.5,
  }));
  const dark = hsl(hue, 25, 22);
  for (let y = 0; y < height; y++) {
    const fy = y / height;
    const background =
      fy < 0.62
        ? [
            skyTop[0] + (skyBottom[0] - skyTop[0]) * (fy / 0.62),
            skyTop[1] + (skyBottom[1] - skyTop[1]) * (fy / 0.62),
            skyTop[2] + (skyBottom[2] - skyTop[2]) * (fy / 0.62),
          ]
        : [
            groundTop[0] + (groundBottom[0] - groundTop[0]) * ((fy - 0.62) / 0.38),
            groundTop[1] + (groundBottom[1] - groundTop[1]) * ((fy - 0.62) / 0.38),
            groundTop[2] + (groundBottom[2] - groundTop[2]) * ((fy - 0.62) / 0.38),
          ];
    for (let x = 0; x < width; x++) {
      let colour = background as [number, number, number];
      for (const person of people) {
        const inHead = Math.hypot(x - person.cx, y - person.top) <= person.r;
        const inBody =
          Math.abs(x - person.cx) <= person.r * 1.4 &&
          y >= person.top + person.r * 1.1 &&
          y <= person.top + person.r * 1.1 + height * 0.4;
        if (inHead || inBody) colour = dark;
      }
      write((y * width + x) * 4, colour);
    }
  }
  return {
    header: {
      width,
      height,
      sourceWidth: width,
      sourceHeight: height,
      sampleType: 'f32',
      asShotMultipliers: { r: 1, g: 1, b: 1 },
      cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    },
    rgba,
  };
}
