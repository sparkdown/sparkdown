#!/bin/bash
# Runs inside archlinux:latest (--privileged, /dev/dri from the host's vkms).
# Installs Hyprland and the app's runtime libraries, boots Hyprland on the
# vkms DRM device (seatd), then runs the E2E flow as an unprivileged user.
# Usage: bash e2e/linux/hyprland-job.sh /w/sparkdown /out
set -uo pipefail
BIN_IN=$1; OUT=$2
mkdir -p "$OUT"
pacman -Syu --noconfirm --needed hyprland seatd grim wtype python git mesa ttf-dejavu \
  webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg xdotool openssl dbus procps-ng at-spi2-core python-gobject >"$OUT/pacman.log" 2>&1 \
  || { tail -30 "$OUT/pacman.log"; exit 1; }
pacman -Q hyprland aquamarine webkit2gtk-4.1 | tee "$OUT/versions.txt"
install -m 755 "$BIN_IN" /usr/local/bin/sparkdown
if ldd /usr/local/bin/sparkdown | grep 'not found'; then echo "missing libraries"; exit 1; fi
useradd -m -s /bin/bash e2e
export XDG_RUNTIME_DIR=/run/user/1000; mkdir -p $XDG_RUNTIME_DIR; chown e2e $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
chmod 666 /dev/dri/* 2>/dev/null
card=$(for c in /sys/class/drm/card[0-9]*; do readlink -f "$c/device" | grep -q vkms && echo /dev/dri/$(basename "$c"); done | head -1)
echo "vkms device: ${card:-none}" | tee -a "$OUT/versions.txt"
seatd -g e2e >"$OUT/seatd.log" 2>&1 &
sleep 1
mkdir -p /home/e2e/.config/hypr
cat > /home/e2e/.config/hypr/hyprland.conf <<'C'
monitor = ,1920x1080@60,0x0,1
misc {
  disable_hyprland_logo = true
  disable_splash_rendering = true
}
debug {
  disable_logs = false
}
C
chown -R e2e /home/e2e "$OUT"
cp -r /w/e2e /home/e2e/e2e && chown -R e2e /home/e2e/e2e
aq=(); [ -n "$card" ] && aq=(AQ_DRM_DEVICES="$card")
runuser -u e2e -- env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR LIBSEAT_BACKEND=seatd "${aq[@]}" \
  SHELL=/bin/bash HOME=/home/e2e GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-}" \
  dbus-run-session -- bash /home/e2e/e2e/linux/hyprland-inner.sh "$OUT"
rc=$?
cp $XDG_RUNTIME_DIR/hypr/*/hyprland.log "$OUT/hyprland.log" 2>/dev/null
exit $rc
