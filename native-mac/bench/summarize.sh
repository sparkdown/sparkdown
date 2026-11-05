#!/usr/bin/env bash
# summarize.sh <results dir>: median and range per metric from runs.csv.
OUT="$1"; CSV="$OUT/runs.csv"
stat() { # stat <app> <scenario> <cold> <col>
  awk -F, -v a="$1" -v s="$2" -v c="$3" -v k="$4" 'NR>1 && $1==a && $2==s && $3>0 && (c=="*" || $4==c) && $k!="" {print $k}' "$CSV" \
  | sort -n | awk '{v[NR]=$1} END { if (NR==0) {print "n/a"; exit}
      m = (NR%2) ? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2
      printf "%s (%s–%s, n=%d)", m, v[1], v[NR], NR }'
}
size() { awk -F, -v a="$1" -v k="$2" '$1==a {if ($k=="") print "n/a"; else printf "%.1f MB", $k/1048576}' "$OUT/sizes.csv"; }
echo "| Metric | Tauri 0.4.1 | Native spike |"
echo "|---|---|---|"
echo "| .app bundle size | $(size tauri 2) | $(size native 2) |"
echo "| .dmg size | $(size tauri 3) | $(size native 3) |"
echo "| Cold start → first window (ms) | $(stat tauri start 1 5) | $(stat native start 1 5) |"
echo "| Cold start → terminal shell ready (ms) | $(stat tauri start 1 6) | $(stat native start 1 6) |"
echo "| Warm start → first window (ms) | $(stat tauri start 0 5) | $(stat native start 0 5) |"
echo "| Warm start → terminal shell ready (ms) | $(stat tauri start 0 6) | $(stat native start 0 6) |"
echo "| Idle RAM, no folder (MB) | $(stat tauri idle '*' 7) | $(stat native idle '*' 7) |"
echo "| RAM, 1 folder + 5 tabs + 2 terminals (MB) | $(stat tauri loaded '*' 7) | $(stat native loaded '*' 7) |"
echo "| cat 100 MB, until the terminal has parsed it all (s) | $(stat tauri cat '*' 8) | $(stat native cat '*' 8) |"
