import AppKit
import Foundation
import WebKit

@MainActor
final class SmokeTest: NSObject, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var forwardedMessages = 0
    private var pendingMessages: [Any] = []
    private var delivering = false
    private(set) var status: Int32 = 1

    func start(url: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "cwep")
        configuration.userContentController.add(self, name: "smokeResult")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.load(URLRequest(url: url))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "cwep", !message.frameInfo.isMainFrame {
            forwardedMessages += 1
            pendingMessages.append(message.body)
            if delivering { return }
            delivering = true
            Task { await forwardMessages() }
        } else if message.name == "smokeResult", message.frameInfo.isMainFrame,
                  let result = message.body as? [String: Any] {
            let output = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            if let output, let text = String(data: output, encoding: .utf8) { print(text) }
            if result["ok"] as? Bool == true && result["transport"] as? String == "WKWebView" && forwardedMessages > 0 {
                status = 0
            }
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }

    private func forwardMessages() async {
        defer { delivering = false }
        do {
            while !pendingMessages.isEmpty {
                let message = pendingMessages.removeFirst()
                _ = try await webView.callAsyncJavaScript(
                    "window.acceptCwepSmokeMessage(message)",
                    arguments: ["message": message], in: nil, contentWorld: .page
                )
            }
        } catch {
            print(error)
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
}

MainActor.assumeIsolated {
    let address = CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:8080/tests/browser-smoke.html"
    guard let url = URL(string: address) else { exit(1) }
    _ = NSApplication.shared
    let test = SmokeTest()
    test.start(url: url)
    let timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { _ in
        print("WKWebView smoke test timed out")
        CFRunLoopStop(CFRunLoopGetMain())
    }
    withExtendedLifetime(timer) { CFRunLoopRun() }
    exit(test.status)
}
