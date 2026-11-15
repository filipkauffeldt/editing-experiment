import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { placeWindow, readWindowState, writeWindowState, type WindowState } from './window-state';

const DEFAULTS = { width: 1440, height: 900, minWidth: 960, minHeight: 600 };

export interface MainWindowOptions {
  /** Where the size, position and maximised state are kept between runs. */
  stateFile: string;
}

/** Open the main window with a sandboxed, context-isolated renderer. */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const placement = placeWindow(
    readWindowState(options.stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
    DEFAULTS,
  );
  const window = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    ...(placement.x === undefined || placement.y === undefined
      ? {}
      : { x: placement.x, y: placement.y }),
    minWidth: DEFAULTS.minWidth,
    minHeight: DEFAULTS.minHeight,
    backgroundColor: '#161618',
    title: 'Editing Experiment',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Screenshots need the histogram even though CI has only a software rasteriser.
      additionalArguments: process.env.EE_SCREENSHOTS === '1' ? ['--ee-screenshots'] : [],
    },
  });
  if (placement.maximized) window.maximize();
  rememberWindowState(window, options.stateFile);

  // Pinch and Ctrl+wheel zoom the photo (renderer), never the page: a zoomed page would also move
  // every pointer position the photo view reads.
  void window.webContents.setVisualZoomLevelLimits(1, 1);

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return window;
}

/** Saves the window's normal bounds and whether it is maximised, shortly after each change and on close. */
function rememberWindowState(window: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined;
  const save = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const state: WindowState = { ...window.getNormalBounds(), maximized: window.isMaximized() };
    try {
      writeWindowState(file, state);
    } catch (error) {
      console.warn(`Could not save the window state: ${String(error)}`);
    }
  };
  const later = (): void => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on('resize', later);
  window.on('move', later);
  window.on('maximize', later);
  window.on('unmaximize', later);
  // The window is still alive here, so its bounds can be read.
  window.on('close', () => {
    clearTimeout(timer);
    save();
  });
}
