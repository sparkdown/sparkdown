//! Terminal notification parsing: BEL, OSC 9, and OSC 777 notify sequences.
//!
//! Agent CLIs like Claude Code and Codex emit these to signal "I'm waiting for
//! input". SparkDown shows an OS notification (when the window is unfocused) so
//! the user knows to return to the terminal.

/// A notification request parsed from terminal output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalNotification {
    /// Notification body text. Empty for BEL (use default message).
    pub message: String,
}

/// Parse terminal output for notification sequences. Returns Some with the
/// extracted message, or None if no notification sequence is found.
///
/// Supported sequences:
/// - BEL (`\x07`): simple bell, no message
/// - OSC 9 (`\x1b]9;<message>\x07` or `\x1b]9;<message>\x1b\\`): iTerm2 notification
/// - OSC 777 notify (`\x1b]777;notify;<message>\x07` or `\x1b]777;notify;<message>\x1b\\`):
///   tmux/terminal-notifier format
///
/// Only the first match is returned (agents typically send one per prompt).
pub fn parse_notification(output: &str) -> Option<TerminalNotification> {
    // BEL character: simplest form, no message
    if output.contains('\x07') {
        return Some(TerminalNotification {
            message: String::new(),
        });
    }

    // OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\
    // We look for OSC 9 and OSC 777;notify
    let bytes = output.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Look for ESC ] (OSC start)
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b']' {
            i += 2;
            // Parse the OSC content until BEL or ST (ESC \)
            let start = i;
            let mut end = i;
            let mut terminated = false;
            while end < bytes.len() {
                if bytes[end] == 0x07 {
                    terminated = true;
                    break;
                } else if bytes[end] == 0x1b && end + 1 < bytes.len() && bytes[end + 1] == b'\\' {
                    terminated = true;
                    break;
                }
                end += 1;
            }
            if !terminated {
                i = end;
                continue;
            }

            // We have an OSC sequence from start..end
            let osc_content = &bytes[start..end];

            // OSC 9;message
            if osc_content.starts_with(b"9;") {
                let message = String::from_utf8_lossy(&osc_content[2..]).into_owned();
                return Some(TerminalNotification { message });
            }

            // OSC 777;notify;message
            if osc_content.starts_with(b"777;notify;") {
                let message = String::from_utf8_lossy(&osc_content[11..]).into_owned();
                return Some(TerminalNotification { message });
            }

            i = end + 1;
        } else {
            i += 1;
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bel_character_triggers_notification() {
        let output = "some text\x07more text";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "");
    }

    #[test]
    fn osc_9_with_bel_terminator() {
        let output = "\x1b]9;Agent waiting for input\x07";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "Agent waiting for input");
    }

    #[test]
    fn osc_9_with_st_terminator() {
        let output = "\x1b]9;Task complete\x1b\\";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "Task complete");
    }

    #[test]
    fn osc_777_notify_with_bel() {
        let output = "\x1b]777;notify;Ready for your response\x07";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "Ready for your response");
    }

    #[test]
    fn osc_777_notify_with_st() {
        let output = "\x1b]777;notify;Waiting\x1b\\";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "Waiting");
    }

    #[test]
    fn no_notification_in_normal_text() {
        assert!(parse_notification("hello world").is_none());
        assert!(parse_notification("ESC ] not really").is_none());
    }

    #[test]
    fn first_notification_wins() {
        let output = "\x1b]9;first\x07\x1b]9;second\x07";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "first");
    }

    #[test]
    fn embedded_in_normal_output() {
        let output = "Starting task...\n\x1b]777;notify;Input needed\x07\nMore output";
        let notif = parse_notification(output).unwrap();
        assert_eq!(notif.message, "Input needed");
    }
}
