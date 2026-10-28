import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asDestinationId, asPhotoId, type FolderDestination } from '@ee/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeFileName,
  createPathTemplateContext,
  defaultExpandPathTemplate,
  normalizeRemotePath,
  redactSecrets,
  resolveFolderDestinationPath,
  tempRemotePath,
  testDestination,
  type ConnectorFactory,
} from '../src/index';

describe('destination paths', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-dest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('expands the built-in template variables', () => {
    const context = createPathTemplateContext(
      'frame.jpg',
      asPhotoId('abc-1'),
      new Date(2026, 9, 27),
    );
    expect(context).toMatchObject({
      fileName: 'frame.jpg',
      filenamebase: 'frame',
      date: '2026-10-27',
      photoId: 'abc-1',
    });
    expect(defaultExpandPathTemplate('{date}/{filenamebase}-{unknown}.jpg', context)).toBe(
      '2026-10-27/frame-{unknown}.jpg',
    );
  });

  it('keeps folder destinations inside their base', () => {
    expect(resolveFolderDestinationPath('/photos', '2026/frame.jpg')).toBe(
      path.resolve('/photos/2026/frame.jpg'),
    );
    const root = path.parse(path.resolve('/')).root;
    expect(resolveFolderDestinationPath(root, 'nested/frame.jpg')).toBe(
      path.resolve(root, 'nested/frame.jpg'),
    );
    expect(() => resolveFolderDestinationPath('/photos', '../escape.jpg')).toThrowError(/escapes/);
    expect(() => resolveFolderDestinationPath('/photos', '/')).toThrowError(/empty|base/);
  });

  it('rejects remote traversal', () => {
    expect(normalizeRemotePath('/incoming/2026/frame.jpg')).toBe('/incoming/2026/frame.jpg');
    expect(normalizeRemotePath('incoming\\frame.jpg')).toBe('incoming/frame.jpg');
    expect(() => normalizeRemotePath('../../etc/passwd')).toThrowError(
      /escapes|Invalid remote path/,
    );
    expect(() => normalizeRemotePath('/')).toThrowError(/Invalid remote path/);
  });

  it('names part files by upload id and claim token', () => {
    const temp = tempRemotePath('/incoming/frame.jpg', 'upload-1', 'abcdef123456');
    expect(temp).toBe('/incoming/frame.jpg.upload-1.abcdef12.part');
    expect(temp).not.toBe(tempRemotePath('/incoming/frame.jpg', 'upload-2', 'abcdef123456'));
  });

  it('rejects unsafe file names', () => {
    expect(() => assertSafeFileName('../x.jpg')).toThrowError(/Invalid file name/);
    expect(() => assertSafeFileName('a/b.jpg')).toThrowError(/Invalid file name/);
    expect(() => assertSafeFileName('')).toThrowError(/Invalid file name/);
    expect(() => assertSafeFileName('frame.jpg')).not.toThrow();
  });

  it('probes a writable folder destination', async () => {
    const destinationDir = path.join(dir, 'created');
    const destination: FolderDestination = {
      id: asDestinationId('dest-folder'),
      name: 'Folder',
      kind: 'folder',
      path: destinationDir,
      remotePathTemplate: '{fileName}',
    };
    const result = await testDestination(destination);
    expect(result.ok).toBe(true);
    await expect(access(destinationDir)).resolves.toBeUndefined();
  });

  it('reports an unwritable folder destination', async () => {
    const file = path.join(dir, 'not-a-folder');
    await writeFile(file, 'x');
    const destination: FolderDestination = {
      id: asDestinationId('dest-file'),
      name: 'File',
      kind: 'folder',
      path: file,
      remotePathTemplate: '{fileName}',
    };
    const result = await testDestination(destination);
    expect(result.ok).toBe(false);
  });

  it('requires a credential provider for remote destinations', async () => {
    const result = await testDestination({
      id: asDestinationId('dest-remote'),
      name: 'Remote',
      kind: 'ftp',
      host: '127.0.0.1',
      port: 21,
      username: 'photo',
      credentialRef: 'cred',
      security: 'none',
      remotePathTemplate: '{fileName}',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('credential provider');
  });

  it('redacts secrets from ok:false connection test messages', async () => {
    const marker = 'test-message-secret';
    const factory: ConnectorFactory = () => ({
      async upload(): Promise<void> {},
      async test() {
        return { ok: false, message: `login failed for ${marker}` };
      },
    });
    const result = await testDestination(
      {
        id: asDestinationId('dest-redact'),
        name: 'Remote',
        kind: 'ftp',
        host: '127.0.0.1',
        port: 21,
        username: 'photo',
        credentialRef: 'cred',
        security: 'none',
        remotePathTemplate: '{fileName}',
      },
      { getSecret: async () => ({ password: marker }) },
      factory,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('[redacted]');
    expect(result.message ?? '').not.toContain(marker);
  });

  it('redacts credential material', () => {
    const message = 'failed for photo with password hunter2 and key SECRETKEY';
    expect(redactSecrets(message, { password: 'hunter2', privateKey: 'SECRETKEY' })).toBe(
      'failed for photo with password [redacted] and key [redacted]',
    );
    expect(redactSecrets(message, { password: 'hunter2' }, ['photo'])).toBe(
      'failed for [redacted] with password [redacted] and key SECRETKEY',
    );
  });
});
