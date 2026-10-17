#!/bin/bash
# Spike (inside archlinux container): headless Hyprland + grim screenshot.
set -u
out=${OUT:-/out}; mkdir -p "$out"
pacman -Syu --noconfirm --needed hyprland sway grim foot mesa webkit2gtk-4.1 >/dev/null 2>&1 || pacman -Syu --noconfirm --needed hyprland sway grim foot mesa webkit2gtk-4.1 | tail -5
pacman -Q hyprland aquamarine grim webkit2gtk-4.1 2>&1 | tee "$out/hypr-versions.txt"
{ pacman -Ql webkit2gtk-4.1 | grep -i webdriver; } 2>&1 | tee -a "$out/hypr-versions.txt"
useradd -m e2e 2>/dev/null; export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p $XDG_RUNTIME_DIR; chown e2e $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
mkdir -p /home/e2e/.config/hypr
cat > /home/e2e/.config/hypr/hyprland.conf <<'C'
monitor = ,1920x1080@60,0x0,1
misc {
  disable_hyprland_logo = true
  disable_splash_rendering = true
}
exec-once = foot
C
chown -R e2e /home/e2e
attempt() {
  name=$1; shift
  echo "== attempt $name: $*" | tee -a "$out/hypr.log"
  runuser -u e2e -- env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR "$@" Hyprland >"$out/hypr-$name.log" 2>&1 &
  pid=$!
  for i in $(seq 1 20); do sleep 1; ls $XDG_RUNTIME_DIR/wayland-* >/dev/null 2>&1 && break; done
  sleep 4
  sock=$(ls $XDG_RUNTIME_DIR | grep '^wayland-[0-9]*$' | grep -vx "${HOST_SOCK:-none}" | head -1)
  if [ -n "$sock" ] && kill -0 $pid 2>/dev/null; then
    sig=$(ls $XDG_RUNTIME_DIR/hypr 2>/dev/null | head -1)
    runuser -u e2e -- env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR HYPRLAND_INSTANCE_SIGNATURE=$sig hyprctl monitors 2>&1 | tee -a "$out/hypr.log"
    runuser -u e2e -- env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR HYPRLAND_INSTANCE_SIGNATURE=$sig hyprctl clients 2>&1 | tee -a "$out/hypr.log"
    runuser -u e2e -- env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR WAYLAND_DISPLAY=$sock grim "/tmp/g.png" 2>&1 | tee -a "$out/hypr.log"
    cp /tmp/g.png "$out/hypr-$name.png" 2>/dev/null && echo "OK $name screenshot" | tee -a "$out/hypr.log"
    kill $pid; wait $pid 2>/dev/null; rm -rf $XDG_RUNTIME_DIR/hypr
    [ -f "$out/hypr-$name.png" ] && return 0
  else
    echo "FAILED $name (sock=$sock)" | tee -a "$out/hypr.log"; tail -25 "$out/hypr-$name.log" | tee -a "$out/hypr.log"
    cp $XDG_RUNTIME_DIR/hypr/*/hyprland.log "$out/hypr-$name-full.log" 2>/dev/null; kill $pid 2>/dev/null; rm -rf $XDG_RUNTIME_DIR/hypr
  fi
  return 1
}
nested() {
  # Host: sway on the wlroots headless backend; Hyprland runs nested on its Wayland backend.
  runuser -u e2e -- env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman sway -d >"$out/sway.log" 2>&1 &
  for i in $(seq 1 15); do sleep 1; HOST_SOCK=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$') && break; done
  export HOST_SOCK; echo "sway socket: ${HOST_SOCK:-none}" | tee -a "$out/hypr.log"
  [ -n "$HOST_SOCK" ] || { tail -30 "$out/sway.log" | tee -a "$out/hypr.log"; return 1; }
  attempt nested-in-sway WAYLAND_DISPLAY=$HOST_SOCK LIBGL_ALWAYS_SOFTWARE=1
}
attempt aq-headless AQ_BACKENDS=headless WLR_BACKENDS=headless LIBGL_ALWAYS_SOFTWARE=1 \
 || attempt wlr-headless WLR_BACKENDS=headless WLR_RENDERER_ALLOW_SOFTWARE=1 LIBGL_ALWAYS_SOFTWARE=1 \
 || nested
ls "$out"
