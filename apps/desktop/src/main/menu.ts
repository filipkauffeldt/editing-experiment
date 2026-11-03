import { Menu } from 'electron';
import { applicationMenuTemplate } from './menu-template';

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform)));
}
