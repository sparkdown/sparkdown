import AppKit

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    var controller: MainWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMenu()
        let c = MainWindowController(session: Session.load())
        controller = c
        c.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.saveSession()
    }

    private func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        return i
    }

    private func buildMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(item("About SparkDown Native (spike)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Quit SparkDown", #selector(NSApplication.terminate(_:)), "q"))
        add(main, "SparkDown", appMenu)

        let file = NSMenu(title: "File")
        file.addItem(item("New File", #selector(MainWindowController.newFile(_:)), "n"))
        file.addItem(item("Open Folder…", #selector(MainWindowController.openFolder(_:)), "o", [.command, .option]))
        file.addItem(.separator())
        file.addItem(item("Save", #selector(MainWindowController.saveDocument(_:)), "s"))
        file.addItem(item("Close Tab", #selector(MainWindowController.closeTab(_:)), "w"))
        add(main, "File", file)

        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", Selector(("undo:")), "z"))
        edit.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        edit.addItem(.separator())
        edit.addItem(item("Find…", #selector(NSTextView.performFindPanelAction(_:)), "f"))
        edit.items.last?.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
        add(main, "Edit", edit)

        let view = NSMenu(title: "View")
        view.addItem(item("Toggle Sidebar", #selector(MainWindowController.toggleSidebar(_:)), "b", [.command, .shift]))
        view.addItem(item("Explorer", #selector(MainWindowController.showExplorer(_:)), "e", [.command, .shift]))
        view.addItem(item("Changes", #selector(MainWindowController.showChanges(_:)), "g", [.control, .shift]))
        view.addItem(.separator())
        view.addItem(item("Edit", #selector(MainWindowController.viewEdit(_:)), "1", [.command, .option]))
        view.addItem(item("Split", #selector(MainWindowController.viewSplit(_:)), "2", [.command, .option]))
        view.addItem(item("Preview", #selector(MainWindowController.viewPreview(_:)), "3", [.command, .option]))
        view.addItem(.separator())
        view.addItem(item("Next Tab", #selector(MainWindowController.nextTab(_:)), String(UnicodeScalar(NSRightArrowFunctionKey)!), [.command, .option]))
        view.addItem(item("Previous Tab", #selector(MainWindowController.prevTab(_:)), String(UnicodeScalar(NSLeftArrowFunctionKey)!), [.command, .option]))
        add(main, "View", view)

        let term = NSMenu(title: "Terminal")
        term.addItem(item("Toggle Terminal", #selector(MainWindowController.toggleTerminal(_:)), "`", [.control]))
        term.addItem(item("Split Right", #selector(MainWindowController.splitRight(_:)), "d"))
        term.addItem(item("Split Down", #selector(MainWindowController.splitDown(_:)), "d", [.command, .shift]))
        term.addItem(item("Close Pane", #selector(MainWindowController.closePane(_:)), "w", [.command, .shift]))
        add(main, "Terminal", term)

        let window = NSMenu(title: "Window")
        window.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        window.addItem(item("Zoom", #selector(NSWindow.performZoom(_:)), ""))
        add(main, "Window", window)
        NSApp.windowsMenu = window
        return main
    }

    private func add(_ main: NSMenu, _ title: String, _ sub: NSMenu) {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        sub.title = title
        i.submenu = sub
        main.addItem(i)
    }
}
