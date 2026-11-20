// Throughput comparison: new binary Channel path vs old string event path.
//
// This measures end-to-end IPC throughput through the batching + ack cycle,
// not in-app terminal rendering (which requires a running webview).
//
// Since this is a benchmark for a binary crate without a library target,
// we simulate the key parts of both paths here.

use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

/// A reader that produces a fixed payload repeatedly until `size` bytes.
struct RepeatingReader {
    payload: Vec<u8>,
    pos: usize,
    remaining: usize,
}

impl RepeatingReader {
    fn new(payload: Vec<u8>, size: usize) -> Self {
        Self {
            payload,
            pos: 0,
            remaining: size,
        }
    }
}

impl Read for RepeatingReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let chunk = out.len().min(self.remaining).min(self.payload.len() - self.pos);
        out[..chunk].copy_from_slice(&self.payload[self.pos..self.pos + chunk]);
        self.pos += chunk;
        if self.pos >= self.payload.len() {
            self.pos = 0;
        }
        self.remaining -= chunk;
        Ok(chunk)
    }
}

/// Simplified UTF-8 decoder (matches terminal.rs decode_pty_utf8).
fn decode_utf8(pending: &mut Vec<u8>, flush: bool) -> String {
    let mut out = String::new();
    loop {
        if pending.is_empty() {
            break;
        }
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                break;
            }
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                if valid_up_to > 0 {
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&pending[..valid_up_to]) });
                    pending.drain(..valid_up_to);
                }
                let err_len = e.error_len();
                if let Some(bad_len) = err_len {
                    out.push('\u{FFFD}');
                    pending.drain(..bad_len);
                } else if flush {
                    out.push('\u{FFFD}');
                    pending.clear();
                    break;
                } else {
                    break;
                }
            }
        }
    }
    out
}

/// Simulate the old path: JSON-escape the string, emit an event (no-op send).
fn old_path_throughput(data: &[u8], total_size: usize) -> (f64, usize) {
    let start = Instant::now();
    let mut sent = 0;
    let mut pending: Vec<u8> = Vec::new();
    let mut reader = RepeatingReader::new(data.to_vec(), total_size);
    let mut buf = vec![0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let text = decode_utf8(&mut pending, false);
                if !text.is_empty() {
                    // Simulate JSON serialization cost
                    let json = format!(r#"{{"id":"term-1","chunk":"{}"}}"#, text.replace('\\', "\\\\").replace('"', "\\\""));
                    sent += json.len();
                }
            }
            Err(_) => break,
        }
    }
    let text = decode_utf8(&mut pending, true);
    if !text.is_empty() {
        let json = format!(r#"{{"id":"term-1","chunk":"{}"}}"#, text.replace('\\', "\\\\").replace('"', "\\\""));
        sent += json.len();
    }
    let elapsed = start.elapsed().as_secs_f64();
    (elapsed, sent)
}

/// Flow control state.
#[derive(Default)]
struct FlowState {
    in_flight: u64,
}

struct OutputFlow {
    state: Mutex<FlowState>,
    cv: Condvar,
}

impl OutputFlow {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FlowState::default()),
            cv: Condvar::new(),
        })
    }

    fn sent(&self, n: usize) {
        if let Ok(mut s) = self.state.lock() {
            s.in_flight += n as u64;
        }
    }

    fn ack(&self, n: u64) {
        if let Ok(mut s) = self.state.lock() {
            s.in_flight = s.in_flight.saturating_sub(n);
        }
        self.cv.notify_all();
    }

    fn wait_open(&self, high: u64) {
        let Ok(mut s) = self.state.lock() else { return };
        while s.in_flight >= high {
            s = self.cv.wait(s).unwrap();
        }
    }
}

/// Reader loop: read + decode UTF-8 + send to queue.
fn read_loop(mut reader: impl Read, tx: SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let text = decode_utf8(&mut pending, false);
                if !text.is_empty() && tx.send(text.into_bytes()).is_err() {
                    return;
                }
            }
            Err(_) => break,
        }
    }
    let text = decode_utf8(&mut pending, true);
    if !text.is_empty() {
        let _ = tx.send(text.into_bytes());
    }
}

