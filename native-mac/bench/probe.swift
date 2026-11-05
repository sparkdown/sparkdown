// sdbench probe: window detection and memory footprint, used identically for
// both apps. Build: swiftc -O probe.swift -o probe
import Foundation
import CoreGraphics

func now() -> Double { Date().timeIntervalSince1970 }

typealias RespFn = @convention(c) (pid_t) -> pid_t
let respFn: RespFn? = {
    guard let h = dlopen(nil, RTLD_NOW), let s = dlsym(h, "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(s, to: RespFn.self)
}()

func footprint(_ pid: pid_t) -> UInt64 {
    var info = rusage_info_v4()
    let r = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    return r == 0 ? info.ri_phys_footprint : 0
}

func allPids() -> [pid_t] {
    let n = proc_listallpids(nil, 0)
    var buf = [pid_t](repeating: 0, count: Int(n) * 2)
    let m = proc_listallpids(&buf, Int32(buf.count * MemoryLayout<pid_t>.size))
    return Array(buf.prefix(Int(m))).filter { $0 > 0 }
}

func ppid(_ pid: pid_t) -> pid_t {
    var info = proc_bsdinfo()
    let r = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    return r > 0 ? pid_t(info.pbi_ppid) : 0
}

func name(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 1024)
    proc_pidpath(pid, &buf, UInt32(buf.count))
    return (String(cString: buf) as NSString).lastPathComponent
}

func startTime(_ pid: pid_t) -> Double {
    var info = proc_bsdinfo()
    let r = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    return r > 0 ? Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1e6 : 0
}

func isDescendant(_ p: pid_t, of root: pid_t) -> Bool {
    var cur = ppid(p), hops = 0
    while cur > 1 && hops < 64 { if cur == root { return true }; cur = ppid(cur); hops += 1 }
    return false
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "now":
    print(String(format: "%.6f", now()))
case "wait-window":
    // wait-window <pid> <timeout>: epoch seconds when the pid first owns an
    // on-screen, layer-0 window at least 200x200.
    let pid = Int32(args[2])!, deadline = now() + Double(args[3])!
    while now() < deadline {
        if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
                if let b = w[kCGWindowBounds as String] as? [String: Double], (b["Width"] ?? 0) >= 200, (b["Height"] ?? 0) >= 200 {
                    print(String(format: "%.6f %d", now(), (w[kCGWindowNumber as String] as? Int) ?? 0))
                    exit(0)
                }
            }
        }
        usleep(2000)
    }
    print("timeout"); exit(1)
case "mem":
    // mem <pid> [since]: footprint of the app process plus XPC helpers it is
    // responsible for (WebKit WebContent/Networking/GPU), excluding its child
    // processes (the shells in the terminals). Bytes, then a breakdown.
    // WebKit's XPC services are launchd children; attribute them by
    // responsibility, or (if that's unavailable) by being a WebKit process
    // started after the app (`since`, epoch seconds).
    let root = Int32(args[2])!
    let since = args.count > 3 ? Double(args[3])! : startTime(root)
    var total: UInt64 = footprint(root)
    var parts = ["\(name(root))=\(footprint(root))"]
    for p in allPids() where p != root && !isDescendant(p, of: root) {
        let n = name(p)
        let byResp = respFn.map { $0(p) == root } ?? false
        let byWebKit = n.hasPrefix("com.apple.WebKit") && startTime(p) >= since - 0.5
        if byResp || byWebKit {
            let f = footprint(p); total += f; parts.append("\(n)=\(f)")
        }
    }
    print("\(total) \(parts.joined(separator: ","))")
default:
    print("usage: probe now | wait-window <pid> <timeout> | mem <pid>"); exit(2)
}
