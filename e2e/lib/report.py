"""Check results for one E2E job: JSON for the aggregate step, Markdown for
$GITHUB_STEP_SUMMARY. Status is one of PASS, FAIL, PARTIAL, MANUAL. A check
whose verification is incomplete by design must use PARTIAL, never PASS."""
import json
import os
import pathlib
import time
import traceback

STATUSES = ("PASS", "FAIL", "PARTIAL", "MANUAL")

# The must-pass matrix: id -> title. Every job reports the ids it covers.
CHECKS = {
    "one-process-focus": "Same folder twice: one app process, its window focused",
    "two-windows": "Two folders: two windows",
    "empty-reuse": "Empty window (Ctrl/Cmd+Shift+N) reused by `sparkdown C`",
    "window-menu": "Window menu: one entry per open window",
    "mcp-isolation": "Per-window MCP routing (agent tools see only their folder)",
    "quit-prompt": "Quit: one prompt lists the running job and unsaved changes; Cancel keeps everything",
    "quit-prompt-menu": "Quit from the app menu: same single prompt; Cancel keeps everything",
    "quit-prompt-bg-occluded": "Quit from A after B (running job) sat 45 s in the background (hidden behind A on macOS): prompt still names B's job",
    "quit-prompt-bg-occluded-menu": "Same, quitting from the app menu",
    "quit-prompt-bg-minimized": "Same, with B minimized",
    "cli-forward-keeps-b": "`sparkdown <A>` from another app with A and B open: one process, A focused, B's webview still shows B (frontend root + rendered text)",
    "must-pass-3": "0.4.0 step 3 (Paulo's setup): split B with sleep, agent-like job in A, A unsaved, physical ⌘Q: combined prompt; with tmux, a real Quit leaves the sleep running",
    "must-pass-3-relaunched": "Step 3 after a relaunch (windows and B's split reattached to the surviving tmux sessions): physical ⌘Q still lists the sleep",
    "tmux-split-pane": "B's tmux window split (idle pane active, sleep in the other pane): quit prompt still lists sleep",
    "tmux-transient-failure": "B's tmux session briefly unresolvable (transient failure) while sleep runs: B's tab survives, quit prompt still lists sleep",
    "quit-prompt-probe-timeout": "Job check can't finish (tmux server wedged): quit still prompts, says it couldn't check, Cancel keeps everything",
    "red-close": "Closing one window closes only that window",
    "dock-reopen": "Dock click with no visible window brings a window back",
    "restore": "Clean quit + relaunch restores the open windows (a closed one stays closed)",
    "webview-content": "Web content (WebDriver): sidebar folder, editor text, unsaved marker",
}


class Report:
    def __init__(self, os_name, out_dir):
        self.os = os_name
        self.out = pathlib.Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.checks = []
        self.t0 = time.time()
        self.log_f = open(self.out / "e2e.log", "a", encoding="utf-8")

    def log(self, *a):
        s = " ".join(str(x) for x in a)
        stamp = time.strftime("%H:%M:%S")
        print(f"[{stamp}] {s}", flush=True)
        self.log_f.write(f"[{stamp}] {s}\n")
        self.log_f.flush()

    def add(self, cid, status, detail="", title=None):
        assert status in STATUSES, status
        title = title or CHECKS.get(cid, cid)
        self.checks.append({"id": cid, "title": title, "status": status, "detail": detail})
        self.log(f"CHECK {cid}: {status} — {detail}")

    def manual(self, cid, title, why):
        self.add(cid, "MANUAL", why, title=title)

    def run(self, cid, fn, title=None):
        """fn() returns (status, detail). An exception is a FAIL with the trace."""
        self.log(f"--- {cid}")
        try:
            status, detail = fn()
        except Exception as e:  # noqa: BLE001 - every error is a failed check
            status, detail = "FAIL", f"{type(e).__name__}: {e}"
            self.log(traceback.format_exc())
        self.add(cid, status, detail, title=title)
        return status

    def write(self):
        counts = {s: sum(1 for c in self.checks if c["status"] == s) for s in STATUSES}
        data = {"os": self.os, "seconds": round(time.time() - self.t0), "counts": counts, "checks": self.checks}
        (self.out / "results.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
        md = [f"### E2E — {self.os}", "", "| Check | Status | Detail |", "|---|---|---|"]
        for c in self.checks:
            d = c["detail"].replace("|", "\\|").replace("\n", " ")
            md.append(f"| {c['title']} | **{c['status']}** | {d} |")
        md += ["", " · ".join(f"{k}: {v}" for k, v in counts.items()), ""]
        (self.out / "summary.md").write_text("\n".join(md) + "\n", encoding="utf-8")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary and os.path.exists(os.path.dirname(summary) or "."):
            with open(summary, "a", encoding="utf-8") as f:
                f.write("\n".join(md) + "\n")
        print("\n".join(md))
        return counts["FAIL"]
