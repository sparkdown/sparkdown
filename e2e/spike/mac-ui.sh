#!/bin/bash
# Spike: is System Events UI scripting (Accessibility) usable on macos-latest?
set -u
out=${OUT:-e2e-out}; mkdir -p "$out"
step() { echo "::group::$1"; shift; "$@" 2>&1 | tee -a "$out/mac-ui.log"; echo "exit=$?" | tee -a "$out/mac-ui.log"; echo "::endgroup::"; }
sw_vers | tee "$out/sw_vers.txt"
step "UI elements enabled" osascript -e 'tell application "System Events" to get UI elements enabled'
step "processes" osascript -e 'tell application "System Events" to get name of every process whose background only is false'
open -a TextEdit; sleep 4
step "TextEdit menu bar" osascript -e 'tell application "System Events" to tell process "TextEdit" to get name of every menu bar item of menu bar 1'
step "TextEdit new window via menu click" osascript -e 'tell application "System Events" to tell process "TextEdit" to click menu item "New" of menu "File" of menu bar item "File" of menu bar 1' -e 'delay 1' -e 'tell application "System Events" to tell process "TextEdit" to get name of every window'
step "TextEdit Window menu items" osascript -e 'tell application "System Events" to tell process "TextEdit" to get name of every menu item of menu "Window" of menu bar item "Window" of menu bar 1'
step "keystroke cmd-q (sheet?)" osascript -e 'tell application "System Events" to tell process "TextEdit" to keystroke "x"' -e 'tell application "System Events" to keystroke "q" using command down' -e 'delay 2' -e 'tell application "System Events" to tell process "TextEdit" to get {name of every window, every sheet of every window}'
step "Dock items" osascript -e 'tell application "System Events" to tell process "Dock" to get name of every UI element of list 1'
screencapture -x "$out/mac-textedit.png"; echo "screencapture exit=$?" | tee -a "$out/mac-ui.log"
osascript -e 'tell application "TextEdit" to quit saving no' >/dev/null 2>&1 || true
