/**
 * Terminal notification detection: BEL, OSC 9, and OSC 777 notify sequences.
 * 
 * When a terminal emits a notification sequence (typically from an agent CLI
 * waiting for input), we show an OS notification if:
 * - The setting is enabled
 * - The window is not focused
 * - Rate limit not exceeded (1 per pane per 10 seconds)
 */

import type { AppConfig } from './api';
import { invoke } from '@tauri-apps/api/core';

const RATE_LIMIT_MS = 10_000; // 10 seconds

interface NotificationRequest {
  message: string;
}

/** Rate limiter: tracks last notification time per pane ID. */
class NotificationRateLimiter {
  private lastNotified = new Map<string, number>();

  /** Returns true if we can notify for this pane (rate limit allows it). */
  canNotify(paneId: string): boolean {
    const now = Date.now();
    const last = this.lastNotified.get(paneId) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return false;
    }
    this.lastNotified.set(paneId, now);
    return true;
  }

  /** For testing: clear the rate limit state. */
  reset(): void {
    this.lastNotified.clear();
  }
}

const rateLimiter = new NotificationRateLimiter();

/**
 * Parse terminal output for notification sequences. Returns the notification
 * message if found, or null if no notification sequence is present.
 * 
 * Supported sequences:
 * - BEL (`\x07`): simple bell, no message
 * - OSC 9 (`ESC]9;<message>BEL` or `ESC]9;<message>ESC\`): iTerm2 notification
 * - OSC 777 notify (`ESC]777;notify;<message>BEL` or `ESC]777;notify;<message>ESC\`):
 *   tmux/terminal-notifier format
 */
export function parseNotification(output: string): NotificationRequest | null {
  // Check for OSC sequences first (they may contain BEL as terminators)
  const ESC = '\x1b';
  const BEL = '\x07';
  let i = 0;
  let foundStandaloneBel = false;

  while (i < output.length) {
    // Look for ESC ]
    if (output[i] === ESC && i + 1 < output.length && output[i + 1] === ']') {
      i += 2;
      const start = i;
      
      // Find the terminator (BEL or ST = ESC \)
      let end = i;
      let terminated = false;
      while (end < output.length) {
        if (output[end] === BEL) {
          terminated = true;
          break;
        } else if (output[end] === ESC && end + 1 < output.length && output[end + 1] === '\\') {
          terminated = true;
          break;
        }
        end++;
      }
      
      if (!terminated) {
        i = end;
        continue;
      }

      const oscContent = output.slice(start, end);

      // OSC 9;message
      if (oscContent.startsWith('9;')) {
        return { message: oscContent.slice(2) };
      }

      // OSC 777;notify;message
      if (oscContent.startsWith('777;notify;')) {
        return { message: oscContent.slice(11) };
      }

      i = end + 1;
    } else {
      // Track standalone BEL characters (not part of OSC sequences)
      if (output[i] === BEL && !foundStandaloneBel) {
        foundStandaloneBel = true;
      }
      i++;
    }
  }

  // Return standalone BEL only if no OSC notification was found
  if (foundStandaloneBel) {
    return { message: '' };
  }

  return null;
}

/**
 * Handle terminal output that may contain notification sequences.
 * Shows an OS notification if all conditions are met:
 * - Setting is enabled
 * - Window is not focused
 * - Rate limit not exceeded
 * 
 * @param output Terminal output text to scan
 * @param paneId Unique pane identifier (for rate limiting)
 * @param paneTitle Pane title to show in notification
 * @param config App configuration
 * @param isWindowFocused Whether the SparkDown window currently has focus
 */
export async function handleTerminalNotification(
  output: string,
  paneId: string,
  paneTitle: string,
  config: AppConfig,
  isWindowFocused: boolean,
): Promise<void> {
  // Check if notifications are enabled
  if (!config.terminal_notify) {
    return;
  }

  // Only notify when window is not focused
  if (isWindowFocused) {
    return;
  }

  // Parse the output for notification sequences
  const notif = parseNotification(output);
  if (!notif) {
    return;
  }

  // Check rate limit
  if (!rateLimiter.canNotify(paneId)) {
    return;
  }

  // Send the notification via backend
  try {
    await invoke('terminal_notify', {
      paneId,
      title: paneTitle,
      message: notif.message,
    });
  } catch (err) {
    console.error('Failed to send terminal notification:', err);
  }
}

/** For testing: reset rate limiter state. */
export function resetNotificationRateLimiter(): void {
  rateLimiter.reset();
}
