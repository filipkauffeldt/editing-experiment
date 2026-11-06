import { type CodeReplacementFile } from '@ee/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { MOCK_CODE_REPLACEMENT_PATH } from '../src/shared/mock';
import { activePhoto, createAppStore, type AppStore } from '../src/renderer/store';
import { createFakeBridge, type FakeBridge } from './fake-bridge';

const FIRST = '/codes/first.txt';
const SECOND = '/codes/second.txt';

const stores: AppStore[] = [];

/** What is "on disk": file text and a modified time per path. */
type Disk = Map<string, { text: string; mtimeMs: number }>;

async function renderApp(disk: Disk, paths: string[]) {
  // The mock settings name this file; it exists, and holds no codes.
  if (!disk.has(MOCK_CODE_REPLACEMENT_PATH)) disk.set(MOCK_CODE_REPLACEMENT_PATH, codes(''));
  const holder: { fake?: FakeBridge } = {};
  const fake = createFakeBridge({
    handlers: {
      'metadata:codeReplacementFiles': async () => ({
        files: (holder.fake?.settings.codeReplacementPaths ?? []).map(
          (path): CodeReplacementFile => {
            const file = disk.get(path);
            return file ? { path, ...file } : { path, error: `Cannot read ${path}` };
          },
        ),
      }),
    },
  });
  holder.fake = fake;
  window.eeTransport = fake.transport;
  const store = createAppStore(fake.bridge, {
    renderForExport: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }),
    confirm: () => true,
  });
  stores.push(store);
  render(<App store={store} />);
  await screen.findByTestId('film-strip');
  await act(async () => {
    await store.saveSettings({ codeReplacementPaths: paths });
    await store.refreshCodeReplacements();
  });
  return { store, fake, user: userEvent.setup({ delay: null }) };
}

const codes = (text: string, mtimeMs = 1): { text: string; mtimeMs: number } => ({ text, mtimeMs });

const standardDisk = (): Disk =>
  new Map([
    [
      FIRST,
      codes(
        [
          't1\tGAIS',
          't2\tAIK',
          'Å1\tÅngelholm',
          'eq\ta=b',
          'loop\t=t1=',
          'when\t{location}',
          // A .tsv row with three columns.
          'a10\tAlfa\tBravo\tCharlie',
        ].join('\n'),
      ),
    ],
  ]);

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

const captionField = (): HTMLTextAreaElement => {
  const field = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
  if (!field) throw new Error('no caption field');
  return field;
};

/**
 * What the browser does for an edit that is not typing (undo, a word deletion, IME): the field
 * changes behind React's back and an `input` event says how. Setting `.value` the plain way would
 * make React's own tracker swallow the event.
 */
function browserEdit(
  area: HTMLTextAreaElement,
  inputType: string,
  value: string,
  caret: number,
  init: InputEventInit = {},
): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setValue?.call(area, value);
  area.setSelectionRange(caret, caret);
  fireEvent(area, new InputEvent('input', { inputType, bubbles: true, ...init }));
}

/** Focus the caption and empty it, as a fresh caption would be. */
async function startEmpty(user: ReturnType<typeof userEvent.setup>): Promise<HTMLTextAreaElement> {
  const caption = captionField();
  await user.click(caption);
  await user.clear(caption);
  return caption;
}

const thumbnail = (fileName: string): HTMLElement => {
  const button = document.querySelector<HTMLElement>(`button[title^="${fileName}"]`);
  if (!button) throw new Error(`no thumbnail for ${fileName}`);
  return button;
};

