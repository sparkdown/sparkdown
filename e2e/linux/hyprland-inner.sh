#!/bin/bash
# Inside the e2e user's D-Bus session: start Hyprland, then the runner.
set -u
OUT=$1
Hyprland >"$OUT/hyprland-stdout.log" 2>&1 &
for i in $(seq 1 30); do
  sig=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | head -1)
  sock=$(ls "$XDG_RUNTIME_DIR" | grep -m1 '^wayland-[0-9]*$')
  [ -n "$sig" ] && [ -n "$sock" ] && break
  sleep 1
done
export HYPRLAND_INSTANCE_SIGNATURE=$sig WAYLAND_DISPLAY=$sock GDK_BACKEND=wayland
timeout 10 hyprctl monitors | head -3
# A headless compositor has no keyboard, and each short-lived wtype only adds
# one while it runs, so windows got no keyboard focus events between keys.
# Hold one virtual keyboard for the whole run (it sleeps, then taps F24).
wtype -s 86400000 -k F24 &
sleep 1
timeout 10 hyprctl devices | sed -n '/Keyboards/,$p' | head -8
# Tell toolkits an assistive technology is running, so WebKitGTK exposes
# web content (the in-app menu button) over AT-SPI, not just GTK widgets.
for p in IsEnabled ScreenReaderEnabled; do
  dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus \
    org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:$p variant:boolean:true >/dev/null 2>&1 \
    || echo "a11y: could not set $p"
done
python3 "$HOME/e2e/linux/run.py" hyprland /usr/local/bin/sparkdown "$OUT"