/// Sender loop: batch + flow control + send.
fn send_loop(
    rx: Receiver<Vec<u8>>,
    flow: &OutputFlow,
    max_batch: usize,
    high: u64,
    mut send: impl FnMut(Vec<u8>) -> bool,
) {
    while let Ok(first) = rx.recv() {
        if flow.state.lock().unwrap().in_flight >= high {
            flow.wait_open(high);
        }
        let mut batch = first;
        while batch.len() < max_batch {
            match rx.try_recv() {
                Ok(next) => batch.extend_from_slice(&next),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        let n = batch.len();
        if send(batch) {
            flow.sent(n);
        }
    }
}

/// New path: raw bytes through batching + flow control.
fn new_path_throughput(data: &[u8], total_size: usize) -> (f64, usize) {
    const MAX_BATCH: usize = 256 * 1024;
    const HIGH_WATER: u64 = 1024 * 1024;
    
    let (tx, rx) = sync_channel(16);
    let flow = OutputFlow::new();
    let reader = RepeatingReader::new(data.to_vec(), total_size);
    let sent = Arc::new(AtomicU64::new(0));
    let s2 = sent.clone();
    let f2 = flow.clone();
    
    let start = Instant::now();
    let r = std::thread::spawn(move || read_loop(reader, tx));
    let sender = std::thread::spawn(move || {
        send_loop(rx, &f2, MAX_BATCH, HIGH_WATER, |bytes| {
            let n = bytes.len();
            s2.fetch_add(n as u64, Ordering::Relaxed);
            // Simulate ack (10% of bytes sent).
            if n > 10 {
                f2.ack((n / 10) as u64);
            }
            true
        })
    });
    r.join().unwrap();
    sender.join().unwrap();
    let elapsed = start.elapsed().as_secs_f64();
    (elapsed, sent.load(Ordering::Relaxed) as usize)
}

fn main() {
    // Realistic terminal output: mix of text, escape codes, UTF-8.
    let payload = "Running tests... \x1b[32m✓\x1b[0m test_one\r\n\x1b[32m✓\x1b[0m test_two 😀 ❯\r\n";
    let payload_bytes = payload.as_bytes();
    let size = 100 * 1024 * 1024; // 100 MiB

    println!("Terminal throughput benchmark: processing {} MiB", size / (1024 * 1024));
    println!("Payload: {} bytes per unit\n", payload_bytes.len());

    // Warmup
    let _ = old_path_throughput(payload_bytes, size);
    let _ = new_path_throughput(payload_bytes, size);

    // Old path (3 runs)
    println!("Old path (JSON string events):");
    let mut old_times = Vec::new();
    for run in 1..=3 {
        let (elapsed, sent) = old_path_throughput(payload_bytes, size);
        let mbps = (sent as f64 / elapsed) / (1024.0 * 1024.0);
        println!("  Run {}: {:.2}s, {:.1} MiB/s ({} bytes sent)", run, elapsed, mbps, sent);
        old_times.push(elapsed);
    }
    old_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let old_median = old_times[1];

    println!("\nNew path (binary Channel with flow control):");
    let mut new_times = Vec::new();
    for run in 1..=3 {
        let (elapsed, sent) = new_path_throughput(payload_bytes, size);
        let mbps = (sent as f64 / elapsed) / (1024.0 * 1024.0);
        println!("  Run {}: {:.2}s, {:.1} MiB/s ({} bytes sent)", run, elapsed, mbps, sent);
        new_times.push(elapsed);
    }
    new_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let new_median = new_times[1];

    println!("\nMedian times:");
    println!("  Old: {:.2}s", old_median);
    println!("  New: {:.2}s", new_median);
    println!("  Speedup: {:.2}x", old_median / new_median);
}
