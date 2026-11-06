//! PTY output transport: pty → coalesced byte batches → one Tauri Channel per
//! terminal, with credit-based flow control from xterm.js.
//!
//! Before this module each pty `read` (≤ 8 KiB) became its own
//! `terminal://data {id, chunk}` event: a JSON-escaped string `eval`'d into
//! the webview, routed to every pane's listener, with no backpressure. A
//! flood (`cat` of a big file) queued output in the webview as fast as the pty
//! could produce it.
//!
//! Now:
//!   - a reader thread reads the pty (64 KiB buffer), keeps UTF-8 sequences
//!     whole across reads (`decode_pty_utf8`, unchanged), and hands the bytes
//!     to a bounded queue;
//!   - a sender thread drains the queue, concatenating whatever is already
//!     waiting (up to [`MAX_BATCH`]) into one message, and sends it as raw
//!     bytes over the terminal's own `Channel` (an ArrayBuffer in JS: no JSON
//!     escaping, and only this pane receives it);
//!   - the frontend acks each message once xterm.js has parsed it
//!     (`terminal_ack`). The sender stops sending while more than
//!     [`HIGH_WATER`] bytes are unacked, the queue fills, the reader stops
//!     reading, and the kernel pty buffer pushes back on the program that is
//!     writing — the backpressure a real terminal applies.
//!
//! Latency: nothing waits on a timer. A lone keystroke echo is read, queued,
//! and sent immediately; batches only form while a send is already in
//! progress or the window is full.
//!
//! Safety valve: if acks stop arriving for [`STALL_TIMEOUT`] (webview gone,
//! frontend wedged), the flow goes unmetered until the next ack, so a pty is
//! never frozen by a lost ack. Closing/replacing the terminal releases a
//! waiting sender at once.

use std::io::Read;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// pty read size. Bigger than the old 8 KiB so a flood needs fewer reads;
/// a read returns whatever is available, so small output is not delayed.
pub(crate) const READ_BUF: usize = 64 * 1024;
/// Most bytes concatenated into one Channel message.
pub(crate) const MAX_BATCH: usize = 256 * 1024;
/// Unacked bytes allowed in the webview before the sender waits.
pub(crate) const HIGH_WATER: u64 = 1024 * 1024;
/// Reads that may wait between the reader and sender threads.
pub(crate) const QUEUE_DEPTH: usize = 16;
/// No ack for this long while waiting: stop metering until one arrives.
pub(crate) const STALL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct FlowState {
    in_flight: u64,
    closed: bool,
    /// Set after a stall; cleared by the next ack.
    unmetered: bool,
}

/// Credit counter shared by a terminal's sender thread and `terminal_ack`.
#[derive(Default)]
pub(crate) struct OutputFlow {
    state: Mutex<FlowState>,
    cv: Condvar,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Window {
    /// Below the high-water mark (or unmetered): send.
    Open,
    /// The terminal was closed or replaced: drop output.
    Closed,
}

impl OutputFlow {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Record `n` bytes handed to the webview.
    pub(crate) fn sent(&self, n: usize) {
        if let Ok(mut s) = self.state.lock() {
            s.in_flight = s.in_flight.saturating_add(n as u64);
        }
    }

    /// The frontend has parsed `n` more bytes.
    pub(crate) fn ack(&self, n: u64) {
        if let Ok(mut s) = self.state.lock() {
            s.in_flight = s.in_flight.saturating_sub(n);
            s.unmetered = false;
        }
        self.cv.notify_all();
    }

    /// Terminal closed/replaced: release a waiting sender for good.
    pub(crate) fn close(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.closed = true;
        }
        self.cv.notify_all();
    }

    #[cfg(test)]
    pub(crate) fn in_flight(&self) -> u64 {
        self.state.lock().map(|s| s.in_flight).unwrap_or(0)
    }

