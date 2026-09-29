//
//  FirebaseIdentity.swift
//  Shared (App)
//
//  Setup (one time):
//  1. Xcode → File → Add Package Dependencies… →
//     https://github.com/firebase/firebase-ios-sdk
//     and add the FirebaseAuth, FirebaseCore, FirebaseFirestore and
//     GoogleSignIn products to the SafeSight app target.
//  2. Drop GoogleService-Info.plist (from the Firebase console) into the app
//     target so FirebaseApp can configure itself at launch.
//  Until both are in place everything here compiles to a stub: no user is
//  signed in and Google sign-in returns false. The only sign-in method is
//  Google — see AccountStore in AppSettingsStore.swift, which owns the
//  users/{uid} account document and the per-account PIN.
//

import Foundation
#if canImport(FirebaseCore)
import FirebaseCore
#endif
#if canImport(FirebaseAuth)
import FirebaseAuth
#endif
#if canImport(GoogleSignIn)
import GoogleSignIn
#endif
#if canImport(UIKit)
import UIKit
#endif

enum FirebaseIdentity {

    /// Auth.auth() crashes if the default FirebaseApp doesn't exist yet, so
    /// every entry point runs this first. Configures once, and only when
    /// GoogleService-Info.plist is actually in the bundle (configure() itself
    /// fatalErrors without it).
    private static let configureOnce: Void = {
        #if canImport(FirebaseCore)
        guard FirebaseApp.app() == nil else { return }
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            NSLog("SafeSight: GoogleService-Info.plist missing — Firebase not configured")
            return
        }
        FirebaseApp.configure()
        #endif
    }()

    static var isConfigured: Bool {
        _ = configureOnce
        #if canImport(FirebaseAuth)
        return FirebaseApp.app() != nil
        #else
        return false
        #endif
    }

    static var currentUid: String? {
        _ = configureOnce
        #if canImport(FirebaseAuth)
        return Auth.auth().currentUser?.uid
        #else
        return nil
        #endif
    }

    static var currentProfile: (uid: String, email: String?, name: String?, picture: String?)? {
        _ = configureOnce
        #if canImport(FirebaseAuth)
        guard let user = Auth.auth().currentUser else { return nil }
        return (user.uid, user.email, user.displayName, user.photoURL?.absoluteString)
        #else
        return nil
        #endif
    }

    @discardableResult
    static func signInWithGoogle() async -> Bool {
        _ = configureOnce
        #if canImport(FirebaseAuth) && canImport(GoogleSignIn) && canImport(UIKit) && os(iOS)
        guard FirebaseApp.app() != nil else { return false }
        guard let presenting = rootViewController() else { return false }
        // GIDSignIn fatalErrors ("No active configuration") unless a client ID
        // is set — pull it from GoogleService-Info.plist instead of relying on
        // an Info.plist key the template never had.
        guard let clientID = googleClientID() else {
            NSLog("SafeSight: no CLIENT_ID in GoogleService-Info.plist — Google sign-in unavailable")
            return false
        }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenting)
            guard let idToken = result.user.idToken?.tokenString else { return false }
            let credential = GoogleAuthProvider.credential(
                withIDToken: idToken,
                accessToken: result.user.accessToken.tokenString
            )
            _ = try await Auth.auth().signIn(with: credential)
            return true
        } catch {
            NSLog("SafeSight: Google sign-in failed — \(error.localizedDescription)")
            return false
        }
        #else
        NSLog("SafeSight: GoogleSignIn is not installed — Google sign-in skipped")
        return false
        #endif
    }

    static func currentToken() async -> String? {
        _ = configureOnce
        #if canImport(FirebaseAuth)
        guard FirebaseApp.app() != nil else { return nil }
        guard let user = Auth.auth().currentUser else { return nil }
        return try? await user.getIDToken()
        #else
        return nil
        #endif
    }

    static func signOut() {
        _ = configureOnce
        #if canImport(FirebaseAuth)
        guard FirebaseApp.app() != nil else { return }
        try? Auth.auth().signOut()
        #endif
    }

    #if canImport(FirebaseCore)
    /// CLIENT_ID from the bundled GoogleService-Info.plist (nil if absent).
    static func googleClientID() -> String? {
        guard
            let url = Bundle.main.url(forResource: "GoogleService-Info", withExtension: "plist"),
            let data = try? Data(contentsOf: url),
            let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return plist["CLIENT_ID"] as? String
    }
    #else
    static func googleClientID() -> String? { nil }
    #endif

    #if canImport(FirebaseAuth) && canImport(GoogleSignIn) && canImport(UIKit) && os(iOS)
    private static func rootViewController() -> UIViewController? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: \.isKeyWindow)?
            .rootViewController
    }
    #endif
}
