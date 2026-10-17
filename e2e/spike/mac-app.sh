#!/bin/bash
# Spike: drive the real SparkDown.app (release bundle) with System Events.
set -u
out=${OUT:-e2e-out}; mkdir -p "$out"
app="$1"; bin="$app/Contents/MacOS/sparkdown"
T=$(mktemp -d); A=$T/alpha; B=$T/beta; mkdir -p "$A" "$B"; echo "# A" > "$A/notes.md"; echo "# B" > "$B/notes.md"
log() { tee -a "$out/mac-app.log"; }
q() { echo "> $1" | log; osascript -e "tell application \"System Events\" to tell process \"sparkdown\" to $1" 2>&1 | log; }
shot() { screencapture -x "$out/mac-$1.png"; }
"$bin" "$A" >"$out/app-stdout.log" 2>&1 & sleep 10
q 'get name of every window'
"$bin" "$B" >>"$out/app-stdout.log" 2>&1; sleep 5        # second launch -> single instance forwards
echo "processes: $(pgrep -x sparkdown | wc -l)" | log
q 'get name of every window'
q 'get name of every menu item of menu "Window" of menu bar item "Window" of menu bar 1'
shot 2win
"$bin" "$A" >>"$out/app-stdout.log" 2>&1; sleep 3        # same folder again -> focus, no new window
q 'get name of every window'
q 'get name of window 1'
# red close on the front window only
q 'click (first button of window 1 whose subrole is "AXCloseButton")'; sleep 2
q 'get name of every window'
q 'get name of every menu item of menu "Window" of menu bar item "Window" of menu bar 1'
# close the last one too, then dock reopen
q 'click (first button of window 1 whose subrole is "AXCloseButton")'; sleep 2
q 'get name of every window'
echo "> dock click" | log
osascript -e 'tell application "System Events" to tell process "Dock" to click UI element "SparkDown" of list 1' 2>&1 | log; sleep 4
q 'get name of every window'
shot reopen
# unsaved edit, then Cmd+Q and app-menu Quit; read the dialog, press Cancel
osascript -e 'tell application "System Events" to keystroke "p" using command down' -e 'delay 1' -e 'tell application "System Events" to keystroke "notes"' -e 'delay 1' -e 'tell application "System Events" to key code 36' -e 'delay 2' -e 'tell application "System Events" to keystroke "unsaved edit"' 2>&1 | log
sleep 1; shot unsaved
osascript -e 'tell application "System Events" to keystroke "q" using command down' 2>&1 | log; sleep 3
q 'get {name, subrole} of every window'
q 'get value of every static text of every sheet of every window'
q 'get name of every button of every sheet of every window'
q 'get entire contents of window 1'  >/dev/null
shot quit-prompt
q 'click button "Cancel" of sheet 1 of window 1'; sleep 2
q 'get name of every window'
q 'click menu item "Quit SparkDown" of menu 1 of menu bar item "SparkDown" of menu bar 1'; sleep 3
q 'get value of every static text of every sheet of every window'
shot quit-prompt-menu
echo "processes at end: $(pgrep -x sparkdown | wc -l)" | log
pkill -x sparkdown || true