describe('instant code replacement in the caption', () => {
  it('replaces a known code when its closing delimiter is typed, with the caret right after it', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=t1');
    expect(caption.value).toBe('=t1');
    await user.keyboard('=');

    expect(caption.value).toBe('GAIS');
    expect(caption.selectionStart).toBe(4);
    expect(caption.selectionEnd).toBe(4);
  });

  it('keeps typing after the replacement, and in the middle of a caption', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('Goal for =t1= after a pass');
    expect(caption.value).toBe('Goal for GAIS after a pass');

    // Between two words, with text on both sides of the caret.
    caption.setSelectionRange('Goal for '.length, 'Goal for '.length);
    await user.keyboard('=t2=');
    expect(caption.value).toBe('Goal for AIKGAIS after a pass');
    expect(caption.selectionStart).toBe('Goal for AIK'.length);
    await user.keyboard(' v ');
    expect(caption.value).toBe('Goal for AIK v GAIS after a pass');
    expect(caption.selectionStart).toBe('Goal for AIK v '.length);
  });

  it('leaves text that is not a known code alone, with nothing shown while typing', async () => {
    const { user, store } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    for (const typed of ['a=b', ' =zz=', ' =T1=', ' a=b=c', ' ==', ' =t1']) {
      await user.keyboard(typed);
    }

    expect(caption.value).toBe('a=b =zz= =T1= a=b=c == =t1');
    expect(store.getState().toasts).toEqual([]);
    expect(screen.queryByText('Unknown codes:')).toBeNull();
  });

  it('lets the closing delimiter of an unknown code open the next one', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=x=t1=');

    expect(caption.value).toBe('=xGAIS');
    expect(caption.selectionStart).toBe(6);
  });

  it('is case sensitive and replaces a code and a replacement that hold Å', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=T1= =Å1= =å1=');

    expect(caption.value).toBe('=T1= Ångelholm =å1=');
  });

  it('replaces once: a replacement with a delimiter or that looks like a code is left as it is', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=eq=');
    expect(caption.value).toBe('a=b');
    expect(caption.selectionStart).toBe(3);
    await user.keyboard(' ');
    await user.keyboard('=loop=');
    expect(caption.value).toBe('a=b =t1=');
    expect(caption.selectionStart).toBe('a=b =t1='.length);
  });

  it('leaves {variables} in a replacement for blur', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=when= and {{location}');
    expect(caption.value).toBe('{location} and {location}');

    await user.tab();
    await waitFor(() => expect(caption.value).toBe('Etihad Stadium and Etihad Stadium'));
  });

  it('saves the replaced text, not what was typed', async () => {
    const { user, store, fake } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    const photo = activePhoto(store.getState());

    await user.keyboard('=t1=');

    expect(photo && store.getState().metadata[photo.id]?.caption).toBe('GAIS');
    await waitFor(() => {
      const write = fake.calls.filter((call) => call.channel === 'metadata:write').at(-1);
      expect(write?.args[0]).toMatchObject({ fields: { caption: 'GAIS' } });
    });
    expect(caption.value).toBe('GAIS');
  });

  it('does not replace pasted text: it waits for blur', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.paste('Goal =t1=');
    expect(caption.value).toBe('Goal =t1=');
    expect(caption.selectionStart).toBe(9);

    await user.tab();
    await waitFor(() => expect(caption.value).toBe('Goal Manchester City'));
  });

  it('does not replace when a closing delimiter is deleted, and does when it is typed again', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.paste('=t1=');
    await user.keyboard('{Backspace}');
    expect(caption.value).toBe('=t1');
    await user.keyboard('=');
    expect(caption.value).toBe('GAIS');
  });

  it('replaces when typing the delimiter over a selection ends a known token, and not otherwise', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.paste('=t1x');
    caption.setSelectionRange(3, 4);
    await user.keyboard('=');
    expect(caption.value).toBe('GAIS');

    await user.clear(caption);
    await user.paste('ab=cd');
    caption.setSelectionRange(1, 4);
    await user.keyboard('=');
    expect(caption.value).toBe('a=d');
  });

  it('does not replace during IME composition or from an undo', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    await user.paste('=t1');

    for (const [inputType, isComposing] of [
      ['insertCompositionText', true],
      ['historyUndo', false],
      ['insertFromDrop', false],
    ] as const) {
      browserEdit(caption, 'historyUndo', 'x', 1);
      browserEdit(caption, inputType, '=t1=', 4, { data: '=', isComposing });
      expect(caption.value, inputType).toBe('=t1=');
    }
  });

  it('expands a token with no match once an edit inside it makes a known code', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('Goal =foo= more');
    expect(caption.value).toBe('Goal =foo= more');
    caption.setSelectionRange('Goal =foo'.length, 'Goal =foo'.length);
    await user.keyboard('{Backspace}{Backspace}{Backspace}t1');

    expect(caption.value).toBe('Goal GAIS more');
    expect(caption.selectionStart).toBe('Goal GAIS'.length);
    expect(caption.selectionEnd).toBe('Goal GAIS'.length);
  });

  it('expands from Backspace in =t1x= and from Delete in =xt1=', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.paste('Goal =t1x= more');
    caption.setSelectionRange('Goal =t1x'.length, 'Goal =t1x'.length);
    await user.keyboard('{Backspace}');
    expect(caption.value).toBe('Goal GAIS more');
    expect(caption.selectionStart).toBe('Goal GAIS'.length);

    await user.clear(caption);
    await user.paste('Goal =xt1= more');
    caption.setSelectionRange('Goal ='.length, 'Goal ='.length);
    await user.keyboard('{Delete}');
    expect(caption.value).toBe('Goal GAIS more');
    expect(caption.selectionStart).toBe('Goal GAIS'.length);
  });

  it('expands when an opening delimiter is typed in front of existing text', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.paste('t1= and more');
    caption.setSelectionRange(0, 0);
    await user.keyboard('=');

    expect(caption.value).toBe('GAIS and more');
    expect(caption.selectionStart).toBe(4);
  });

  it('expands for a word deletion that leaves a known code, and for no other kind of change', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    await user.paste('x');

    // What the field holds and where the caret is after the browser made the change.
    const changeTo = (inputType: string, value: string, caret: number): void => {
      // React drops an input event that leaves the value it last saw, so start from another one.
      browserEdit(caption, 'historyUndo', 'x', 1);
      browserEdit(caption, inputType, value, caret);
    };
    for (const inputType of ['historyUndo', 'historyRedo', 'insertFromPaste', 'deleteByCut']) {
      changeTo(inputType, '=t1=', 3);
      expect(caption.value, inputType).toBe('=t1=');
    }
    changeTo('deleteWordBackward', '=t1=', 3);
    expect(caption.value).toBe('GAIS');
    changeTo('deleteWordForward', '=t1=', 1);
    expect(caption.value).toBe('GAIS');
  });

  it('leaves a restored =t1= alone until the next typed edit that leaves a known code', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    await user.keyboard('Goal =t1=');
    expect(caption.value).toBe('Goal GAIS');

    // What Ctrl+Z does: the typed text is back, and the undo event expands nothing.
    browserEdit(caption, 'historyUndo', 'Goal =t1=', 9);
    expect(caption.value).toBe('Goal =t1=');
    await user.keyboard(' later');
    expect(caption.value).toBe('Goal =t1= later');

    caption.setSelectionRange(8, 8);
    await user.keyboard('x');
    expect(caption.value).toBe('Goal =t1x= later');
    await user.keyboard('{Backspace}');
    expect(caption.value).toBe('Goal GAIS later');
  });

  it('does not expand text like a=b c=d when "b c" is not a known code', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('a=b c=d');
    caption.setSelectionRange(5, 5);
    await user.keyboard('x{Backspace}{Backspace}c');
    caption.setSelectionRange(1, 1);
    await user.keyboard('{Delete}=');

    expect(caption.value).toBe('a=b c=d');
  });

  it('replaces =a10#2= with the second column of a .tsv at the closing delimiter', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    // # is Shift+3 on a Swedish keyboard: the key is "#" with Shift held, and it types like any character.
    await user.keyboard('=a10{Shift>}#{/Shift}2');
    expect(caption.value).toBe('=a10#2');
    await user.keyboard('=');
    expect(caption.value).toBe('Bravo');
    expect(caption.selectionStart).toBe(5);

    await user.keyboard(' =a10#1= =a10= =a10#3=');
    expect(caption.value).toBe('Bravo Alfa Alfa Charlie');
  });

  it('leaves a column that does not exist as typed, and expands it once an edit makes a real one', async () => {
    const { user, store } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('Goal =a10#9= more');
    expect(caption.value).toBe('Goal =a10#9= more');
    expect(store.getState().toasts).toEqual([]);

    caption.setSelectionRange('Goal =a10#9'.length, 'Goal =a10#9'.length);
    await user.keyboard('{Backspace}2');

    expect(caption.value).toBe('Goal Bravo more');
    expect(caption.selectionStart).toBe('Goal Bravo'.length);
  });

  it('types = on a Swedish keyboard: it is Shift+0', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    // Shift+0 reports key "=" with code Digit0; AltGr combinations report the character they type.
    await user.keyboard('{Shift>}={/Shift}t1{Shift>}={/Shift}');

    expect(caption.value).toBe('GAIS');
  });

  it('asks the jobs process for nothing while typing', async () => {
    const { user, fake } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    const before = fake.calls.length;

    await user.keyboard('Goal for =t1= and =t2= with =x=t1= in the second half');

    expect(caption.value).toBe('Goal for GAIS and AIK with =xGAIS in the second half');
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it('follows a later file for a code that two files define', async () => {
    const disk = standardDisk();
    disk.set(SECOND, codes('t1\tAIK Solna\nt9\tDjurgården'));
    const { user } = await renderApp(disk, [FIRST, SECOND]);
    const caption = await startEmpty(user);

    await user.keyboard('=t1= =t9= =t2=');

    expect(caption.value).toBe('AIK Solna Djurgården AIK');
  });

  it('reads the files again when one is added in Settings', async () => {
    const disk = standardDisk();
    disk.set(SECOND, codes('t7\tHammarby'));
    const { user, store } = await renderApp(disk, [FIRST]);
    const caption = await startEmpty(user);
    await user.keyboard('=t7=');
    expect(caption.value).toBe('=t7=');

    await act(async () => {
      await store.addCodeReplacementFiles([SECOND]);
    });
    await user.clear(caption);
    await user.keyboard('=t7=');

    expect(caption.value).toBe('Hammarby');
  });

  it('reads a file again when its modified time changed', async () => {
    const disk = standardDisk();
    const { user } = await renderApp(disk, [FIRST]);
    const caption = await startEmpty(user);
    await user.keyboard('=t5=');
    expect(caption.value).toBe('=t5=');

    disk.set(FIRST, codes('t5\tBrommapojkarna', 2));
    await user.tab();
    await user.click(caption);
    await user.clear(caption);
    await user.keyboard('=t5=');

    expect(caption.value).toBe('Brommapojkarna');
  });

  it('reports a file that cannot be read once, and the others keep working', async () => {
    const { user, store } = await renderApp(standardDisk(), ['/codes/missing.txt', FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=t1=');
    await user.tab();
    await user.click(caption);
    await user.tab();
    await user.click(caption);

    expect(caption.value).toBe('GAIS');
    const toasts = store.getState().toasts.filter((toast) => toast.message.includes('missing.txt'));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('error');
  });

  it('still expands everything on blur and reports the codes it could not resolve', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);

    await user.keyboard('=t1= v =zz= at {{location}');
    expect(caption.value).toBe('GAIS v =zz= at {location}');

    await user.tab();

    await waitFor(() => expect(caption.value).toBe('GAIS v =zz= at Etihad Stadium'));
    expect(await screen.findByText('Unknown codes:')).toBeTruthy();
    expect(screen.getByText('=zz=')).toBeTruthy();
  });

  it('does not carry text onto the next photo when the selection changes', async () => {
    const { user, store } = await renderApp(standardDisk(), [FIRST]);
    const first = activePhoto(store.getState());
    if (!first) throw new Error('no photo');
    await waitFor(() => expect(store.getState().metadata[first.id]).toBeDefined());
    const caption = await startEmpty(user);
    await user.keyboard('First =t1');

    // The selection moves before the delimiter is typed.
    const next = store.getState().photos.find((photo) => photo.id !== first.id);
    if (!next) throw new Error('no second photo');
    const second = next.id;
    await user.click(thumbnail(next.fileName));
    await waitFor(() => expect(activePhoto(store.getState())?.id).toBe(second));
    await waitFor(() => expect(store.getState().metadata[second]).toBeDefined());
    const secondCaption = store.getState().metadata[second]?.caption;
    await user.click(captionField());
    await user.keyboard('=');

    expect(store.getState().metadata[first.id]?.caption).toBe('First =t1');
    expect(store.getState().metadata[second]?.caption).toBe(`${secondCaption}=`);
    expect(captionField().value).toBe(`${secondCaption}=`);
    expect(caption).toBe(captionField());
  });
});

