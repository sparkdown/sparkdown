import AppKit
import WebKit

final class Doc {
    var url: URL?
    var text: String
    var dirty = false
    var diffOf: String?          // non-nil: a read-only diff tab for this path
    init(url: URL?, text: String) { self.url = url; self.text = text }
    var title: String { diffOf.map { "Δ " + ($0 as NSString).lastPathComponent } ?? url?.lastPathComponent ?? "Untitled" }
}

/// Tab strip above the editor (title + close button per tab).
final class TabBar: NSView {
    private let stack = NSStackView()
    var onSelect: ((Int) -> Void)?
    var onClose: ((Int) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .horizontal
        stack.spacing = 1
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 32),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    func render(_ docs: [Doc], active: Int) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, d) in docs.enumerated() {
            let tab = NSStackView()
            tab.orientation = .horizontal
            tab.spacing = 2
            tab.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 4)
            tab.wantsLayer = true
            tab.layer?.cornerRadius = 6
            tab.layer?.backgroundColor = (i == active ? NSColor.controlBackgroundColor : NSColor.clear).cgColor
            let title = NSButton(title: (d.dirty ? "● " : "") + d.title, target: self, action: #selector(select(_:)))
            title.isBordered = false
            title.tag = i
            title.font = .systemFont(ofSize: 12, weight: i == active ? .semibold : .regular)
            let close = NSButton(title: "×", target: self, action: #selector(close(_:)))
            close.isBordered = false
            close.tag = i
            close.font = .systemFont(ofSize: 13)
            tab.addArrangedSubview(title)
            tab.addArrangedSubview(close)
            tab.heightAnchor.constraint(equalToConstant: 26).isActive = true
            stack.addArrangedSubview(tab)
        }
    }
    @objc private func select(_ b: NSButton) { onSelect?(b.tag) }
    @objc private func close(_ b: NSButton) { onClose?(b.tag) }
}

/// Bottom status bar: branch + folder on the left, cursor/char count right.
final class StatusBar: NSView {
    let left = NSTextField(labelWithString: "")
    let right = NSTextField(labelWithString: "")
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for l in [left, right] {
            l.font = .systemFont(ofSize: 11)
            l.textColor = .secondaryLabelColor
            l.translatesAutoresizingMaskIntoConstraints = false
            addSubview(l)
        }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 22),
            // Padding clears the rounded window corners.
            left.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            left.centerYAnchor.constraint(equalTo: centerYAnchor),
            right.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            right.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
}

final class MainWindowController: NSWindowController, NSWindowDelegate, NSTextViewDelegate, WKNavigationDelegate, NSSplitViewDelegate {
    private var session: Session
    private var folder: URL?
    private var docs: [Doc] = []
    private var active = -1

    private let tree = FileTreeController()
    private let changes = ChangesController()
    private let sidebarHost = NSView()
    private let sidebarTitle = NSTextField(labelWithString: "EXPLORER")
    private let activity = NSStackView()
    private let tabBar = TabBar()
    private let editorScroll = NSTextView.scrollableTextView()
    private var editor: NSTextView { editorScroll.documentView as! NSTextView }
    private let preview: WKWebView
    private var previewReady = false
    private var pendingHTML: String?
    private let editorSplit = NSSplitView()
    private let centerSplit = NSSplitView()
    private let outerSplit = NSSplitView()
    private let editorArea = NSView()
    private let welcome = NSStackView()
    private let terminal = TerminalPanel()
    private let status = StatusBar()
    private var viewMode = "split"
    private var sidebarView = "files"
    private var previewTimer: Timer?
    private var fsSource: DispatchSourceFileSystemObject?
    private var gitTimer: Timer?

