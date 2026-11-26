#!/usr/bin/env python3
"""vkbd.py [MOD+]KEY ... : press keys through a Wayland virtual keyboard
(zwp_virtual_keyboard_v1) that carries the standard US keymap, so the
focused client gets real evdev keycodes (Ctrl+V arrives as KeyV), unlike
wtype, whose generated keymap puts its first keysym on the Escape keycode."""
import os, socket, struct, sys, tempfile, time, array

KEYMAP = b"""xkb_keymap {
  xkb_keycodes { include "evdev+aliases(qwerty)" };
  xkb_types { include "complete" };
  xkb_compat { include "complete" };
  xkb_symbols { include "pc+us+inet(evdev)" };
};
\0"""
EVDEV = {"ctrl": 29, "shift": 42, "alt": 56, "super": 125, "v": 47, "c": 46, "x": 45, "a": 30,
         "z": 44, "s": 31, "p": 25, "return": 28, "escape": 1, "end": 107, "home": 102}
MODBIT = {"shift": 1, "ctrl": 4, "alt": 8, "super": 64}


class Wl:
    def __init__(self):
        path = os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ.get("WAYLAND_DISPLAY", "wayland-0"))
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(path)
        self.next_id = 2
        self.buf = b""

    def new_id(self):
        i = self.next_id
        self.next_id += 1
        return i

    def send(self, obj, op, payload=b"", fds=()):
        msg = struct.pack("<II", obj, ((8 + len(payload)) << 16) | op) + payload
        anc = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else []
        self.s.sendmsg([msg], anc)

    def events(self, until_obj):
        """Read events until a wl_callback.done on `until_obj`; yield (obj, op, payload)."""
        while True:
            while len(self.buf) >= 8:
                obj, so = struct.unpack("<II", self.buf[:8])
                size = so >> 16
                if len(self.buf) < size:
                    break
                payload, self.buf = self.buf[8:size], self.buf[size:]
                if obj == until_obj:
                    return
                yield obj, so & 0xFFFF, payload
            data = self.s.recv(65536)
            if not data:
                raise SystemExit("vkbd: compositor closed the connection")
            self.buf += data


def wl_string(s):
    b = s.encode() + b"\0"
    return struct.pack("<I", len(b)) + b + b"\0" * (-len(b) % 4)


def main(chords):
    wl = Wl()
    reg = wl.new_id()
    wl.send(1, 1, struct.pack("<I", reg))  # wl_display.get_registry
    cb = wl.new_id()
    wl.send(1, 0, struct.pack("<I", cb))  # wl_display.sync
    globs = {}
    for obj, op, p in wl.events(cb):
        if obj == reg and op == 0:
            name, ln = struct.unpack("<II", p[:8])
            iface = p[8:8 + ln - 1].decode()
            ver = struct.unpack("<I", p[8 + ((ln + 3) & ~3):][:4])[0]
            globs.setdefault(iface, (name, ver))
        elif obj == 1 and op == 0:
            raise SystemExit(f"vkbd: protocol error {p!r}")
    if "zwp_virtual_keyboard_manager_v1" not in globs or "wl_seat" not in globs:
        raise SystemExit("vkbd: compositor lacks zwp_virtual_keyboard_manager_v1")

    def sync():
        c = wl.new_id()
        wl.send(1, 0, struct.pack("<I", c))
        for obj, op, p in wl.events(c):
            if obj == 1 and op == 0:
                raise SystemExit(f"vkbd: protocol error {p!r}")

    def bind(iface, ver):
        i = wl.new_id()
        wl.send(reg, 0, struct.pack("<I", globs[iface][0]) + wl_string(iface) + struct.pack("<II", ver, i))
        return i
    seat = bind("wl_seat", 1)
    mgr = bind("zwp_virtual_keyboard_manager_v1", 1)
    kb = wl.new_id()
    wl.send(mgr, 0, struct.pack("<II", seat, kb))  # create_virtual_keyboard
    fd, path = tempfile.mkstemp()
    os.unlink(path)
    os.write(fd, KEYMAP)
    wl.send(kb, 0, struct.pack("<II", 1, len(KEYMAP)), fds=[fd])  # keymap(XKB_V1, fd, size)
    os.close(fd)
    sync()
    # Let the compositor hand the new keymap to the focused client before the
    # first key; without the pause that first key is dropped.
    time.sleep(0.3)
    t0 = time.monotonic()

    def ms():
        return int((time.monotonic() - t0) * 1000) & 0xFFFFFFFF

    def key(code, state):
        wl.send(kb, 1, struct.pack("<III", ms(), code, state))

    def mods(mask):
        wl.send(kb, 2, struct.pack("<IIII", mask, 0, 0, 0))
    for chord in chords:
        parts = chord.lower().split("+")
        mask = 0
        for m in parts[:-1]:
            key(EVDEV[m], 1)
            mask |= MODBIT[m]
            mods(mask)
        key(EVDEV[parts[-1]], 1)
        key(EVDEV[parts[-1]], 0)
        for m in reversed(parts[:-1]):
            key(EVDEV[m], 0)
            mask &= ~MODBIT[m]
            mods(mask)
        time.sleep(0.05)
    sync()
    time.sleep(0.2)
    wl.send(kb, 3)  # destroy
    wl.s.close()


if __name__ == "__main__":
    main(sys.argv[1:])
