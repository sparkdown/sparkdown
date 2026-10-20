"""Aggregate every job's results.json into one table (step summary + file).
Usage: python3 e2e/aggregate.py RESULTS_DIR"""
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent / "lib"))
from report import CHECKS  # noqa: E402

root = pathlib.Path(sys.argv[1])
runs = []
for p in sorted(root.rglob("results.json")):
    runs.append(json.loads(p.read_text(encoding="utf-8")))
order = ["macOS · tmux off", "macOS · tmux on", "Windows · tmux off",
         "Ubuntu (X11, WebKitWebDriver) · tmux off", "Ubuntu (X11, WebKitWebDriver) · tmux on",
         "Arch + Hyprland (vkms) · tmux off", "Arch + Hyprland (vkms) · tmux on"]
runs.sort(key=lambda r: order.index(r["os"]) if r["os"] in order else 99)
ids = list(CHECKS)
extra = []
for r in runs:
    for c in r["checks"]:
        if c["id"] not in ids and c["id"] not in extra:
            extra.append(c["id"])
titles = dict(CHECKS)
for r in runs:
    for c in r["checks"]:
        titles.setdefault(c["id"], c["title"])
md = ["## E2E multi-window must-pass — all OSes", "",
      "| Check | " + " | ".join(r["os"] for r in runs) + " |",
      "|---|" + "---|" * len(runs)]
fails = 0
for cid in ids + extra:
    cells = []
    seen = False
    for r in runs:
        c = next((c for c in r["checks"] if c["id"] == cid), None)
        if c:
            seen = True
            fails += c["status"] == "FAIL"
        cells.append(f"**{c['status']}**" if c else "n/a")
    if seen:
        md.append(f"| {titles[cid]} | " + " | ".join(cells) + " |")
md += ["", "| Totals | " + " | ".join(
    " · ".join(f"{k} {v}" for k, v in r["counts"].items() if v) + f" ({r['seconds']}s)" for r in runs) + " |", ""]
missing = [o for o in order if o not in [r["os"] for r in runs]]
if missing:
    md.append(f"**Missing results (job failed before reporting): {', '.join(missing)}**")
    fails += len(missing)
text = "\n".join(md) + "\n"
(root / "summary.md").write_text(text, encoding="utf-8")
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
        f.write(text)
print(text)
sys.exit(1 if fails else 0)
