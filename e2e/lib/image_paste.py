"""Paste a real PNG from the system clipboard into a markdown document,
shared by the Ubuntu, Hyprland, Windows and macOS runners.

The runner's desktop adapter supplies the OS parts:
  put_image(path)       -> None, or why the PNG could not be put on the clipboard
  paste_image(title)    caret at the end of the active editor, then Ctrl/Cmd+V
  new_untitled(title)   a new untitled document in that window (Ctrl/Cmd+N)
  dialogs()             open prompts ({"name", "text", ...})
  dismiss_message(d)    press OK on a message
  save(title), close_tab(title)
The check: image-*.png appears beside the document with the PNG's bytes, the
document's buffer has the ![](image-*.png) link, and an untitled document
shows "Save this document first" for the same clipboard image."""
import pathlib
import struct
import tempfile
import time
import zlib

import mcp

UNSAVED_TEXT = "Save this document first"
UNSAVED_TITLE = "Save Document First"


def make_png(w=9, h=7):
    """A small RGB PNG with a fixed gradient (deterministic bytes)."""
    raw = b"".join(b"\x00" + b"".join(bytes(((x * 28) % 256, (y * 36) % 256, 160)) for x in range(w)) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def png_size(data):
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


def _wait(pred, secs, step=0.5):
    end = time.time() + secs
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


def run(D, title, folder, exe, log):
    """Returns (status, detail)."""
    folder = pathlib.Path(folder)
    doc = folder / "pasted.md"
    doc.write_text("# pasted\n\n", encoding="utf-8")
    data = make_png()
    src = pathlib.Path(tempfile.gettempdir()) / "sd-e2e-clipboard.png"
    src.write_bytes(data)
    before = set(folder.glob("image-*"))
    ok, r = mcp.call(exe, str(folder), "sparkdown_open_file", {"path": str(doc)})
    log("image-paste: open pasted.md over MCP:", ok, str(r)[:200])
    time.sleep(2)
    if hasattr(D, "put_text"):
        # PROBE ONLY: text-paste control through the same keys and clipboard tool.
        perr = D.put_text("SDTEXTCONTROL")
        D.paste_image(title)
        time.sleep(2)
        okt, tbuf = mcp.call(exe, str(folder), "sparkdown_read_buffer", {"path": str(doc)})
        log(f"image-paste: text control put_err={perr} pasted={'SDTEXTCONTROL' in str(tbuf)} buffer={str(tbuf)[-80:]!r}")
    err = D.put_image(str(src))
    if err:
        return "FAIL", f"could not put the PNG on the system clipboard: {err}"
    D.paste_image(title)
    new = _wait(lambda: sorted(set(folder.glob("image-*")) - before), 15)
    D.shot("image-paste")
    okb, buf = mcp.call(exe, str(folder), "sparkdown_read_buffer", {"path": str(doc)})
    buf = str(buf)
    if not new:
        return "FAIL", f"no image-* file beside pasted.md after the paste; buffer={buf[-120:]!r}"
    got = new[0].read_bytes()
    link = f"![]({new[0].name})" in buf
    if got == data:
        same = "the PNG's exact bytes"
    elif png_size(got) == png_size(data):
        same = f"a {png_size(got)} PNG (re-encoded by the clipboard, {len(got)} bytes)"
    else:
        same = None
    detail = f"{new[0].name} has {same or 'different data'}; link in buffer={link}"
    # Leave no unsaved document for the quit checks that follow.
    D.save(title)
    time.sleep(1)
    # The same image into a new untitled document: it must ask to be saved.
    D.new_untitled(title)
    time.sleep(1.5)
    D.paste_image(title)
    msgs = _wait(lambda: [d for d in D.dialogs()
                          if d.get("name") == UNSAVED_TITLE or UNSAVED_TEXT in (d.get("text") or "")], 10)
    D.shot("image-paste-untitled")
    for d in msgs or []:
        D.dismiss_message(d)
    time.sleep(1)
    after = set(folder.glob("image-*")) - before - set(new)
    D.close_tab(title)
    time.sleep(1)
    detail += f"; untitled: message shown={bool(msgs)}, files written={len(after)}"
    if len(new) != 1 or not link or not same or not msgs or after:
        return "FAIL", detail + f"; new files={[p.name for p in new]}"
    return "PASS", detail
