import { api } from './api';

/**
 * Frontend crash log: uncaught errors and unhandled rejections are appended
 * to `<app log dir>/crash-YYYY-MM-DD.log` by the backend (`append_crash_log`).
 * The backend owns the path, so it is never relative to the process cwd and
 * never routed through a remote SSH session. Capped per session here and per
 * file on the backend, so a crash loop cannot fill the disk.
 */

const MAX_LOG_SIZE = 50 * 1024; // 50 KB max per session
let loggedBytes = 0;

function formatEntry(type: string, error: unknown): string {
  const time = new Date().toISOString();
  const message =
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return `[${time}] ${type}: ${message}\n---\n`;
}

async function appendLog(entry: string): Promise<void> {
  if (loggedBytes >= MAX_LOG_SIZE) return;
  loggedBytes += entry.length;
  try {
    await api.appendCrashLog(entry);
  } catch {
    // Can't log — don't cascade
  }
}

export function installCrashHandler(): void {
  window.addEventListener('error', (event) => {
    void appendLog(formatEntry('UNCAUGHT', event.error ?? event.message));
  });

  window.addEventListener('unhandledrejection', (event) => {
    void appendLog(formatEntry('UNHANDLED_REJECTION', event.reason));
  });
}
