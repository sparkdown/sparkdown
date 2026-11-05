import Foundation

/// Per-launch state restored on the next start, like the Tauri app's
/// config.json window section (folder, open files, terminal drawer).
struct Session: Codable {
    var folder: String?
    var openFiles: [String] = []
    var activeIndex: Int = 0
    var terminalVisible: Bool = false
    var sidebarView: String = "files"
    var viewMode: String = "split"
    var frame: String?

    static var url: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("com.sparkdown.native-spike/session.json")
    }

    static func load() -> Session {
        guard let data = try? Data(contentsOf: url),
              let s = try? JSONDecoder().decode(Session.self, from: data) else { return Session() }
        return s
    }

    func save() {
        try? FileManager.default.createDirectory(at: Session.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(self) { try? data.write(to: Session.url, options: .atomic) }
    }
}
