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
python3 "$HOME/e2e/linux/run.py" hyprland /usr/local/bin/sparkdown "$OUT"
