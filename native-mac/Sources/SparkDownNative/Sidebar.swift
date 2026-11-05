import AppKit

final class FileNode: NSObject {
    let url: URL
    let isDir: Bool
    private var _children: [FileNode]?
    init(url: URL, isDir: Bool) { self.url = url; self.isDir = isDir }

    var name: String { url.lastPathComponent }

    var children: [FileNode] {
        if let c = _children { return c }
        let fm = FileManager.default
        let items = (try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        let nodes = items.compactMap { u -> FileNode? in
            let dir = (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            return FileNode(url: u, isDir: dir)
        }.sorted { a, b in
            if a.isDir != b.isDir { return a.isDir }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
        _children = nodes
        return nodes
    }

    func reload() { _children = nil }
}

/// Explorer: an NSOutlineView over the folder, lazily listed, dirs first.
final class FileTreeController: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
    let outline = NSOutlineView()
    let scroll = NSScrollView()
    var root: FileNode?
    var onOpen: ((URL) -> Void)?

    override init() {
        super.init()
        let col = NSTableColumn(identifier: .init("name"))
        col.isEditable = false
        outline.addTableColumn(col)
        outline.outlineTableColumn = col
        outline.headerView = nil
        outline.rowSizeStyle = .small
        outline.style = .sourceList
        outline.indentationPerLevel = 12
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.action = #selector(clicked)
        outline.autosaveExpandedItems = false
        scroll.documentView = outline
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
    }

    func setRoot(_ url: URL?) {
        root = url.map { FileNode(url: $0, isDir: true) }
        outline.reloadData()
    }

    func refresh() {
        guard let root else { return }
        let expanded = (0..<outline.numberOfRows).compactMap { outline.item(atRow: $0) as? FileNode }
            .filter { outline.isItemExpanded($0) }.map(\.url)
        let newRoot = FileNode(url: root.url, isDir: true)
        self.root = newRoot
        outline.reloadData()
        func expand(_ n: FileNode) {
            for c in n.children where c.isDir && expanded.contains(c.url) {
                outline.expandItem(c); expand(c)
            }
        }
        expand(newRoot)
    }

    @objc private func clicked() {
        guard let node = outline.item(atRow: outline.clickedRow) as? FileNode else { return }
        if node.isDir {
            if outline.isItemExpanded(node) { outline.collapseItem(node) } else { outline.expandItem(node) }
        } else {
            onOpen?(node.url)
        }
    }

    func outlineView(_ o: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        guard let n = (item as? FileNode) ?? root else { return 0 }
        return n.children.count
    }
    func outlineView(_ o: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        ((item as? FileNode) ?? root!).children[index]
    }
    func outlineView(_ o: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? FileNode)?.isDir ?? false }

    func outlineView(_ o: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let n = item as? FileNode else { return nil }
        let id = NSUserInterfaceItemIdentifier("cell")
        let cell = (o.makeView(withIdentifier: id, owner: nil) as? NSTableCellView) ?? {
            let c = NSTableCellView()
            c.identifier = id
            let img = NSImageView(); let tf = NSTextField(labelWithString: "")
            tf.lineBreakMode = .byTruncatingMiddle
            img.translatesAutoresizingMaskIntoConstraints = false
            tf.translatesAutoresizingMaskIntoConstraints = false
            c.addSubview(img); c.addSubview(tf)
            c.imageView = img; c.textField = tf
            NSLayoutConstraint.activate([
                img.leadingAnchor.constraint(equalTo: c.leadingAnchor),
                img.centerYAnchor.constraint(equalTo: c.centerYAnchor),
                img.widthAnchor.constraint(equalToConstant: 16), img.heightAnchor.constraint(equalToConstant: 16),
                tf.leadingAnchor.constraint(equalTo: img.trailingAnchor, constant: 5),
                tf.trailingAnchor.constraint(equalTo: c.trailingAnchor),
                tf.centerYAnchor.constraint(equalTo: c.centerYAnchor),
            ])
            return c
        }()
        cell.textField?.stringValue = n.name
        let sym = n.isDir ? "folder" : (n.url.pathExtension.lowercased() == "md" ? "doc.richtext" : "doc")
        cell.imageView?.image = NSImage(systemSymbolName: sym, accessibilityDescription: nil)
        cell.imageView?.contentTintColor = n.isDir ? .systemBlue : .secondaryLabelColor
        return cell
    }
}

/// Changes view: `git status` list; clicking a row opens its diff.
final class ChangesController: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let table = NSTableView()
    let scroll = NSScrollView()
    var changes: [Git.Change] = []
    var folder: URL?
    var onSelect: ((Git.Change) -> Void)?

    override init() {
        super.init()
        let col = NSTableColumn(identifier: .init("c"))
        table.addTableColumn(col)
        table.headerView = nil
        table.style = .sourceList
        table.rowSizeStyle = .small
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
    }

    func refresh() {
        changes = folder.map { Git.status($0) } ?? []
        table.reloadData()
    }

    @objc private func clicked() {
        guard table.clickedRow >= 0, table.clickedRow < changes.count else { return }
        onSelect?(changes[table.clickedRow])
    }

    func numberOfRows(in tableView: NSTableView) -> Int { max(changes.count, 1) }

    func tableView(_ t: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let tf = NSTextField(labelWithString: "")
        tf.lineBreakMode = .byTruncatingMiddle
        guard row < changes.count else {
            tf.stringValue = folder == nil ? "No folder open" : "No changes"
            tf.textColor = .secondaryLabelColor
            return tf
        }
        let c = changes[row]
        let s = c.status.trimmingCharacters(in: .whitespaces)
        let badge = s == "??" ? "U" : String(s.prefix(1))
        let color: NSColor = badge == "M" ? .systemOrange : (badge == "D" ? .systemRed : .systemGreen)
        let a = NSMutableAttributedString(string: "\(badge)  ", attributes: [.foregroundColor: color, .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)])
        a.append(NSAttributedString(string: c.path, attributes: [.font: NSFont.systemFont(ofSize: 12)]))
        tf.attributedStringValue = a
        return tf
    }
}
