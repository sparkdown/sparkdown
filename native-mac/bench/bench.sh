#!/usr/bin/env bash
# SparkDown Tauri vs native-spike benchmark. Same method for both apps.
#
#   bench.sh --tauri <SparkDown.app|.dmg> --native <SparkDown Native.app|.dmg> \
#            [--runs 5] [--cat-runs 3] [--cat-mb 100] [--out DIR] [--no-cold]
#
# Each app is launched by its executable with the same env. A per-run
# ZDOTDIR .zshrc stamps when the terminal's shell is ready and (throughput
# runs) times `cat` of a large file inside the terminal. Your real SparkDown
# config is backed up first and restored on exit. Nothing else is touched.
set -o pipefail

RUNS=5; CAT_RUNS=3; CAT_MB=100; OUT=""; COLD=1; TAURI=""; NATIVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tauri) TAURI="$2"; shift 2;;
    --native) NATIVE="$2"; shift 2;;
    --runs) RUNS="$2"; shift 2;;
    --cat-runs) CAT_RUNS="$2"; shift 2;;
    --cat-mb) CAT_MB="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --no-cold) COLD=0; shift;;
    *) echo "unknown arg $1"; exit 2;;
  esac
done
[ -n "$TAURI" ] && [ -n "$NATIVE" ] || { echo "need --tauri and --native"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mkdir -p "${TMPDIR:-/tmp}/sdbench" && cd -P "${TMPDIR:-/tmp}/sdbench" && pwd)"
OUT="${OUT:-$W/results}"; mkdir -p "$OUT" "$W/apps"
CSV="$OUT/runs.csv"; LOG="$OUT/bench.log"
tmo() { local t="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$t" "$@"; }
log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# ---- probe helper -----------------------------------------------------------
PROBE="$W/probe"
if [ ! -x "$PROBE" ] || [ "$HERE/probe.swift" -nt "$PROBE" ]; then
  swiftc -O "$HERE/probe.swift" -o "$PROBE" || { echo "swiftc failed (needs Xcode CLT)"; exit 1; }
fi

