import './styles/main.css';
import '@xterm/xterm/css/xterm.css';
import { App } from './app';
import { installCrashHandler } from './crash-log';
import { installRemoteSessions } from './remote';
import { installAskpassPrompt } from './askpass-prompt';
import { installContextMenuGuard } from './webview-menu';

installCrashHandler();
installContextMenuGuard();

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  // Registers App's remote handler; its UI attaches when init() is done.
  installRemoteSessions(app);
  installAskpassPrompt();
  void app.init();
});
