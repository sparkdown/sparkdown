import './styles/main.css';
import '@xterm/xterm/css/xterm.css';
import { App } from './app';
import { installCrashHandler } from './crash-log';
import { installRemoteSessions } from './remote';

installCrashHandler();

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  // Registers App's remote handler; its UI attaches when init() is done.
  installRemoteSessions(app);
  void app.init();
});
