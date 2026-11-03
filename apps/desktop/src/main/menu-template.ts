import type { MenuItemConstructorOptions } from 'electron';

/**
 * The application menu: Electron's default one without the View menu's zoom entries. Those bind
 * Ctrl/Cmd+0, +, - and = to page zoom, which would scale the whole UI and collide with the photo
 * view's own zoom (Ctrl/Cmd + and -) and the colour class clear (Ctrl/Cmd+0). The roles that stay
 * keep their usual shortcuts (copy and paste in the caption fields, reload, DevTools, full screen).
 */
export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  return [
    ...(mac ? [{ role: 'appMenu' } as const] : [{ role: 'fileMenu' } as const]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}