    init(session: Session) {
        self.session = session
        let cfg = WKWebViewConfiguration()
        cfg.suppressesIncrementalRendering = false
        preview = WKWebView(frame: .zero, configuration: cfg)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.titlebarAppearsTransparent = true
        w.title = "SparkDown"
        w.minSize = NSSize(width: 720, height: 420)
        super.init(window: w)
        w.delegate = self
        if let f = session.frame { w.setFrame(NSRectFromString(f), display: false) } else { w.center() }
        buildLayout()
        viewMode = session.viewMode
        sidebarView = session.sidebarView
        if let f = session.folder, FileManager.default.fileExists(atPath: f) {
            open(folder: URL(fileURLWithPath: f), restoring: session)
        } else {
            showWelcome(true)
        }
        if session.terminalVisible { setTerminal(visible: true) }
        applyViewMode()
        applySidebarView()
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: layout

    private func pin(_ v: NSView, in p: NSView, insets: NSEdgeInsets = .init()) {
        v.translatesAutoresizingMaskIntoConstraints = false
        p.addSubview(v)
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: p.leadingAnchor, constant: insets.left),
            v.trailingAnchor.constraint(equalTo: p.trailingAnchor, constant: -insets.right),
            v.topAnchor.constraint(equalTo: p.topAnchor, constant: insets.top),
            v.bottomAnchor.constraint(equalTo: p.bottomAnchor, constant: -insets.bottom),
        ])
    }

    private func activityButton(_ symbol: String, _ tip: String, _ action: Selector) -> NSButton {
        let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tip)!, target: self, action: action)
        b.isBordered = false
        b.toolTip = tip
        b.imageScaling = .scaleProportionallyUpOrDown
        b.widthAnchor.constraint(equalToConstant: 22).isActive = true
        b.heightAnchor.constraint(equalToConstant: 22).isActive = true
        b.contentTintColor = .secondaryLabelColor
        return b
    }

    private func buildLayout() {
        let content = NSView()
        window!.contentView = content

        // Activity bar (Files / Changes), below the traffic lights.
        activity.orientation = .vertical
        activity.alignment = .centerX
        activity.spacing = 16
        activity.edgeInsets = NSEdgeInsets(top: 44, left: 0, bottom: 0, right: 0)
        activity.addArrangedSubview(activityButton("doc.on.doc", "Explorer", #selector(showExplorer(_:))))
        activity.addArrangedSubview(activityButton("arrow.triangle.branch", "Changes", #selector(showChanges(_:))))
        activity.addArrangedSubview(activityButton("terminal", "Terminal (⌃`)", #selector(toggleTerminal(_:))))
        activity.setHuggingPriority(.required, for: .horizontal)

        // Sidebar
        let side = NSVisualEffectView()
        side.material = .sidebar
        side.blendingMode = .behindWindow
        sidebarTitle.font = .systemFont(ofSize: 11, weight: .semibold)
        sidebarTitle.textColor = .secondaryLabelColor
        sidebarTitle.translatesAutoresizingMaskIntoConstraints = false
        side.addSubview(sidebarTitle)
        NSLayoutConstraint.activate([
            sidebarTitle.leadingAnchor.constraint(equalTo: side.leadingAnchor, constant: 12),
            sidebarTitle.topAnchor.constraint(equalTo: side.topAnchor, constant: 40),
        ])
        sidebarHost.translatesAutoresizingMaskIntoConstraints = false
        side.addSubview(sidebarHost)
        NSLayoutConstraint.activate([
            sidebarHost.leadingAnchor.constraint(equalTo: side.leadingAnchor),
            sidebarHost.trailingAnchor.constraint(equalTo: side.trailingAnchor),
            sidebarHost.topAnchor.constraint(equalTo: sidebarTitle.bottomAnchor, constant: 6),
            sidebarHost.bottomAnchor.constraint(equalTo: side.bottomAnchor),
        ])
        tree.onOpen = { [weak self] url in self?.openFile(url) }
        changes.onSelect = { [weak self] c in self?.openDiff(c) }

        // Editor + preview
        editor.isRichText = false
        editor.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.allowsUndo = true
        editor.usesFindBar = true
        editor.textContainerInset = NSSize(width: 16, height: 14)
        editor.delegate = self
        preview.navigationDelegate = self
        preview.setValue(false, forKey: "drawsBackground")
        preview.loadHTMLString(Markdown.pageTemplate, baseURL: nil)
        editorSplit.isVertical = true
        editorSplit.dividerStyle = .thin
        editorSplit.addArrangedSubview(editorScroll)
        editorSplit.addArrangedSubview(preview)

        let tabsAndEditor = NSStackView(views: [tabBar, editorSplit])
        tabsAndEditor.orientation = .vertical
        tabsAndEditor.spacing = 0
        tabBar.setContentHuggingPriority(.required, for: .vertical)
        tabBar.onSelect = { [weak self] i in self?.activate(i) }
        tabBar.onClose = { [weak self] i in self?.close(at: i) }
        pin(tabsAndEditor, in: editorArea, insets: .init(top: 28, left: 0, bottom: 0, right: 0))

        // Welcome (no folder)
        welcome.orientation = .vertical
        welcome.spacing = 12
        let wt = NSTextField(labelWithString: "SparkDown")
        wt.font = .systemFont(ofSize: 28, weight: .semibold)
        let ws = NSTextField(labelWithString: "Native macOS prototype (spike, not for shipping)")
        ws.textColor = .secondaryLabelColor
        let wb = NSButton(title: "Open Folder…", target: self, action: #selector(openFolder(_:)))
        wb.bezelStyle = .rounded
        [wt, ws, wb].forEach { welcome.addArrangedSubview($0) }
        welcome.translatesAutoresizingMaskIntoConstraints = false
        editorArea.addSubview(welcome)
        NSLayoutConstraint.activate([
            welcome.centerXAnchor.constraint(equalTo: editorArea.centerXAnchor),
            welcome.centerYAnchor.constraint(equalTo: editorArea.centerYAnchor),
        ])

        // Center column: editor over terminal drawer
        centerSplit.isVertical = false
        centerSplit.dividerStyle = .thin
        centerSplit.delegate = self
        centerSplit.addArrangedSubview(editorArea)
        centerSplit.addArrangedSubview(terminal)
        terminal.isHidden = true
        terminal.onEmpty = { [weak self] in self?.setTerminal(visible: false) }

        outerSplit.isVertical = true
        outerSplit.dividerStyle = .thin
        outerSplit.delegate = self
        outerSplit.addArrangedSubview(side)
        outerSplit.addArrangedSubview(centerSplit)
        outerSplit.setHoldingPriority(.defaultLow + 10, forSubviewAt: 0)
        side.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

        let row = NSStackView(views: [activity, outerSplit])
        row.orientation = .horizontal
        row.spacing = 0
        row.alignment = .top
        activity.widthAnchor.constraint(equalToConstant: 44).isActive = true
        activity.heightAnchor.constraint(equalTo: row.heightAnchor).isActive = true
        outerSplit.heightAnchor.constraint(equalTo: row.heightAnchor).isActive = true

        let col = NSStackView(views: [row, status])
        col.orientation = .vertical
        col.spacing = 0
        status.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
        row.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
        pin(col, in: content)
        DispatchQueue.main.async {
            self.outerSplit.setPosition(240, ofDividerAt: 0)
        }
    }

    func splitView(_ s: NSSplitView, constrainMinCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat { s === outerSplit ? 160 : 120 }

    private func showWelcome(_ on: Bool) {
        welcome.isHidden = !on
        editorSplit.superview?.isHidden = on
    }

    // MARK: folder / files

    private func open(folder url: URL, restoring: Session? = nil) {
        folder = url
        window?.title = url.lastPathComponent
        tree.setRoot(url)
        changes.folder = url
        changes.refresh()
        terminal.cwd = url.path
        docs.removeAll()
        active = -1
        if let r = restoring {
            for p in r.openFiles where FileManager.default.fileExists(atPath: p) { openFile(URL(fileURLWithPath: p), activate: false) }
            if !docs.isEmpty { activate(min(max(r.activeIndex, 0), docs.count - 1)) }
        }
        showWelcome(false)
        if docs.isEmpty { renderTabs(); loadEditor() }
        watch(url)
        updateStatus()
    }

    /// Refresh the tree + Changes when the folder changes on disk (top level
    /// via a dispatch source, plus a light git poll like the Tauri watcher).
    private func watch(_ url: URL) {
        fsSource?.cancel()
        let fd = Darwin.open(url.path, O_EVTONLY)
        if fd >= 0 {
            let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
            src.setEventHandler { [weak self] in self?.tree.refresh(); self?.changes.refresh() }
            src.setCancelHandler { Darwin.close(fd) }
            src.resume()
            fsSource = src
        }
        gitTimer?.invalidate()
        gitTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, self.sidebarView == "changes" else { return }
            self.changes.refresh()
        }
    }

    func openFile(_ url: URL, activate act: Bool = true) {
        if let i = docs.firstIndex(where: { $0.url == url && $0.diffOf == nil }) { if act { activate(i) }; return }
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        docs.append(Doc(url: url, text: text))
        if act { activate(docs.count - 1) } else { renderTabs() }
    }

    private func openDiff(_ c: Git.Change) {
        guard let folder else { return }
        let d = Doc(url: nil, text: Git.diff(folder, path: c.path, status: c.status))
        d.diffOf = c.path
        if let i = docs.firstIndex(where: { $0.diffOf == c.path }) { docs[i] = d; activate(i); return }
        docs.append(d)
        activate(docs.count - 1)
    }

    private func activate(_ i: Int) {
        storeEditor()
        active = i
        renderTabs()
        loadEditor()
    }

    private func storeEditor() {
        guard active >= 0, active < docs.count, docs[active].diffOf == nil else { return }
        docs[active].text = editor.string
    }

    private func loadEditor() {
        guard active >= 0, active < docs.count else {
            editor.string = ""
            editor.isEditable = false
            setPreview("")
            return
        }
        let d = docs[active]
        if d.diffOf != nil {
            editor.isEditable = false
            editor.textStorage?.setAttributedString(colorDiff(d.text))
            setPreview("<pre>\(escape(d.text))</pre>")
        } else {
            editor.isEditable = true
            editor.textStorage?.setAttributedString(NSAttributedString(string: d.text, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                .foregroundColor: NSColor.textColor,
            ]))
            setPreview(Markdown.html(d.text))
        }
        editor.setSelectedRange(NSRange(location: 0, length: 0))
        window?.title = d.title
        updateStatus()
    }

    private func colorDiff(_ s: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        for line in s.split(separator: "\n", omittingEmptySubsequences: false) {
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.textColor]
            if line.hasPrefix("+") && !line.hasPrefix("+++") {
                attrs[.foregroundColor] = NSColor.systemGreen
                attrs[.backgroundColor] = NSColor.systemGreen.withAlphaComponent(0.12)
            } else if line.hasPrefix("-") && !line.hasPrefix("---") {
                attrs[.foregroundColor] = NSColor.systemRed
                attrs[.backgroundColor] = NSColor.systemRed.withAlphaComponent(0.12)
            } else if line.hasPrefix("@@") {
                attrs[.foregroundColor] = NSColor.systemBlue
            }
            out.append(NSAttributedString(string: line + "\n", attributes: attrs))
        }
        return out
    }

    private func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    }

    private func renderTabs() { tabBar.render(docs, active: active) }

    private func close(at i: Int) {
        guard i >= 0, i < docs.count else { return }
        storeEditor()
        if docs[i].dirty {
            let a = NSAlert()
            a.messageText = "Save changes to \(docs[i].title)?"
            a.addButton(withTitle: "Save"); a.addButton(withTitle: "Cancel"); a.addButton(withTitle: "Don't Save")
            let r = a.runModal()
            if r == .alertSecondButtonReturn { return }
            if r == .alertFirstButtonReturn { save(docs[i]) }
        }
        docs.remove(at: i)
        if active >= docs.count { active = docs.count - 1 } else if i < active { active -= 1 }
        renderTabs()
        loadEditor()
    }

    private func save(_ d: Doc) {
        guard d.diffOf == nil else { return }
        if d.url == nil {
            let p = NSSavePanel()
            p.nameFieldStringValue = "Untitled.md"
            if let folder { p.directoryURL = folder }
            guard p.runModal() == .OK, let u = p.url else { return }
            d.url = u
        }
        guard let u = d.url else { return }
        do {
            try d.text.write(to: u, atomically: true, encoding: .utf8)
            d.dirty = false
        } catch {
            NSAlert(error: error).runModal()
        }
        renderTabs()
        changes.refresh()
        tree.refresh()
    }

    // MARK: preview

    private func setPreview(_ html: String) {
        guard previewReady else { pendingHTML = html; return }
        let data = try? JSONSerialization.data(withJSONObject: [html])
        let arr = data.map { String(decoding: $0, as: UTF8.self) } ?? "[\"\"]"
        preview.evaluateJavaScript("sdSet(\(arr)[0])")
    }

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        previewReady = true
        if let p = pendingHTML { pendingHTML = nil; setPreview(p) }
    }

    func textDidChange(_ notification: Notification) {
        guard active >= 0, active < docs.count, docs[active].diffOf == nil else { return }
        let d = docs[active]
        d.text = editor.string
        if !d.dirty { d.dirty = true; renderTabs() }
        updateStatus()
        previewTimer?.invalidate()
        previewTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.setPreview(Markdown.html(self.editor.string))
        }
    }

    func textViewDidChangeSelection(_ notification: Notification) { updateStatus() }

    private func updateStatus() {
        var left: [String] = []
        if let folder {
            if let b = Git.branch(folder) { left.append("⎇ \(b)") }
            left.append(folder.lastPathComponent)
        }
        status.left.stringValue = left.joined(separator: "   ")
        if active >= 0, active < docs.count {
            let s = editor.string as NSString
            let loc = editor.selectedRange().location
            let before = s.substring(to: min(loc, s.length))
            let line = before.components(separatedBy: "\n").count
            let col = (before.components(separatedBy: "\n").last?.count ?? 0) + 1
            status.right.stringValue = "Ln \(line), Col \(col)   \(s.length) chars   Markdown"
        } else {
            status.right.stringValue = ""
        }
    }

    // MARK: view modes / sidebar / terminal

    private func applyViewMode() {
        editorScroll.isHidden = viewMode == "preview"
        preview.isHidden = viewMode == "edit"
        editorSplit.adjustSubviews()
    }

    private func applySidebarView() {
        sidebarHost.subviews.forEach { $0.removeFromSuperview() }
        let v = sidebarView == "changes" ? changes.scroll : tree.scroll
        sidebarTitle.stringValue = sidebarView == "changes" ? "CHANGES" : "EXPLORER"
        if sidebarView == "changes" { changes.refresh() }
        pin(v, in: sidebarHost)
    }

    private func setTerminal(visible: Bool) {
        terminal.isHidden = !visible
        if visible {
            if terminal.panes.isEmpty { terminal.addPane() }
            let h = centerSplit.bounds.height
            DispatchQueue.main.async {
                self.centerSplit.setPosition(max(h - 260, 200), ofDividerAt: 0)
                self.terminal.focus()
            }
        } else {
            window?.makeFirstResponder(editor)
        }
        centerSplit.adjustSubviews()
    }

    // MARK: actions (menu / shortcuts)

    @objc func openFolder(_ sender: Any?) {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        guard p.runModal() == .OK, let u = p.url else { return }
        open(folder: u)
    }
    @objc func newFile(_ sender: Any?) {
        showWelcome(false)
        docs.append(Doc(url: nil, text: ""))
        activate(docs.count - 1)
        window?.makeFirstResponder(editor)
    }
    @objc func saveDocument(_ sender: Any?) {
        storeEditor()
        if active >= 0, active < docs.count { save(docs[active]) }
    }
    @objc func closeTab(_ sender: Any?) { close(at: active) }
    @objc func nextTab(_ sender: Any?) { if !docs.isEmpty { activate((active + 1) % docs.count) } }
    @objc func prevTab(_ sender: Any?) { if !docs.isEmpty { activate((active - 1 + docs.count) % docs.count) } }
    @objc func toggleSidebar(_ sender: Any?) {
        let side = outerSplit.arrangedSubviews[0]
        side.isHidden.toggle()
        outerSplit.adjustSubviews()
    }
    @objc func showExplorer(_ sender: Any?) { sidebarView = "files"; applySidebarView() }
    @objc func showChanges(_ sender: Any?) { sidebarView = "changes"; applySidebarView() }
    @objc func viewEdit(_ sender: Any?) { viewMode = "edit"; applyViewMode() }
    @objc func viewSplit(_ sender: Any?) { viewMode = "split"; applyViewMode() }
    @objc func viewPreview(_ sender: Any?) { viewMode = "preview"; applyViewMode() }
    @objc func toggleTerminal(_ sender: Any?) { setTerminal(visible: terminal.isHidden) }
    @objc func splitRight(_ sender: Any?) {
        if terminal.isHidden { setTerminal(visible: true); return }
        terminal.addPane(vertical: true)
    }
    @objc func splitDown(_ sender: Any?) {
        if terminal.isHidden { setTerminal(visible: true); return }
        terminal.addPane(vertical: false)
    }
    @objc func closePane(_ sender: Any?) { terminal.closeFocused() }

    func saveSession() {
        storeEditor()
        session.folder = folder?.path
        session.openFiles = docs.compactMap { $0.diffOf == nil ? $0.url?.path : nil }
        session.activeIndex = max(active, 0)
        session.terminalVisible = !terminal.isHidden
        session.sidebarView = sidebarView
        session.viewMode = viewMode
        if let w = window { session.frame = NSStringFromRect(w.frame) }
        session.save()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        storeEditor()
        saveSession()
        return true
    }
}
