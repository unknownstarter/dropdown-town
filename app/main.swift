// Dropdown Town 맥 앱: 로컬 서버(server.mjs)를 직접 띄우고, 그 화면을 독립 창(WKWebView)으로 보여준다.
import Cocoa
import WebKit

let port = 4777
let pageURL = URL(string: "http://127.0.0.1:\(port)/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var server: Process?
  var pinItem: NSMenuItem!
  var quitting = false
  var restartDelay: TimeInterval = 1

  func applicationDidFinishLaunching(_ note: Notification) {
    startServer()
    buildMenu()

    webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    webView.navigationDelegate = self
    webView.uiDelegate = self

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 860),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Dropdown Town"
    window.minSize = NSSize(width: 520, height: 400)
    window.contentView = webView
    window.setFrameAutosaveName("ClaudeTownWindow")
    if !window.setFrameUsingName("ClaudeTownWindow") { window.center() }
    window.makeKeyAndOrderFront(nil)
    if UserDefaults.standard.bool(forKey: "pinned") { togglePin(nil) }

    NSApp.activate(ignoringOtherApps: true)
    webView.load(URLRequest(url: pageURL))
  }

  // node 위치: 빌드할 때 적어 둔 경로를 먼저 쓰고, 없으면 흔한 설치 위치를 찾는다.
  func nodePath() -> String? {
    var candidates: [String] = []
    if let baked = Bundle.main.url(forResource: "node-path", withExtension: "txt"),
       let text = try? String(contentsOf: baked, encoding: .utf8) {
      candidates.append(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    let nvm = NSHomeDirectory() + "/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
      candidates += versions.sorted().reversed().map { "\(nvm)/\($0)/bin/node" }
    }
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  func startServer() {
    guard let node = nodePath(), let script = Bundle.main.path(forResource: "server", ofType: "mjs") else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    proc.arguments = [script]
    proc.environment = ProcessInfo.processInfo.environment.merging(["PORT": String(port)]) { _, new in new }
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    // 서버가 죽으면(직접 종료됐거나 오류로) 다시 띄운다. 같은 포트에 이미 다른 서버가 떠 있으면 새 프로세스는 바로 끝나는데,
    // 그때는 화면이 그 서버를 그대로 쓰므로 점점 간격을 늘려 가며(최대 15초) 확인만 계속한다.
    let startedAt = Date()
    proc.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self, !self.quitting else { return }
        self.restartDelay = Date().timeIntervalSince(startedAt) > 10 ? 1 : min(self.restartDelay * 2, 15)
        DispatchQueue.main.asyncAfter(deadline: .now() + self.restartDelay) { if !self.quitting { self.startServer() } }
      }
    }
    try? proc.run()
    server = proc
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Dropdown Town 가리기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Dropdown Town 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let viewItem = NSMenuItem(); main.addItem(viewItem)
    let viewMenu = NSMenu(title: "보기")
    viewMenu.addItem(withTitle: "새로 고침", action: #selector(reload(_:)), keyEquivalent: "r")
    pinItem = viewMenu.addItem(withTitle: "항상 위에 두기", action: #selector(togglePin(_:)), keyEquivalent: "t")
    viewMenu.addItem(withTitle: "작은 창으로", action: #selector(compact(_:)), keyEquivalent: "1")
    viewItem.submenu = viewMenu

    let windowItem = NSMenuItem(); main.addItem(windowItem)
    let windowMenu = NSMenu(title: "윈도우")
    windowMenu.addItem(withTitle: "최소화", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    NSApp.mainMenu = main
  }

  @objc func reload(_ sender: Any?) { webView.load(URLRequest(url: pageURL)) }

  @objc func togglePin(_ sender: Any?) {
    let pinned = window.level != .floating
    window.level = pinned ? .floating : .normal
    pinItem.state = pinned ? .on : .off
    UserDefaults.standard.set(pinned, forKey: "pinned")
  }

  // 코드 편집기 옆에 띄워 두기 좋은 크기(월드 1.5배)로 줄인다.
  @objc func compact(_ sender: Any?) {
    var frame = window.frame
    let top = frame.maxY
    frame.size = NSSize(width: 770, height: 580)
    frame.origin.y = top - frame.height
    window.setFrame(frame, display: true, animate: true)
  }

  // 서버가 뜨기 전에 열면 실패하므로 잠깐 뒤 다시 시도한다.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.reload(nil) }
  }

  // PR 링크처럼 새 창으로 여는 링크는 기본 브라우저로 넘긴다.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ note: Notification) { quitting = true; server?.terminate() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
