import AppKit
import Darwin
import Foundation
import Network
import WebKit

struct HostConfig: Codable {
    struct Content: Codable {
        var type: String
        var url: String
        var title: String?
    }
    struct Settings: Codable {
        var fpsLimit: Int
        var mute: Bool
        var pauseOnFullscreen: Bool
        var pauseOnBattery: Bool
        var pauseOnLock: Bool?
        var lowPower: Bool
        var quality: String
    }
    var token: String
    var parentPid: Int32
    var dataDir: String
    var content: Content
    var settings: Settings
}

final class DesktopWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class ControlServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "wallpaper-house.control")
    private let token: String
    var onCommand: (String, [String: Any]) -> Void
    private var connection: NWConnection?
    private var buffer = Data()
    private var authorized = false

    init(token: String, onCommand: @escaping (String, [String: Any]) -> Void) throws {
        self.token = token
        self.onCommand = onCommand
        self.listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state, let port = self.listener.port?.rawValue {
                print("READY \(port)")
                fflush(stdout)
            }
            if case .failed(let error) = state {
                self.emit(["event": "error", "message": error.localizedDescription])
            }
        }
        listener.start(queue: queue)
    }

    func stop() {
        connection?.cancel()
        listener.cancel()
    }

    private func accept(_ connection: NWConnection) {
        self.connection = connection
        buffer.removeAll()
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.emit(["event": "error", "message": "control connection failed"]) }
            if case .cancelled = state { self?.connection = nil }
        }
        connection.start(queue: queue)
        receive()
    }

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                self.consumeLines()
            }
            if error != nil || isComplete { return }
            self.receive()
        }
    }

    private func consumeLines() {
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: 0..<newline)
            buffer.removeSubrange(0...newline)
            guard let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !line.isEmpty else { continue }
            handle(line)
        }
    }

    private func handle(_ line: String) {
        guard let data = line.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if !authorized {
            guard (object["token"] as? String) == token else {
                connection?.cancel()
                return
            }
            authorized = true
            emit(["event": "ready"])
            emit(["event": "attached", "parent": 0])
            return
        }
        guard let command = object["cmd"] as? String else { return }
        onCommand(command, object)
    }

    func emit(_ object: [String: Any]) {
        guard let connection, let data = try? JSONSerialization.data(withJSONObject: object), var text = String(data: data, encoding: .utf8) else { return }
        text.append("\n")
        connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var config: HostConfig
    private let server: ControlServer
    private var windows: [DesktopWindow] = []
    private var webViews: [WKWebView] = []
    private var paused = false
    private var pauseReason = ""
    private var watchdog: Timer?
    private var pauseTimer: Timer?
    private var screenLocked = false
    private var lockObserver: NSObjectProtocol?
    private var unlockObserver: NSObjectProtocol?

    init(config: HostConfig) throws {
        self.config = config
        self.server = try ControlServer(token: config.token) { command, object in
            // Assigned after init through the property below.
            _ = command
            _ = object
        }
        super.init()
        self.server.onCommand = { [weak self] command, object in
            self?.handle(command: command, object: object)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for screen in NSScreen.screens {
            createWindow(on: screen)
        }
        server.start()
        startWatchdog()
        startPauseTimer()
        observeScreenLock()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.emit(["event": "attached", "parent": 0])
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        watchdog?.invalidate()
        pauseTimer?.invalidate()
        for observer in [lockObserver, unlockObserver].compactMap({ $0 }) {
            DistributedNotificationCenter.default().removeObserver(observer)
        }
        server.stop()
    }

    private func createWindow(on screen: NSScreen) {
        let window = DesktopWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        window.isOpaque = false
        window.backgroundColor = .black
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: screen.frame, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.pageZoom = qualityZoom()
        window.contentView = webView
        window.orderFrontRegardless()
        windows.append(window)
        webViews.append(webView)
        guard let url = URL(string: config.content.url) else {
            emit(["event": "error", "message": "invalid content url"])
            return
        }
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.applyContentScript()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        applyContentScript()
    }

    private func applyContentScript() {
        let web = config.content.type == "web"
        let style = web ? "" : "var s=document.createElement('style');s.textContent='html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}video,img{width:100%;height:100%;object-fit:cover}';document.documentElement.appendChild(s);"
        let mute = config.settings.mute ? "true" : "false"
        let fps = effectiveFpsLimit()
        var script = "(function(){try{\(style)var m=\(mute);var v=document.querySelectorAll('video,audio');for(var i=0;i<v.length;i++){v[i].muted=m;if(m){v[i].volume=0}}var video=document.querySelector('video');if(video){video.controls=false;video.loop=true;video.muted=m;video.play().catch(function(){})}"
        script += "var fps=\(fps);if(fps>0&&!window.__whFpsGuard){window.__whFpsGuard=true;var raf=window.requestAnimationFrame.bind(window);var last=0;window.requestAnimationFrame=function(cb){return raf(function(t){if(t-last>=1000/fps){last=t;cb(t)}else{window.requestAnimationFrame(cb)}})}}"
        script += "}catch(e){}})();"
        for webView in webViews { webView.evaluateJavaScript(script, completionHandler: nil) }
    }

    private func handle(command: String, object: [String: Any]) {
        if command == "stop" {
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }
        if command == "pause" { DispatchQueue.main.async { self.setPaused(true, reason: "command") }; return }
        if command == "resume" { DispatchQueue.main.async { self.setPaused(false, reason: "") }; return }
        if command == "settings", let settings = object["settings"] as? [String: Any] {
            DispatchQueue.main.async {
                if let value = settings["mute"] as? Bool { self.config.settings.mute = value }
                if let value = settings["fpsLimit"] as? Int { self.config.settings.fpsLimit = value }
                if let value = settings["pauseOnFullscreen"] as? Bool { self.config.settings.pauseOnFullscreen = value }
                if let value = settings["pauseOnBattery"] as? Bool { self.config.settings.pauseOnBattery = value }
                if let value = settings["pauseOnLock"] as? Bool { self.config.settings.pauseOnLock = value }
                if let value = settings["lowPower"] as? Bool { self.config.settings.lowPower = value }
                if let value = settings["quality"] as? String { self.config.settings.quality = value }
                for webView in self.webViews { webView.pageZoom = self.qualityZoom() }
                self.applyContentScript()
                self.checkPauseRules()
            }
        }
    }

    private func observeScreenLock() {
        let center = DistributedNotificationCenter.default()
        lockObserver = center.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            self?.screenLocked = true
            self?.checkPauseRules()
        }
        unlockObserver = center.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            self?.screenLocked = false
            self?.checkPauseRules()
        }
    }

    private func effectiveFpsLimit() -> Int {
        let fps = max(0, min(60, config.settings.fpsLimit))
        guard config.settings.lowPower else { return fps }
        return fps == 0 ? 24 : min(fps, 24)
    }

    private func qualityZoom() -> CGFloat {
        let zoom: CGFloat
        switch config.settings.quality {
        case "low": zoom = 0.75
        case "medium": zoom = 0.9
        default: zoom = 1.0
        }
        return config.settings.lowPower ? min(zoom, 0.9) : zoom
    }

    private func startWatchdog() {
        watchdog = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.config.parentPid > 0 && kill(self.config.parentPid, 0) != 0 {
                NSApp.terminate(nil)
            }
        }
    }

    private func startPauseTimer() {
        pauseTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkPauseRules()
        }
    }

    private func checkPauseRules() {
        var reason = ""
        if (config.settings.pauseOnLock ?? true) && screenLocked { reason = "lock" }
        if reason.isEmpty && config.settings.pauseOnFullscreen && isFullscreenAppActive() { reason = "fullscreen" }
        if reason.isEmpty && config.settings.pauseOnBattery && isOnBattery() { reason = "battery" }
        setPaused(!reason.isEmpty, reason: reason)
    }

    private func setPaused(_ next: Bool, reason: String) {
        if paused == next && pauseReason == reason { return }
        paused = next
        pauseReason = reason
        let script = paused
            ? "document.querySelectorAll('video,audio').forEach(function(v){try{v.pause()}catch(e){}})"
            : "document.querySelectorAll('video,audio').forEach(function(v){try{v.play().catch(function(){})}catch(e){}})"
        for webView in webViews { webView.evaluateJavaScript(script, completionHandler: nil) }
        emit(["event": paused ? "paused" : "resumed", "reason": reason])
    }

    private func isFullscreenAppActive() -> Bool {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return false }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let screenFrame = NSScreen.main?.frame ?? .zero
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid == app.processIdentifier,
                  let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let boundsDict = window[kCGWindowBounds as String] as? [String: Any] else { continue }
            let rect = CGRect(
                x: (boundsDict["X"] as? NSNumber)?.doubleValue ?? 0,
                y: (boundsDict["Y"] as? NSNumber)?.doubleValue ?? 0,
                width: (boundsDict["Width"] as? NSNumber)?.doubleValue ?? 0,
                height: (boundsDict["Height"] as? NSNumber)?.doubleValue ?? 0
            )
            if rect.width >= screenFrame.width - 2 && rect.height >= screenFrame.height - 2 { return true }
        }
        return false
    }

    private var batteryCheckedAt = Date.distantPast
    private var batteryCached = false

    private func isOnBattery() -> Bool {
        if Date().timeIntervalSince(batteryCheckedAt) < 10 { return batteryCached }
        batteryCheckedAt = Date()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        process.arguments = ["-g", "batt"]
        let pipe = Pipe()
        process.standardOutput = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            batteryCached = text.contains("Battery Power")
            return batteryCached
        } catch {
            batteryCached = false
            return false
        }
    }

    private func emit(_ object: [String: Any]) {
        server.emit(object)
    }
}

var configPath: String?
var iterator = CommandLine.arguments.dropFirst().makeIterator()
while let argument = iterator.next() {
    if argument == "--config", let value = iterator.next() { configPath = value }
}
guard let path = configPath, let data = try? Data(contentsOf: URL(fileURLWithPath: path)), let config = try? JSONDecoder().decode(HostConfig.self, from: data), !config.token.isEmpty else {
    print("ERROR missing or invalid --config")
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
do {
    let delegate = try AppDelegate(config: config)
    app.delegate = delegate
    app.run()
} catch {
    print("ERROR \(error.localizedDescription)")
    exit(1)
}
