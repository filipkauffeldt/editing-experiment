import { asSourceId, type CardSource, type FolderSource } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  cardSourceFor,
  matchCardSources,
  sourcesToIngest,
  unconfiguredCards,
} from '../src/renderer/cards';

const discovered = (id: string, mountPath: string, volumeLabel: string): CardSource => ({
  kind: 'card',
  id: asSourceId(id),
  name: volumeLabel,
  mountPath,
  volumeLabel,
  discovered: true,
});

describe('matchCardSources', () => {
  it('matches by mount path first', () => {
    const a = discovered('a', '/media/u/NIKON Z 6', 'NIKON Z 6');
    const b = discovered('b', '/media/u/NIKON Z 61', 'NIKON Z 6');

    const matches = matchCardSources(
      [
        { mountPath: '/media/u/NIKON Z 61', volumeLabel: 'NIKON Z 6' },
        { mountPath: '/media/u/NIKON Z 6', volumeLabel: 'NIKON Z 6' },
      ],
      [a, b],
    );

    expect(matches.get('/media/u/NIKON Z 6')).toBe(a);
    expect(matches.get('/media/u/NIKON Z 61')).toBe(b);
  });

  it('falls back to the label for a card that moved, using each source once', () => {
    const a = discovered('a', 'E:\\', 'Drive E');
    const b = discovered('b', '/media/u/NIKON Z 6', 'NIKON Z 6');

    const matches = matchCardSources(
      [
        { mountPath: 'F:\\', volumeLabel: 'Drive E' },
        { mountPath: '/run/media/u/NIKON Z 6', volumeLabel: 'NIKON Z 6' },
        { mountPath: '/run/media/u/NIKON Z 61', volumeLabel: 'NIKON Z 6' },
      ],
      [a, b],
    );

    expect(matches.get('F:\\')).toBe(a);
    expect(matches.get('/run/media/u/NIKON Z 6')).toBe(b);
    expect(matches.has('/run/media/u/NIKON Z 61')).toBe(false);
  });

  it('does not take the source of a card that is mounted now', () => {
    const a = discovered('a', '/media/u/NIKON Z 6', 'NIKON Z 6');

    const matches = matchCardSources(
      [
        { mountPath: '/media/u/NIKON Z 6', volumeLabel: 'NIKON Z 6' },
        { mountPath: '/media/u/NIKON Z 61', volumeLabel: 'NIKON Z 6' },
      ],
      [a],
    );

    expect([...matches.keys()]).toEqual(['/media/u/NIKON Z 6']);
  });

  it('ignores cards added by hand', () => {
    const manual: CardSource = {
      ...discovered('m', '/media/u/CARD', 'CARD'),
      discovered: undefined,
    };

    expect(
      matchCardSources([{ mountPath: '/media/u/CARD', volumeLabel: 'CARD' }], [manual]).size,
    ).toBe(0);
  });
});

describe('unconfiguredCards', () => {
  it('hides a card that a hand-added source already covers', () => {
    const manual: CardSource = {
      ...discovered('m', '/media/u/CARD', 'CARD'),
      discovered: undefined,
    };
    const cards = [
      { mountPath: '/media/u/CARD', volumeLabel: 'CARD' },
      { mountPath: '/media/u/OTHER', volumeLabel: 'OTHER' },
    ];

    expect(unconfiguredCards(cards, [manual]).map((card) => card.mountPath)).toEqual([
      '/media/u/OTHER',
    ]);
  });
});

describe('cardSourceFor', () => {
  it('names a second card with the same label so the subfolders do not collide', () => {
    const first = discovered('a', '/media/u/NIKON Z 6', 'NIKON Z 6');

    const second = cardSourceFor(
      { mountPath: '/media/u/NIKON Z 61', volumeLabel: 'NIKON Z 6' },
      undefined,
      [first],
    );

    expect(second).toMatchObject({ name: 'NIKON Z 6 (2)', discovered: true });
    expect(second.id).not.toBe(first.id);
  });
});

describe('sourcesToIngest', () => {
  it('drops discovered cards that are not picked and keeps everything else', () => {
    const folder: FolderSource = {
      kind: 'folder',
      id: asSourceId('f'),
      name: 'Folder',
      path: '/photos',
    };
    const manual: CardSource = { ...discovered('m', '/media/u/M', 'M'), discovered: undefined };
    const a = discovered('a', '/media/u/A', 'A');
    const b = discovered('b', '/media/u/B', 'B');

    expect(sourcesToIngest([folder, manual, a, b], ['a'])).toEqual([folder, manual, a]);
  });
});
