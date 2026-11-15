import { Menu } from 'electron';
import { applicationMenuTemplate, type HelpActions } from './menu-template';

export function installApplicationMenu(help: HelpActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform, help)));
}