    /// Block until fewer than `high` bytes are unacked, the flow is closed,
    /// or no ack arrived for `stall` (then: unmetered until the next ack).
    pub(crate) fn wait_open(&self, high: u64, stall: Duration) -> Window {
        let Ok(mut s) = self.state.lock() else {
            return Window::Open;
        };
        let mut deadline = Instant::now() + stall;
        let mut last = s.in_flight;
        loop {
            if s.closed {
                return Window::Closed;
            }
            if s.unmetered || s.in_flight < high {
                return Window::Open;
            }
            let now = Instant::now();
            if s.in_flight < last {
                // An ack made progress but not enough: restart the stall clock.
                last = s.in_flight;
                deadline = now + stall;
            }
            if now >= deadline {
                s.unmetered = true;
                return Window::Open;
            }
            s = match self.cv.wait_timeout(s, deadline - now) {
                Ok((g, _)) => g,
                Err(_) => return Window::Open,
            };
        }
    }
}

/// Closes the flow when the owning `Terminal` is dropped (close, replace,
/// window teardown), so a sender waiting for acks exits immediately.
pub(crate) struct FlowCloser(pub(crate) Arc<OutputFlow>);

impl Drop for FlowCloser {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Reader half: read `reader` until EOF/error, pass whole-UTF-8 byte runs to
/// `tx`. Returns when the pty ends or the sender side has gone.
pub(crate) fn read_loop(mut reader: impl Read, tx: SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; READ_BUF];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                // Only whole characters cross: an incomplete trailing
                // sequence waits for the next read (see decode_pty_utf8).
                let text = crate::terminal::decode_pty_utf8(&mut pending, false);
                if !text.is_empty() && tx.send(text.into_bytes()).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    // EOF: an interrupted multibyte tail becomes U+FFFD rather than vanishing.
    let text = crate::terminal::decode_pty_utf8(&mut pending, true);
    if !text.is_empty() {
        let _ = tx.send(text.into_bytes());
    }
}

/// Sender half: coalesce queued reads into batches of at most `max_batch`
/// bytes (a single larger read is sent whole), wait for flow-control credit,
/// and hand each batch to `send`. `send` returning false (channel gone)
/// stops forwarding but keeps draining so the reader never blocks forever.
pub(crate) fn send_loop(
    rx: Receiver<Vec<u8>>,
    flow: &OutputFlow,
    max_batch: usize,
    high: u64,
    stall: Duration,
    mut send: impl FnMut(Vec<u8>) -> bool,
) {
    let mut live = true;
    while let Ok(first) = rx.recv() {
        // Wait for credit BEFORE gathering the batch, so output that piles up
        // while the webview catches up leaves as one message.
        if live && flow.wait_open(high, stall) == Window::Closed {
            live = false;
        }
        let mut batch = first;
        let mut more = true;
        while more && batch.len() < max_batch {
            match rx.try_recv() {
                Ok(next) => batch.extend_from_slice(&next),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => more = false,
            }
        }
        if !live {
            continue;
        }
        let n = batch.len();
        if send(batch) {
            flow.sent(n);
        } else {
            live = false;
        }
    }
}

