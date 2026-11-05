import Foundation

/// Thin wrapper over the git CLI, like the Tauri core's git.rs.
enum Git {
    struct Change { let status: String; let path: String }

    @discardableResult
    static func run(_ args: [String], in dir: URL) -> (code: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git", "-c", "core.quotepath=false"] + args
        p.currentDirectoryURL = dir
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    static func branch(_ dir: URL) -> String? {
        let r = run(["rev-parse", "--abbrev-ref", "HEAD"], in: dir)
        return r.code == 0 ? r.out.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    static func status(_ dir: URL) -> [Change] {
        let r = run(["status", "--porcelain=v1", "-uall"], in: dir)
        guard r.code == 0 else { return [] }
        return r.out.split(separator: "\n").compactMap { line in
            guard line.count > 3 else { return nil }
            let s = String(line.prefix(2))
            var path = String(line.dropFirst(3))
            if let arrow = path.range(of: " -> ") { path = String(path[arrow.upperBound...]) }
            return Change(status: s, path: path)
        }
    }

    static func diff(_ dir: URL, path: String, status: String) -> String {
        if status == "??" {
            return run(["diff", "--no-index", "--", "/dev/null", path], in: dir).out
        }
        let r = run(["diff", "HEAD", "--", path], in: dir)
        return r.out.isEmpty ? run(["diff", "--cached", "--", path], in: dir).out : r.out
    }
}
