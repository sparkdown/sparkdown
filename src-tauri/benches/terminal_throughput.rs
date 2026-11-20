// Throughput comparison: new binary Channel path vs old string event path.
//
// This measures the serialization + formatting overhead of processing terminal
// output for IPC. The actual IPC and webview rendering are not included, but
// flow control and UTF-8 handling are tested in unit tests (terminal_stream.rs).

use std::time::Instant;

fn main() {
    // Realistic terminal output: mix of text, escape codes, UTF-8.
    let payload = "Running tests... \x1b[32m✓\x1b[0m test_one\r\n\x1b[32m✓\x1b[0m test_two 😀 ❯\r\n";
    let size = 100 * 1024 * 1024; // 100 MiB of data

    println!("Terminal throughput benchmark: {} MiB of terminal output", size / (1024 * 1024));
    println!("Unit payload: {} bytes\n", payload.len());

    let iterations = size / payload.len();
    let payload_bytes = payload.as_bytes();

    // Old path: JSON serialization with string escaping
    println!("Old path (JSON string events with escape overhead):");
    let mut old_times = Vec::new();
    for run in 1..=3 {
        let start = Instant::now();
        let mut total_sent = 0;
        for _ in 0..iterations {
            // Simulate the old terminal://data event: JSON with escaped content
            let escaped = payload
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\r', "\\r")
                .replace('\n', "\\n")
                .replace('\t', "\\t")
                .replace('\x1b', "\\u001b");
            let json = format!(r#"{{"id":"term-1","chunk":"{}"}}"#, escaped);
            total_sent += json.len();
        }
        let elapsed = start.elapsed().as_secs_f64();
        let mbps = (total_sent as f64 / elapsed) / (1024.0 * 1024.0);
        println!("  Run {}: {:.2}s, {:.1} MiB/s ({} bytes total)", run, elapsed, mbps, total_sent);
        old_times.push((elapsed, mbps));
    }

    // New path: raw bytes (no JSON wrapper, no escaping)
    println!("\nNew path (binary Channel, raw UTF-8 bytes):");
    let mut new_times = Vec::new();
    for run in 1..=3 {
        let start = Instant::now();
        let mut batches = Vec::new();
        // Simulate batching: collect into 64KB chunks like the real code does
        let batch_size = 64 * 1024;
        let mut current_batch = Vec::with_capacity(batch_size);
        for _ in 0..iterations {
            if current_batch.len() + payload_bytes.len() > batch_size {
                batches.push(current_batch);
                current_batch = Vec::with_capacity(batch_size);
            }
            current_batch.extend_from_slice(payload_bytes);
        }
        if !current_batch.is_empty() {
            batches.push(current_batch);
        }
        let total_sent: usize = batches.iter().map(|b| b.len()).sum();
        let elapsed = start.elapsed().as_secs_f64();
        let mbps = (total_sent as f64 / elapsed) / (1024.0 * 1024.0);
        println!("  Run {}: {:.2}s, {:.1} MiB/s ({} bytes in {} batches)", 
                 run, elapsed, mbps, total_sent, batches.len());
        new_times.push((elapsed, mbps));
    }

    // Calculate medians
    old_times.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    new_times.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let (old_median_time, old_median_mbps) = old_times[1];
    let (new_median_time, new_median_mbps) = new_times[1];

    println!("\nMedian results (100 MiB):");
    println!("  Old (JSON events): {:.2}s at {:.1} MiB/s", old_median_time, old_median_mbps);
    println!("  New (binary Channel): {:.2}s at {:.1} MiB/s", new_median_time, new_median_mbps);
    println!("  Speedup: {:.2}x", old_median_time / new_median_time);
    println!("\nNote: This measures formatting/serialization overhead only.");
    println!("Flow control, UTF-8 handling, and threading are tested in unit tests.");
}
