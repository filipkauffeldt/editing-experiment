// Rebuilds packages/develop-gl/data/lensfun.json from Lensfun's published database.
// Usage: pnpm update-lensfun [--from <dir with the unpacked *.xml>]
//
// The database (https://lensfun.github.io/, CC BY-SA 3.0) is data, not code: we do not use the
// Lensfun library. The output keeps the Nikon Z mount (every maker) and Nikon's own F-mount
// lenses (the ones used through the FTZ adapter) with their cameras, as a compact JSON so the
// renderer can ship it. See docs/ARCHITECTURE.md "Lens corrections" for the licence handling.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const BASE = 'https://lensfun.github.io/db';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'data', 'lensfun.json');

const Z_MOUNT = 'Nikon Z';
const F_MOUNTS = new Set(['Nikon F', 'Nikon F AF', 'Nikon F AI', 'Nikon F AI-S']);

type Node = Record<string, unknown>;
const list = (value: unknown): Node[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as Node[]) : [value as Node];
const text = (value: unknown): string | undefined => {
  // The first untagged <model>/<maker> is the canonical (non-translated) name.
  const first = list(value).find((entry) => typeof entry !== 'object') ?? list(value)[0];
  if (first === undefined) return undefined;
  const raw = typeof first === 'object' ? (first as Node)['#text'] : first;
  return raw === undefined ? undefined : String(raw).trim();
};
const num = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const round = (value: number | undefined, digits = 7): number | undefined =>
  value === undefined ? undefined : Number(value.toFixed(digits));

async function download(): Promise<{ dir: string; version: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'lensfun-'));
  const versions = (await (await fetch(`${BASE}/versions.json`)).json()) as [number, number[]];
  const archive = join(dir, 'db.tar.bz2');
  const response = await fetch(`${BASE}/version_2.tar.bz2`);
  if (!response.ok) throw new Error(`lensfun download failed: ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const unpacked = join(dir, 'xml');
  mkdirSync(unpacked);
  execFileSync('tar', ['-xjf', archive, '-C', unpacked]);
  return { dir: unpacked, version: versions[0] };
}

async function main(): Promise<void> {
  const from = process.argv.indexOf('--from');
  const source = from >= 0 ? { dir: process.argv[from + 1] ?? '', version: 0 } : await download();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) =>
      [
        'lens',
        'camera',
        'mount',
        'maker',
        'model',
        'compat',
        'distortion',
        'tca',
        'vignetting',
      ].includes(name),
  });

  const mounts: Record<string, string[]> = {};
  const cameras: unknown[] = [];
  const lenses: unknown[] = [];
  for (const file of readdirSync(source.dir)
    .filter((name) => name.endsWith('.xml'))
    .sort()) {
    const db = (
      parser.parse(readFileSync(join(source.dir, file), 'utf8')) as { lensdatabase: Node }
    ).lensdatabase;
    for (const mount of list(db['mount'])) {
      const name = text(mount['name']);
      if (name === Z_MOUNT || (name && F_MOUNTS.has(name))) {
        mounts[name] = list(mount['compat']).map((c) => String(text(c)));
      }
    }
    for (const camera of list(db['camera'])) {
      const maker = text(camera['maker']);
      const mount = text(camera['mount']);
      const crop = num(camera['cropfactor']);
      if (!maker?.startsWith('Nikon') || mount === undefined || crop === undefined) continue;
      if (mount !== Z_MOUNT && !F_MOUNTS.has(mount)) continue;
      cameras.push({ maker, model: text(camera['model']), mount, crop });
    }
    for (const lens of list(db['lens'])) {
      const lensMounts = list(lens['mount']).map((m) => String(text(m)));
      const maker = text(lens['maker']);
      const isZ = lensMounts.includes(Z_MOUNT);
      const isNikonF = maker === 'Nikon' && lensMounts.some((m) => F_MOUNTS.has(m));
      if (!isZ && !isNikonF) continue;
      const type = text(lens['type']) ?? 'rectilinear';
      const calibration = (lens['calibration'] ?? {}) as Node;
      const focal = lens['focal'] as Node | undefined;
      const center = lens['center'] as Node | undefined;
      lenses.push({
        maker,
        model: text(lens['model']),
        mounts: lensMounts,
        crop: num(lens['cropfactor']),
        ...(lens['aspect-ratio'] === undefined
          ? {}
          : { aspect: round(parseAspect(String(lens['aspect-ratio'])), 4) }),
        ...(type === 'rectilinear' ? {} : { type }),
        ...(focal === undefined
          ? {}
          : { focal: [num(focal['min'] ?? focal['value']), num(focal['max'] ?? focal['value'])] }),
        ...(center === undefined ? {} : { center: [num(center['x']), num(center['y'])] }),
        // [focal, model, ...coefficients]; models: p3 k1 | p5 k1 k2 | pt a b c (real-focal ignored).
        distortion: list(calibration['distortion']).map((d) => {
          const model = String(d['model']);
          const focalLength = num(d['focal']);
          if (model === 'poly3') return [focalLength, 'p3', num(d['k1']) ?? 0];
          if (model === 'poly5') return [focalLength, 'p5', num(d['k1']) ?? 0, num(d['k2']) ?? 0];
          return [focalLength, 'pt', num(d['a']) ?? 0, num(d['b']) ?? 0, num(d['c']) ?? 0];
        }),
        // [focal, model, ...]: lin kr kb | p3 vr vb br bb cr cb
        tca: list(calibration['tca']).map((t) =>
          String(t['model']) === 'linear'
            ? [num(t['focal']), 'lin', num(t['kr']) ?? 1, num(t['kb']) ?? 1]
            : [
                num(t['focal']),
                'p3',
                num(t['vr']) ?? 1,
                num(t['vb']) ?? 1,
                num(t['br']) ?? 0,
                num(t['bb']) ?? 0,
                num(t['cr']) ?? 0,
                num(t['cb']) ?? 0,
              ],
        ),
        // [focal, aperture, distance, k1, k2, k3]
        vignetting: list(calibration['vignetting']).map((v) => [
          num(v['focal']),
          num(v['aperture']),
          num(v['distance']),
          num(v['k1']) ?? 0,
          num(v['k2']) ?? 0,
          num(v['k3']) ?? 0,
        ]),
      });
    }
  }
  const data = {
    source: 'https://lensfun.github.io/ (database format 2)',
    version: source.version,
    license: 'CC BY-SA 3.0, Lensfun contributors; pruned and converted to JSON',
    mounts,
    cameras,
    lenses,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(data)}\n`);
  console.log(`wrote ${output}: ${lenses.length} lenses, ${cameras.length} cameras`);
}

function parseAspect(value: string): number {
  const [a, b] = value.split(':').map(Number);
  return b === undefined ? (a ?? 1.5) : (a ?? 3) / (b || 1);
}

await main();
