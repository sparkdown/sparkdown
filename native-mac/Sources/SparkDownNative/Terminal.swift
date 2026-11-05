import AppKit
import GhosttyKit

/// The one libghostty app instance (config, font cache, renderer threads).
/// Stored as a plain global so the wakeup callback (any thread) never touches
/// a lazily-initialised Swift static.
nonisolated(unsafe) var ghosttyApp: ghostty_app_t?

enum GhosttyRuntime {
    static func start() {
        if ghosttyApp != nil { return }
        _ = ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)
        guard let cfg = ghostty_config_new() else { return }
        // Deterministic config for the spike: Ghostty defaults, not the user's
        // ~/.config/ghostty. A few SparkDown-ish tweaks.
        ghostty_config_finalize(cfg)

        var rt = ghostty_runtime_config_s()
        rt.userdata = nil
        rt.supports_selection_clipboard = false
        rt.wakeup_cb = { _ in
            DispatchQueue.main.async { if let a = ghosttyApp { ghostty_app_tick(a) } }
        }
        rt.action_cb = { _, target, action in
            // Surface-level actions the host may care about.
            if target.tag == GHOSTTY_TARGET_SURFACE, let s = target.target.surface,
               let ud = ghostty_surface_userdata(s) {
                let view = Unmanaged<TerminalView>.fromOpaque(ud).takeUnretainedValue()
                switch action.tag {
                case GHOSTTY_ACTION_SET_TITLE:
                    if let t = action.action.set_title.title {
                        let title = String(cString: t)
                        DispatchQueue.main.async { view.title = title }
                    }
                    return true
                case GHOSTTY_ACTION_MOUSE_SHAPE:
                    return true
                default:
                    return false
                }
            }
            return false
        }
        rt.read_clipboard_cb = { _, _, _, _, _, _ in GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
        rt.confirm_read_clipboard_cb = { _, _, _, _ in }
        rt.write_clipboard_cb = { _, _, contents, count, _ in
            guard let contents, count > 0 else { return }
            for i in 0..<count {
                let c = contents[i]
                guard let mime = c.mime, String(cString: mime).hasPrefix("text/plain"), let d = c.data else { continue }
                let s = String(decoding: UnsafeRawBufferPointer(start: d, count: c.len), as: UTF8.self)
                DispatchQueue.main.async {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(s, forType: .string)
                }
                return
            }
        }
        rt.close_surface_cb = { ud, _ in
            guard let ud else { return }
            let view = Unmanaged<TerminalView>.fromOpaque(ud).takeUnretainedValue()
            DispatchQueue.main.async { view.onExit?(view) }
        }
        ghosttyApp = ghostty_app_new(&rt, cfg)
    }
}

/// One terminal pane: an NSView that libghostty renders into with Metal.
final class TerminalView: NSView, NSTextInputClient {
    private(set) var surface: ghostty_surface_t?
    var title = "zsh"
    var onExit: ((TerminalView) -> Void)?
    var onFocus: ((TerminalView) -> Void)?
    private var markedText = NSMutableAttributedString()
    private var keyTextAccumulator: [String]?
    private let cwd: String?

