import { asPhotoId } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEVELOP_HISTORY_PHOTO_LIMIT,
  DEVELOP_HISTORY_STEP_LIMIT,
  DEVELOP_NUDGE_QUIET_MS,
  DevelopHistory,
  sameDevelopSnapshot,
  type DevelopSettingsSnapshot,
} from '../src/renderer/develop-history';

const photo = asPhotoId('mock-01');
const other = asPhotoId('mock-02');

const settings = (params: DevelopSettingsSnapshot['params']): DevelopSettingsSnapshot => ({
  params,
  parked: {},
});

describe('develop history', () => {
  it('restores the settings before a change, absent keys included, and reapplies them', () => {
    const history = new DevelopHistory();
    const before = settings({ Contrast2012: 10 });
    const after = settings({ Contrast2012: 10, Exposure2012: 1 });

    expect(history.record(photo, before, after)).toBe(true);
    expect(history.canUndo(photo)).toBe(true);
    expect(history.canRedo(photo)).toBe(false);

    // The absent Exposure2012 comes back absent, not as a written neutral 0.
    expect(history.undo(photo)).toEqual(before);
    expect(history.canUndo(photo)).toBe(false);
    expect(history.canRedo(photo)).toBe(true);
    expect(history.redo(photo)).toEqual(after);
    expect(history.canRedo(photo)).toBe(false);
  });

  it('does not record a change that changes nothing', () => {
    const history = new DevelopHistory();
    const before = settings({ Exposure2012: 1 });
    expect(history.record(photo, before, settings({ Exposure2012: 1 }))).toBe(false);
    expect(history.canUndo(photo)).toBe(false);
  });

  it('drops a gesture that comes back to where it started', () => {
    const history = new DevelopHistory();
    history.beginGesture();
    history.record(photo, settings({}), settings({ Exposure2012: 1 }));
    history.record(photo, settings({ Exposure2012: 1 }), settings({}));
    history.endGesture();
    expect(history.canUndo(photo)).toBe(false);
  });

  it('makes a whole pointer or typed gesture one step', () => {
    const history = new DevelopHistory();
    history.beginGesture();
    history.record(photo, settings({}), settings({ Exposure2012: 0.1 }));
    history.record(photo, settings({ Exposure2012: 0.1 }), settings({ Exposure2012: 0.4 }));
    history.record(photo, settings({ Exposure2012: 0.4 }), settings({ Exposure2012: 0.9 }));
    history.endGesture();

    expect(history.undoDepth(photo)).toBe(1);
    expect(history.undo(photo)).toEqual(settings({}));
  });

  it('keeps a typed edit apart from a pointer drag that overlaps it', () => {
    const history = new DevelopHistory();
    history.beginGesture();
    history.beginTypedEdit();
    history.record(photo, settings({}), settings({ Exposure2012: 1 }));
    history.endTypedEdit();
    history.record(photo, settings({ Exposure2012: 1 }), settings({ Exposure2012: 1, Tint: 2 }));
    history.endGesture();

    expect(history.undoDepth(photo)).toBe(2);
    expect(history.undo(photo)).toEqual(settings({ Exposure2012: 1 }));
    expect(history.undo(photo)).toEqual(settings({}));
  });

  it('makes a burst of arrow-key nudges on one slider one step until it goes quiet', () => {
    const history = new DevelopHistory();
    history.record(photo, settings({}), settings({ Exposure2012: 0.1 }), {
      nudgeKey: 'nudge:Exposure2012',
      now: 1_000,
    });
    history.record(photo, settings({ Exposure2012: 0.1 }), settings({ Exposure2012: 0.2 }), {
      nudgeKey: 'nudge:Exposure2012',
      now: 1_500,
    });
    expect(history.undoDepth(photo)).toBe(1);

    // A pause starts a new step.
    history.record(photo, settings({ Exposure2012: 0.2 }), settings({ Exposure2012: 0.3 }), {
      nudgeKey: 'nudge:Exposure2012',
      now: 1_500 + DEVELOP_NUDGE_QUIET_MS + 1,
    });
    expect(history.undoDepth(photo)).toBe(2);
    expect(history.undo(photo)).toEqual(settings({ Exposure2012: 0.2 }));
    expect(history.undo(photo)).toEqual(settings({}));
  });

  it('does not merge nudges of different sliders', () => {
    const history = new DevelopHistory();
    history.record(photo, settings({}), settings({ Exposure2012: 0.1 }), {
      nudgeKey: 'nudge:Exposure2012',
      now: 1_000,
    });
    history.record(
      photo,
      settings({ Exposure2012: 0.1 }),
      settings({ Exposure2012: 0.1, Tint: 3 }),
      {
        nudgeKey: 'nudge:Tint',
        now: 1_100,
      },
    );
    expect(history.undoDepth(photo)).toBe(2);
  });

  it('clears the redo steps when a new change comes after an undo', () => {
    const history = new DevelopHistory();
    history.record(photo, settings({}), settings({ Exposure2012: 1 }));
    expect(history.undo(photo)).toEqual(settings({}));
    expect(history.canRedo(photo)).toBe(true);

    history.record(photo, settings({}), settings({ Exposure2012: 2 }));
    expect(history.canRedo(photo)).toBe(false);
    expect(history.undo(photo)).toEqual(settings({}));
  });

  it(`keeps at most ${DEVELOP_HISTORY_STEP_LIMIT} steps per photo`, () => {
    const history = new DevelopHistory();
    let current = settings({});
    for (let step = 0; step < DEVELOP_HISTORY_STEP_LIMIT + 5; step++) {
      const next = settings({ Exposure2012: step + 1 });
      history.record(photo, current, next);
      current = next;
    }
    expect(history.undoDepth(photo)).toBe(DEVELOP_HISTORY_STEP_LIMIT);
    let last: DevelopSettingsSnapshot | undefined;
    while (history.canUndo(photo)) last = history.undo(photo);
    // The five oldest steps are gone; the oldest kept step goes back to the state after step 4.
    expect(last).toEqual(settings({ Exposure2012: 5 }));
  });

  it(`keeps the histories of at most ${DEVELOP_HISTORY_PHOTO_LIMIT} photos, dropping the least recently edited`, () => {
    const history = new DevelopHistory();
    const ids = Array.from({ length: DEVELOP_HISTORY_PHOTO_LIMIT + 1 }, (_, index) =>
      asPhotoId(`mock-${index}`),
    );
    for (const [index, id] of ids.entries()) {
      history.record(id, settings({}), settings({ Exposure2012: index + 1 }));
    }
    expect(history.photos()).toHaveLength(DEVELOP_HISTORY_PHOTO_LIMIT);
    expect(history.canUndo(ids[0]!)).toBe(false);
    expect(history.canUndo(ids.at(-1)!)).toBe(true);

    // Editing an older photo again makes it recent, so a new history drops the next oldest.
    const first = ids[1]!;
    history.record(first, settings({}), settings({ Exposure2012: 99 }));
    history.record(other, settings({}), settings({ Exposure2012: 1 }));
    expect(history.canUndo(first)).toBe(true);
    expect(history.canUndo(ids[2]!)).toBe(false);
  });

  it('forgets a photo and compares snapshots deeply', () => {
    const history = new DevelopHistory();
    history.record(
      photo,
      settings({}),
      settings({ crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 } }),
    );
    expect(
      sameDevelopSnapshot(
        settings({ crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 } }),
        settings({ crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 } }),
      ),
    ).toBe(true);
    expect(sameDevelopSnapshot(settings({}), settings({ Exposure2012: 0 }))).toBe(false);

    history.forget(photo);
    expect(history.canUndo(photo)).toBe(false);
  });

  it('restores a switched-off section with its parked values', () => {
    const history = new DevelopHistory();
    const before = { params: { Exposure2012: 1 }, parked: {} };
    const after = { params: {}, parked: { Tone: { Exposure2012: 1 } } };
    history.record(photo, before, after);
    expect(history.undo(photo)).toEqual(before);
    expect(history.redo(photo)).toEqual(after);
  });
});
