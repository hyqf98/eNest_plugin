// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WallpaperHost",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(name: "WallpaperHost", path: "Sources/WallpaperHost")
    ]
)