    init(cwd: String?) {
        self.cwd = cwd
        super.init(frame: NSRect(x: 0, y: 0, width: 600, height: 240))
        wantsLayer = true
        GhosttyRuntime.start()
        guard let app = ghosttyApp else { return }
        var cfg = ghostty_surface_config_new()
        cfg.userdata = Unmanaged.passUnretained(self).toOpaque()
        cfg.platform_tag = GHOSTTY_PLATFORM_MACOS
        cfg.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(self).toOpaque()))
        cfg.scale_factor = Double(NSScreen.main?.backingScaleFactor ?? 2)
        cfg.font_size = 13
        cfg.context = GHOSTTY_SURFACE_CONTEXT_SPLIT
        surface = (cwd ?? NSHomeDirectory()).withCString { dir in
            cfg.working_directory = dir
            return ghostty_surface_new(app, &cfg)
        }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .inVisibleRect, .activeAlways, .mouseEnteredAndExited], owner: self)
        addTrackingArea(area)
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit { if let s = surface { ghostty_surface_free(s) } }

    func close() {
        if let s = surface { ghostty_surface_free(s) }
        surface = nil
        removeFromSuperview()
    }

    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool {
        if let s = surface { ghostty_surface_set_focus(s, true) }
        onFocus?(self)
        return true
    }
    override func resignFirstResponder() -> Bool {
        if let s = surface { ghostty_surface_set_focus(s, false) }
        return true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateScaleAndSize()
    }
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let w = window {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            layer?.contentsScale = w.backingScaleFactor
            CATransaction.commit()
        }
        updateScaleAndSize()
    }
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateScaleAndSize()
    }
    private func updateScaleAndSize() {
        guard let s = surface, frame.width > 0, frame.height > 0 else { return }
        let fb = convertToBacking(bounds)
        ghostty_surface_set_content_scale(s, fb.width / bounds.width, fb.height / bounds.height)
        ghostty_surface_set_size(s, UInt32(fb.width), UInt32(fb.height))
    }

    // MARK: keyboard

    static func mods(_ f: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var m: UInt32 = GHOSTTY_MODS_NONE.rawValue
        if f.contains(.shift) { m |= GHOSTTY_MODS_SHIFT.rawValue }
        if f.contains(.control) { m |= GHOSTTY_MODS_CTRL.rawValue }
        if f.contains(.option) { m |= GHOSTTY_MODS_ALT.rawValue }
        if f.contains(.command) { m |= GHOSTTY_MODS_SUPER.rawValue }
        if f.contains(.capsLock) { m |= GHOSTTY_MODS_CAPS.rawValue }
        return ghostty_input_mods_e(m)
    }

    private func keyEvent(_ action: ghostty_input_action_e, _ e: NSEvent) -> ghostty_input_key_s {
        var k = ghostty_input_key_s()
        k.action = action
        k.keycode = UInt32(e.keyCode)
        k.mods = Self.mods(e.modifierFlags)
        k.consumed_mods = Self.mods(e.modifierFlags.subtracting([.control, .command]))
        k.text = nil
        k.composing = false
        if e.type == .keyDown || e.type == .keyUp,
           let chars = e.characters(byApplyingModifiers: []), let cp = chars.unicodeScalars.first {
            k.unshifted_codepoint = cp.value
        }
        return k
    }

    private func send(_ action: ghostty_input_action_e, _ e: NSEvent, text: String?) {
        guard let s = surface else { return }
        var k = keyEvent(action, e)
        if let text, let first = text.utf8.first, first >= 0x20 {
            text.withCString { p in k.text = p; _ = ghostty_surface_key(s, k) }
        } else {
            _ = ghostty_surface_key(s, k)
        }
    }

    override func keyDown(with event: NSEvent) {
        guard surface != nil else { return }
        // Ctrl-chords go straight to ghostty (it encodes control chars itself).
        if event.modifierFlags.contains(.control) {
            send(event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS, event, text: nil)
            return
        }
        keyTextAccumulator = []
        interpretKeyEvents([event])
        let texts = keyTextAccumulator ?? []
        keyTextAccumulator = nil
        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        if texts.isEmpty {
            send(action, event, text: markedText.length > 0 ? nil : event.characters)
        } else {
            for t in texts { send(action, event, text: t) }
        }
    }

    override func keyUp(with event: NSEvent) { send(GHOSTTY_ACTION_RELEASE, event, text: nil) }

    override func flagsChanged(with event: NSEvent) {
        // Modifier press/release: ghostty only needs it for mouse reporting; skip.
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self, event.type == .keyDown else { return false }
        let m = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if m == .command, event.charactersIgnoringModifiers == "v" { paste(nil); return true }
        if m == .command, event.charactersIgnoringModifiers == "c" { copy(nil); return true }
        return false
    }

    @objc func paste(_ sender: Any?) {
        guard let s = surface, let str = NSPasteboard.general.string(forType: .string) else { return }
        str.withCString { ghostty_surface_text(s, $0, UInt(strlen($0))) }
    }

    @objc func copy(_ sender: Any?) {
        guard let s = surface, ghostty_surface_has_selection(s) else { return }
        var t = ghostty_text_s()
        if ghostty_surface_read_selection(s, &t) {
            if let p = t.text {
                let str = String(decoding: UnsafeRawBufferPointer(start: p, count: Int(t.text_len)), as: UTF8.self)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(str, forType: .string)
            }
            ghostty_surface_free_text(s, &t)
        }
    }

    // NSTextInputClient (IME + interpretKeyEvents plumbing)
    func insertText(_ string: Any, replacementRange: NSRange) {
        let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        markedText = NSMutableAttributedString()
        if keyTextAccumulator != nil { keyTextAccumulator?.append(s); return }
        guard let surf = surface else { return }
        s.withCString { ghostty_surface_text(surf, $0, UInt(strlen($0))) }
    }
    override func doCommand(by selector: Selector) {}
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        markedText = NSMutableAttributedString(string: s)
        if let surf = surface { s.withCString { ghostty_surface_preedit(surf, $0, UInt(strlen($0))) } }
    }
    func unmarkText() { markedText = NSMutableAttributedString() }
    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func markedRange() -> NSRange { markedText.length > 0 ? NSRange(location: 0, length: markedText.length) : NSRange(location: NSNotFound, length: 0) }
    func hasMarkedText() -> Bool { markedText.length > 0 }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let s = surface, let w = window else { return .zero }
        var x = 0.0, y = 0.0, wd = 0.0, h = 0.0
        ghostty_surface_ime_point(s, &x, &y, &wd, &h)
        let local = NSRect(x: x, y: frame.height - y, width: wd, height: h)
        return w.convertToScreen(convert(local, to: nil))
    }
    func characterIndex(for point: NSPoint) -> Int { 0 }

    // MARK: mouse

    private func pos(_ e: NSEvent) {
        guard let s = surface else { return }
        let p = convert(e.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(s, p.x, frame.height - p.y, Self.mods(e.modifierFlags))
    }
    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        pos(e)
        if let s = surface { _ = ghostty_surface_mouse_button(s, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, Self.mods(e.modifierFlags)) }
    }
    override func mouseUp(with e: NSEvent) {
        if let s = surface { _ = ghostty_surface_mouse_button(s, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, Self.mods(e.modifierFlags)) }
    }
    override func mouseDragged(with e: NSEvent) { pos(e) }
    override func mouseMoved(with e: NSEvent) { pos(e) }
    override func scrollWheel(with e: NSEvent) {
        guard let s = surface else { return }
        var x = e.scrollingDeltaX, y = e.scrollingDeltaY
        var mods: Int32 = 0
        if e.hasPreciseScrollingDeltas { x *= 2; y *= 2; mods = 1 }
        ghostty_surface_mouse_scroll(s, x, y, ghostty_input_scroll_mods_t(mods))
    }
}

