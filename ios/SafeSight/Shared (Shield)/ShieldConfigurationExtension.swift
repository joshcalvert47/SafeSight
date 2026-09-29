//
//  ShieldConfigurationExtension.swift
//  Shared (Shield)
//
//  Created by Josh Calvert on 24/09/2026.
//
//  Customizes the appearance of the shield SafeSight shows when a blocked app
//  or website is opened. The class name must match NSExtensionPrincipalClass
//  in the extension's Info.plist.
//

import ManagedSettings
import ManagedSettingsUI
import UIKit

final class ShieldConfigurationExtension: ShieldConfigurationDataSource {

    override func configuration(shielding application: Application) -> ShieldConfiguration {
        shieldConfiguration()
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        shieldConfiguration()
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        shieldConfiguration()
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
        shieldConfiguration()
    }

    private func shieldConfiguration() -> ShieldConfiguration {
        ShieldConfiguration(
            backgroundBlurStyle: .systemMaterialDark,
            backgroundColor: UIColor(red: 0.07, green: 0.09, blue: 0.12, alpha: 1.0),
            title: ShieldConfiguration.Label(text: "SafeSight", color: .white),
            subtitle: ShieldConfiguration.Label(
                text: "This app is blocked by SafeSight",
                color: UIColor(white: 1.0, alpha: 0.85)
            ),
            primaryButtonLabel: ShieldConfiguration.Label(text: "", color: .white)
        )
    }
}