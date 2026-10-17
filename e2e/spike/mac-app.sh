#!/bin/bash
# Spike: drive the real SparkDown.app (debug bundle) with System Events.
set -u
out=${OUT:-e2e-out}; mkdir -p "$out"
app="$1"; A=$(mktemp -d)/alpha; B=$(mktemp -d)/beta; mkdir -p "$A" "$B"; echo "# A" > "$A/notes.md"
log() { tee -a "$out/mac-app.log"; }
q() { osascript -e "tell application \"System Events\" to tell process \"SparkDown\" to $1" 2>&1 | log; }
open -a "$app" --args "$A"; sleep 12
q 'get name of every window'
open -a "$app" --args "$B"; sleep 6
q 'get name of every window'
q 'get name of every menu bar item of menu bar 1'
q 'get name of every menu item of menu "Window" of menu bar item "Window" of menu bar 1'
screencapture -x "$out/mac-sparkdown-2win.png"
osascript -e 'tell application "System Events" to tell process "Dock" to get name of every UI element of list 1' 2>&1 | log
q 'click button 1 of window 1'; sleep 2   # red close
q 'get name of every window'
osascript -e 'tell application "System Events" to keystroke "q" using command down' 2>&1 | log; sleep 3
q 'get {name of every window, name of every sheet of every window}'
screencapture -x "$out/mac-sparkdown-quit.png"
pgrep -fl sparkdown | log || true