/// The terminal drawer: panes in a split view (Cmd+D right, Cmd+Shift+D down).
final class TerminalPanel: NSView {
    private var split = NSSplitView()
    private(set) var panes: [TerminalView] = []
    var cwd: String?
    var onEmpty: (() -> Void)?
    private weak var focused: TerminalView?

    override init(frame: NSRect) {
        super.init(frame: frame)
        split.isVertical = true
        split.dividerStyle = .thin
        split.translatesAutoresizingMaskIntoConstraints = false
        addSubview(split)
        NSLayoutConstraint.activate([
            split.leadingAnchor.constraint(equalTo: leadingAnchor),
            split.trailingAnchor.constraint(equalTo: trailingAnchor),
            split.topAnchor.constraint(equalTo: topAnchor),
            split.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    @discardableResult
    func addPane(vertical: Bool = true) -> TerminalView {
        if panes.count == 1 { split.isVertical = vertical }
        let t = TerminalView(cwd: cwd)
        t.onExit = { [weak self] v in self?.remove(v) }
        t.onFocus = { [weak self] v in self?.focused = v }
        panes.append(t)
        split.addArrangedSubview(t)
        split.adjustSubviews()
        DispatchQueue.main.async { t.window?.makeFirstResponder(t) }
        return t
    }

    func remove(_ v: TerminalView) {
        panes.removeAll { $0 === v }
        v.close()
        split.adjustSubviews()
        if panes.isEmpty { onEmpty?() } else { window?.makeFirstResponder(panes.last) }
    }

    func closeFocused() { if let f = focused ?? panes.last { remove(f) } }
    func focus() { if let p = focused ?? panes.first { window?.makeFirstResponder(p) } }
}
