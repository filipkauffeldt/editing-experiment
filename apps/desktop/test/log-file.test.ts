import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RotatingLogFile } from '../src/main/log-file';
import { LogRedactor } from '../src/shared/log-redact';

describe('RotatingLogFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'ee-log-')), 'logs');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  const clock = (): (() => Date) => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 10, 15, 12, 0, tick++));
  };

  it('creates the folder and writes one line per message with time, level and process', async () => {
    const log = new RotatingLogFile({ dir, maxBytes: 10_000, maxFiles: 3, now: clock() });
    log.write('main', 'warn', 'low disk');
    log.write('renderer', 'error', 'boom\nsecond line');
    expect(await readFile(join(dir, 'ee.log'), 'utf8')).toBe(
      '2026-11-15T12:00:00.000Z WARN  [main] low disk\n' +
        '2026-11-15T12:00:01.000Z ERROR [renderer] boom\n    second line\n',
    );
  });

  it('rotates by size and keeps at most maxFiles files, newest first', async () => {
    const log = new RotatingLogFile({ dir, maxBytes: 300, maxFiles: 3, now: clock() });
    for (let i = 0; i < 40; i++) log.write('jobs', 'error', `message ${i} ${'x'.repeat(60)}`);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['ee.1.log', 'ee.2.log', 'ee.log']);
    const read = async (name: string): Promise<string> => readFile(join(dir, name), 'utf8');
    const [current, first, second] = [
      await read('ee.log'),
      await read('ee.1.log'),
      await read('ee.2.log'),
    ];
    for (const text of [current, first, second]) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
    }
    // The newest message is in the current file, older ones moved down, the oldest are gone.
    const firstNumber = (text: string): number => Number(/message (\d+) /.exec(text)![1]);
    expect(current).toContain('message 39 ');
    expect(firstNumber(first)).toBeLessThan(firstNumber(current));
    expect(firstNumber(second)).toBeLessThan(firstNumber(first));
    expect(`${current}${first}${second}`).not.toContain('message 0 ');
  });

  it('continues in the existing file after a restart', async () => {
    new RotatingLogFile({ dir, maxBytes: 10_000, maxFiles: 3 }).write('main', 'warn', 'first run');
    new RotatingLogFile({ dir, maxBytes: 10_000, maxFiles: 3 }).write('main', 'warn', 'second run');
    const text = await readFile(join(dir, 'ee.log'), 'utf8');
    expect(text.indexOf('first run')).toBeLessThan(text.indexOf('second run'));
  });

  it('writes a line longer than the limit rather than dropping it', async () => {
    const log = new RotatingLogFile({ dir, maxBytes: 50, maxFiles: 2 });
    log.write('main', 'error', 'y'.repeat(200));
    expect(await readFile(join(dir, 'ee.log'), 'utf8')).toContain('y'.repeat(200));
  });

  it('redacts before writing', async () => {
    const log = new RotatingLogFile({ dir, maxBytes: 10_000, maxFiles: 2 });
    log.redactor.addSecrets(['hunter2hunter2']);
    log.write('jobs', 'error', 'login rejected: hunter2hunter2');
    const text = await readFile(join(dir, 'ee.log'), 'utf8');
    expect(text).toContain('login rejected: [redacted]');
    expect(text).not.toContain('hunter2');
  });
});

describe('LogRedactor', () => {
  const redactor = new LogRedactor();
  redactor.addSecrets(['s3cret-value', undefined, '']);

  it.each([
    [
      'ftp://user:pa55@example.sportfotografen.se/in',
      'ftp://[redacted]@example.sportfotografen.se/in',
    ],
    [
      'sftp://user@example.sportfotografen.se:22/',
      'sftp://[redacted]@example.sportfotografen.se:22/',
    ],
    ['password=abc123 next', 'password=[redacted] next'],
    ['{"password": "abc 123", "user": "x"}', '{"password": [redacted], "user": "x"}'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [redacted]'],
    ['bad token: abc.def', 'bad token: [redacted]'],
    ['stored as s3cret-value here', 'stored as [redacted] here'],
    [
      'key -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY----- end',
      'key [redacted] end',
    ],
  ])('turns %j into %j', (input, expected) => {
    expect(redactor.redact(input)).toBe(expected);
  });

  it('leaves ordinary text, paths and host names alone', () => {
    const text =
      'Could not read /Photos/20261104_GAIS-AIK/_DSC1234.NEF from ftp.sportfotografen.se:21';
    expect(redactor.redact(text)).toBe(text);
  });
});