# ---- apps -------------------------------------------------------------------
stage() { # stage <app|dmg> <name> -> path of a private copy of the .app
  local src="$1" name="$2"; local dst="$W/apps/$name"
  rm -rf "$dst"; mkdir -p "$dst"
  if [[ "$src" == *.dmg ]]; then
    local mnt; mnt="$(mktemp -d)"
    tmo 120 hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$src" >/dev/null
    cp -R "$mnt"/*.app "$dst/"
    hdiutil detach "$mnt" >/dev/null
  else
    cp -R "$src" "$dst/"
  fi
  xattr -dr com.apple.quarantine "$dst" 2>/dev/null || true
  ls -d "$dst"/*.app | head -1
}
TAURI_APP="$(stage "$TAURI" tauri)"; NATIVE_APP="$(stage "$NATIVE" native)"
exe_of() { echo "$1/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist")"; }
TAURI_EXE="$(exe_of "$TAURI_APP")"; NATIVE_EXE="$(exe_of "$NATIVE_APP")"
log "tauri: $TAURI_APP"; log "native: $NATIVE_APP"

# ---- config backup/restore --------------------------------------------------
AS="$HOME/Library/Application Support"
CFG_DIRS=("$AS/com.sparkdown.editor" "$AS/com.sparkdown.native-spike")
BK="$W/config-backup"; rm -rf "$BK"; mkdir -p "$BK"
for d in "${CFG_DIRS[@]}"; do [ -d "$d" ] && cp -R "$d" "$BK/$(basename "$d")"; done
restore() {
  for exe in "$TAURI_EXE" "$NATIVE_EXE"; do pkill -f "$exe" 2>/dev/null; done
  for d in "${CFG_DIRS[@]}"; do
    rm -rf "$d"
    [ -d "$BK/$(basename "$d")" ] && cp -R "$BK/$(basename "$d")" "$d"
  done
  log "configs restored"
}
trap restore EXIT

if pgrep -f "/SparkDown.app/Contents/MacOS/" >/dev/null; then
  echo "SparkDown is running. Quit it first (the benchmark seeds its config)."; exit 1
fi

# ---- fixture ----------------------------------------------------------------
FX="$W/fixture"
if [ ! -d "$FX/.git" ]; then
  rm -rf "$FX"; mkdir -p "$FX/docs/guide" "$FX/notes"
  for i in $(seq 1 20); do
    { echo "# Document $i"; echo; for p in $(seq 1 40); do
        echo "Paragraph $p of doc $i with **bold**, _italic_, \`code\` and a [link](https://example.com/$p)."; echo; done
      echo '| a | b |'; echo '|---|---|'; echo '| 1 | 2 |'; echo
      echo '```js'; echo 'console.log("hello")'; echo '```'; } > "$FX/docs/doc$i.md"
  done
  cp "$FX/docs/doc1.md" "$FX/README.md"
  for i in 1 2 3; do echo "- [ ] task $i" > "$FX/notes/todo$i.md"; done
  git -C "$FX" init -q && git -C "$FX" add -A && git -C "$FX" -c user.name=b -c user.email=b@b commit -qm init
  echo "changed" >> "$FX/docs/doc2.md"
fi
BIG="$W/big-${CAT_MB}mb.txt"
if [ ! -f "$BIG" ]; then
  log "generating $CAT_MB MB text file"
  head -c $((CAT_MB * 1024 * 1024 * 3 / 4)) /dev/urandom | base64 -b 76 > "$BIG"
fi
FILES=("$FX/README.md" "$FX/docs/doc1.md" "$FX/docs/doc2.md" "$FX/docs/doc3.md" "$FX/docs/doc4.md")

ZD="$W/zdot"; mkdir -p "$ZD"
cat > "$ZD/.zshrc" <<'ZRC'
zmodload zsh/datetime
print -r -- "$EPOCHREALTIME $$ $(stty size 2>/dev/null)" >> "$SDB_DIR/shell-ready.log"
PS1='%# '
if [[ -n "$SDB_CAT" && ! -e "$SDB_DIR/cat.lock" ]]; then
  : > "$SDB_DIR/cat.lock"
  t0=$EPOCHREALTIME; cat "$SDB_CAT"; t1=$EPOCHREALTIME
  print -r -- "$(( t1 - t0 )) $(stty size)" >> "$SDB_DIR/cat.log"
fi
ZRC
: > "$ZD/.zprofile"

json_files() { local s="" f; for f in "$@"; do s="$s${s:+,}\"$f\""; done; echo "[$s]"; }

seed() { # seed <app> <scenario>
  local app="$1" sc="$2" files=() tv=false folder=1
  case "$sc" in
    start) files=("${FILES[0]}"); tv=true;;
    idle) folder=0;;
    loaded) files=("${FILES[@]}"); tv=true;;
    cat) files=("${FILES[0]}"); tv=true;;
  esac
  for d in "${CFG_DIRS[@]}"; do rm -rf "$d"; done
  if [ "$app" = tauri ]; then
    mkdir -p "$AS/com.sparkdown.editor"
    local win='{}'
    [ $folder = 1 ] && win="{\"main\":{\"folder\":{\"kind\":\"local\",\"path\":\"$FX\"},\"open_files\":$(json_files "${files[@]}"),\"geometry\":{\"x\":80,\"y\":60,\"width\":1280,\"height\":820},\"focus\":1}}"
    cat > "$AS/com.sparkdown.editor/config.json" <<J
{"version":2,"use_tmux":false,"check_updates_automatically":false,"terminal_visible":$tv,"terminal_height":260,"agent_context_enabled":false,"windows":$win}
J
  else
    mkdir -p "$AS/com.sparkdown.native-spike"
    local fj='null'; [ $folder = 1 ] && fj="\"$FX\""
    cat > "$AS/com.sparkdown.native-spike/session.json" <<J
{"folder":$fj,"openFiles":$(json_files "${files[@]}"),"activeIndex":0,"terminalVisible":$tv,"sidebarView":"files","viewMode":"split","frame":"{{80, 60}, {1280, 820}}"}
J
  fi
}

wait_lines() { # wait_lines <file> <n> <timeout>
  local end=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ -f "$1" ] && [ "$(wc -l < "$1")" -ge "$2" ] && return 0
    sleep 0.02
  done
  return 1
}

APPPID=""
launch() { # launch <exe> [extra env...]
  local exe="$1"; shift
  env ZDOTDIR="$ZD" SHELL=/bin/zsh SDB_DIR="$W/run" "$@" "$exe" >"$W/run/app.log" 2>&1 &
  APPPID=$!
}
quit_app() {
  kill -TERM "$APPPID" 2>/dev/null
  for _ in $(seq 1 50); do kill -0 "$APPPID" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$APPPID" 2>/dev/null; wait "$APPPID" 2>/dev/null
  pkill -f "$TAURI_EXE" 2>/dev/null; pkill -f "$NATIVE_EXE" 2>/dev/null
  sleep 1
}

keystroke_split() { # Cmd+D in the focused terminal pane (both apps: split right)
  tmo 15 osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $APPPID) to true" \
            -e 'delay 0.3' -e 'tell application "System Events" to keystroke "d" using command down' >>"$LOG" 2>&1
}

echo "app,scenario,run,cold,window_ms,interactive_ms,mem_mb,cat_s,detail" > "$CSV"
run() { # run <app> <scenario> <i> <cold 0|1>
  local app="$1" sc="$2" i="$3" cold="$4" exe extra=() win="" inter="" mem="" cats="" detail=""
  [ "$app" = tauri ] && exe="$TAURI_EXE" || exe="$NATIVE_EXE"
  seed "$app" "$sc"
  rm -rf "$W/run"; mkdir -p "$W/run"
  [ "$sc" = cat ] && extra=(SDB_CAT="$BIG")
  if [ "$cold" = 1 ]; then sync; tmo 60 sudo -n purge 2>/dev/null || detail="no-purge"; sleep 2; fi
  local t0; t0="$("$PROBE" now)"
  launch "$exe" "${extra[@]}"
  local w; w="$("$PROBE" wait-window "$APPPID" 60)"
  [ "$w" != timeout ] && win="$(echo "$w $t0" | awk '{printf "%.0f", ($1-$3)*1000}')"
  if [ "$sc" != idle ]; then
    if wait_lines "$W/run/shell-ready.log" 1 60; then
      inter="$(head -1 "$W/run/shell-ready.log" | awk -v t0="$t0" '{printf "%.0f", ($1-t0)*1000}')"
    else detail="$detail no-shell"; fi
  fi
  [ "$i" = 0 ] && tmo 15 screencapture -x "$OUT/screen-$app-start.png" 2>/dev/null
  case "$sc" in
    idle) sleep 10; mem="$("$PROBE" mem "$APPPID")";;
    loaded)
      sleep 3; keystroke_split
      wait_lines "$W/run/shell-ready.log" 2 20 || detail="$detail no-2nd-terminal"
      sleep 10; mem="$("$PROBE" mem "$APPPID")"
      [ "$i" = 1 ] && tmo 15 screencapture -x "$OUT/screen-$app-loaded.png" 2>/dev/null
      ;;
    cat)
      wait_lines "$W/run/cat.log" 1 600 && cats="$(awk '{print $1}' "$W/run/cat.log")" || detail="$detail cat-timeout"
      detail="$detail grid=$(awk '{print $2"x"$3}' "$W/run/cat.log" 2>/dev/null)"
      ;;
  esac
  local mb="" parts=""
  if [ -n "$mem" ]; then mb="$(echo "$mem" | awk '{printf "%.1f", $1/1048576}')"; parts="$(echo "$mem" | cut -d' ' -f2)"; fi
  echo "$app,$sc,$i,$cold,$win,$inter,$mb,$cats,\"$detail $parts\"" >> "$CSV"
  log "$app $sc #$i cold=$cold window=${win}ms interactive=${inter}ms mem=${mb}MB cat=${cats}s $detail"
  quit_app
}

# ---- sizes ------------------------------------------------------------------
{
  echo "app,bundle_bytes,dmg_bytes"
  for pair in "tauri|$TAURI_APP|$TAURI" "native|$NATIVE_APP|$NATIVE"; do
    IFS='|' read -r n a src <<<"$pair"
    b=$(( $(du -sk "$a" | awk '{print $1}') * 1024 ))
    d=""; [[ "$src" == *.dmg ]] && d="$(stat -f %z "$src")"
    echo "$n,$b,$d"
  done
} > "$OUT/sizes.csv"
cat "$OUT/sizes.csv" | tee -a "$LOG"

# One throwaway launch each (first-launch work: LaunchServices, WebKit caches).
for a in tauri native; do run "$a" start 0 0; done

for i in $(seq 1 "$RUNS"); do
  for a in tauri native; do
    [ "$COLD" = 1 ] && run "$a" start "$i" 1
    run "$a" start "$i" 0
    run "$a" idle "$i" 0
    run "$a" loaded "$i" 0
  done
done
for i in $(seq 1 "$CAT_RUNS"); do for a in tauri native; do run "$a" cat "$i" 0; done; done

"$HERE/summarize.sh" "$OUT" | tee "$OUT/summary.md"
