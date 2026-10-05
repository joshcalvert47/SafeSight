//
//  ViewController.swift
//  Shared (App)
//
//  Created by Josh Calvert on 22/09/2026.
//
//  Hosts Main.html (the legacy dashboard used by the macOS app and by
//  Script.js). The iOS app never loads it — SceneDelegate roots the app at
//  SafeSightTabView — so the iOS-specific dashboard/pairing logic that used
//  to live here is gone with the parent/admin feature.
//

import WebKit
import SwiftUI

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.joshc.SafeSight.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }

        if body == "open-app-blocker" {
            presentAppBlocker()
            return
        }

        if body == "open-block-sites" {
            presentBlockSites()
            return
        }

#if os(macOS)
        if body != "open-preferences" {
            return
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                NSApp.terminate(self)
            }
        }
#endif
    }

    /// Presents the SwiftUI app-blocker root. On iOS this shows the Filter
    /// page; on macOS it explains that app limits live in the iOS version.
    private func presentAppBlocker() {
        let root = AppBlockingRootView()

#if os(iOS)
        presentSheet(root)
#else
        let controller = NSHostingController(rootView: root)
        controller.view.frame = NSRect(x: 0, y: 0, width: 560, height: 440)
        presentAsSheet(controller)
#endif
    }

    /// Presents the SwiftUI "Web Filter" page — the app's own copy of every
    /// Safari extension option, written to the shared App Group that the
    /// extension reads through SafariWebExtensionHandler.
    private func presentBlockSites() {
        let root = ExtensionSettingsPage(isDoneSheet: true)

#if os(iOS)
        presentSheet(root)
#else
        let controller = NSHostingController(rootView: root)
        controller.view.frame = NSRect(x: 0, y: 0, width: 560, height: 520)
        presentAsSheet(controller)
#endif
    }

#if os(iOS)
    /// Presents a SwiftUI sheet (Main.html paths only — the native app roots
    /// at SafeSightTabView and never routes through this controller).
    private func presentSheet<Content: View>(_ root: Content) {
        let host = UIHostingController(rootView: root)
        host.modalPresentationStyle = .pageSheet
        present(host, animated: true)
    }
#endif
}
