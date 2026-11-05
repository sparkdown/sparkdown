// swift-tools-version:5.9
// SPIKE — native macOS SparkDown prototype. Never merge to main.
import PackageDescription

let package = Package(
    name: "SparkDownNative",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-cmark", branch: "gfm"),
    ],
    targets: [
        // Built from Ghostty source by scripts/build-ghosttykit.sh (zig build -Demit-xcframework).
        .binaryTarget(name: "GhosttyKit", path: "vendor/GhosttyKit.xcframework"),
        .executableTarget(
            name: "SparkDownNative",
            dependencies: [
                "GhosttyKit",
                .product(name: "cmark-gfm", package: "swift-cmark"),
                .product(name: "cmark-gfm-extensions", package: "swift-cmark"),
            ],
            linkerSettings: [
                .linkedLibrary("c++"),
                .linkedFramework("Carbon"),
                .linkedFramework("Metal"),
                .linkedFramework("MetalKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("IOSurface"),
                .linkedFramework("CoreText"),
                .linkedFramework("WebKit"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
    ]
)