/// Bounded queue between [`read_loop`] and [`send_loop`].
pub(crate) fn queue() -> (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) {
    sync_channel(QUEUE_DEPTH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A reader that returns its data in fixed-size slices, like a pty.
    struct Sliced {
        data: Vec<u8>,
        pos: usize,
        step: usize,
    }
    impl Read for Sliced {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let n = self.step.min(out.len()).min(self.data.len() - self.pos);
            out[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    fn mixed_payload(len: usize) -> Vec<u8> {
        // ASCII, 2-, 3- and 4-byte sequences, and escape codes.
        let unit = "ab ❯ ⏺ é 😀 \x1b[31mred\x1b[0m ━━ ⠋\r\n";
        let mut s = String::new();
        while s.len() < len {
            s.push_str(unit);
        }
        s.into_bytes()
    }

    fn run(data: Vec<u8>, step: usize, max_batch: usize) -> Vec<Vec<u8>> {
        let (tx, rx) = queue();
        let r = std::thread::spawn(move || read_loop(Sliced { data, pos: 0, step }, tx));
        let flow = OutputFlow::new();
        let mut got = Vec::new();
        send_loop(rx, &flow, max_batch, u64::MAX, STALL_TIMEOUT, |b| {
            got.push(b);
            true
        });
        r.join().unwrap();
        got
    }

    #[test]
    fn byte_exact_for_valid_utf8_at_every_split() {
        let data = mixed_payload(20_000);
        // Primes and 1 force splits inside every multibyte width.
        for step in [1, 2, 3, 5, 7, 4093, 65536] {
            let got = run(data.clone(), step, MAX_BATCH);
            let joined: Vec<u8> = got.concat();
            assert_eq!(joined, data, "step {step}");
            for b in &got {
                assert!(
                    std::str::from_utf8(b).is_ok(),
                    "batch split a char (step {step})"
                );
            }
        }
    }

    #[test]
    fn invalid_bytes_become_replacement_chars_as_before() {
        let data = b"ok\xFFgo\xE2\x9D".to_vec(); // bad byte, then truncated tail at EOF
        let got = run(data, 1, MAX_BATCH).concat();
        assert_eq!(String::from_utf8(got).unwrap(), "ok\u{FFFD}go\u{FFFD}");
    }

    #[test]
    fn batches_respect_max_unless_one_read_is_bigger() {
        let data = mixed_payload(300_000);
        let got = run(data.clone(), 4096, 32 * 1024);
        assert_eq!(got.concat(), data);
        for b in &got {
            // A batch only exceeds the cap by at most one queued read.
            assert!(b.len() < 32 * 1024 + 4096, "{}", b.len());
        }
    }

    #[test]
    fn sender_waits_for_acks_and_resumes() {
        let flow = OutputFlow::new();
        let (tx, rx) = queue();
        let sent = Arc::new(AtomicUsize::new(0));
        let (f2, s2) = (flow.clone(), sent.clone());
        let h = std::thread::spawn(move || {
            send_loop(rx, &f2, 10, 25, Duration::from_secs(30), |b| {
                s2.fetch_add(b.len(), Ordering::SeqCst);
                true
            })
        });
        for _ in 0..5 {
            tx.send(vec![b'x'; 10]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(100));
        // 3 sends of 10 reach in_flight=30 ≥ 25: the 4th waits.
        assert_eq!(sent.load(Ordering::SeqCst), 30);
        assert_eq!(flow.in_flight(), 30);
        flow.ack(30);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(sent.load(Ordering::SeqCst), 50);
        drop(tx);
        h.join().unwrap();
    }

    #[test]
    fn close_releases_a_waiting_sender_and_drops_output() {
        let flow = OutputFlow::new();
        flow.sent(100);
        let (tx, rx) = queue();
        let f2 = flow.clone();
        let sent = Arc::new(AtomicUsize::new(0));
        let s2 = sent.clone();
        let h = std::thread::spawn(move || {
            send_loop(rx, &f2, 10, 50, Duration::from_secs(30), |b| {
                s2.fetch_add(b.len(), Ordering::SeqCst);
                true
            })
        });
        tx.send(b"late".to_vec()).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        drop(FlowCloser(flow.clone()));
        tx.send(b"later".to_vec()).unwrap();
        drop(tx);
        h.join().unwrap();
        assert_eq!(sent.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stalled_acks_do_not_freeze_the_pty() {
        let flow = OutputFlow::new();
        flow.sent(100);
        let t = Instant::now();
        assert_eq!(flow.wait_open(50, Duration::from_millis(50)), Window::Open);
        assert!(t.elapsed() >= Duration::from_millis(50));
        // Unmetered until an ack arrives …
        assert_eq!(flow.wait_open(50, Duration::from_secs(30)), Window::Open);
        // … then metered again.
        flow.ack(10);
        let t = Instant::now();
        assert_eq!(flow.wait_open(50, Duration::from_millis(30)), Window::Open);
        assert!(t.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn a_dead_channel_keeps_draining_so_the_reader_never_blocks() {
        let data = mixed_payload(2_000_000); // far more than the queue holds
        let (tx, rx) = queue();
        let r = std::thread::spawn(move || {
            read_loop(
                Sliced {
                    data,
                    pos: 0,
                    step: 4096,
                },
                tx,
            )
        });
        let flow = OutputFlow::new();
        let mut calls = 0;
        send_loop(rx, &flow, MAX_BATCH, HIGH_WATER, STALL_TIMEOUT, |_| {
            calls += 1;
            false
        });
        r.join().unwrap();
        assert_eq!(calls, 1);
    }
}
