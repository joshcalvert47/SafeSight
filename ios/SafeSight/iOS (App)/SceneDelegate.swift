//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Josh Calvert on 22/09/2026.
//

import UIKit
import SwiftUI
#if canImport(GoogleSignIn)
import GoogleSignIn
#endif

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let appWindow = UIWindow(windowScene: windowScene)
        appWindow.rootViewController = UIHostingController(rootView: SafeSightTabView())
        window = appWindow
        appWindow.makeKeyAndVisible()
    }

    #if canImport(GoogleSignIn)
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        GIDSignIn.sharedInstance.handle(url)
    }
    #endif

}