describe('Ctrl+Space and the caret', () => {
  const PASTED = 'Goal =t1= by {location} end';
  const EXPANDED = 'Goal Manchester City by Etihad Stadium end';

  async function expandWithCaretAt(index: number): Promise<HTMLTextAreaElement> {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    await user.paste(PASTED);
    caption.setSelectionRange(index, index);
    await user.keyboard('{Control>} {/Control}');
    await waitFor(() => expect(caption.value).toBe(EXPANDED));
    return caption;
  }

  it('puts the caret at the end of the replacement that was before it, with the text after it as it was', async () => {
    const caption = await expandWithCaretAt('Goal =t1='.length);

    expect(caption.selectionStart).toBe('Goal Manchester City'.length);
    expect(caption.selectionEnd).toBe('Goal Manchester City'.length);
    expect(caption.value.slice(caption.selectionStart)).toBe(' by Etihad Stadium end');
  });

  it('puts the caret after a {variable} that was expanded right before it', async () => {
    const caption = await expandWithCaretAt('Goal =t1= by {location}'.length);

    expect(caption.value.slice(0, caption.selectionStart)).toBe(
      'Goal Manchester City by Etihad Stadium',
    );
    expect(caption.value.slice(caption.selectionStart)).toBe(' end');
  });

  it('puts the caret at the end of the code it was inside', async () => {
    const caption = await expandWithCaretAt('Goal =t'.length);

    expect(caption.value.slice(0, caption.selectionStart)).toBe('Goal Manchester City');
  });

  it('keeps the caret in the text it was in when nothing was expanded there', async () => {
    const before = await expandWithCaretAt(2);
    expect(before.selectionStart).toBe(2);
  });

  it('maps a caret in untouched text after the expansions through them', async () => {
    const after = await expandWithCaretAt('Goal =t1= by {location} e'.length);
    expect(after.value.slice(0, after.selectionStart)).toBe(
      'Goal Manchester City by Etihad Stadium e',
    );
    expect(after.value.slice(after.selectionStart)).toBe('nd');
  });

  it('leaves a selection as a selection', async () => {
    const { user } = await renderApp(standardDisk(), [FIRST]);
    const caption = await startEmpty(user);
    await user.paste(PASTED);
    // " by " between the code and the variable.
    caption.setSelectionRange('Goal =t1='.length, 'Goal =t1= by '.length);
    await user.keyboard('{Control>} {/Control}');
    await waitFor(() => expect(caption.value).toBe(EXPANDED));

    expect(caption.value.slice(caption.selectionStart, caption.selectionEnd)).toBe(' by ');
  });
});
