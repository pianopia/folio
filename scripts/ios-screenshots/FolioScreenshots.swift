import XCTest

final class FolioScreenshots: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "studio.folio.app")

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
    }

    private func text(_ label: String) -> XCUIElement {
        app.staticTexts[label].firstMatch
    }

    private func tap(_ label: String) {
        let element = text(label)
        XCTAssertTrue(element.waitForExistence(timeout: 20), "Missing text: \(label)\n\(app.debugDescription)")
        element.tap()
    }

    private func capture(_ name: String) {
        // Let downloaded sample images and native transitions finish rendering.
        Thread.sleep(forTimeInterval: 4)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testStoreScreenshots() {
        let heading = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "All artworks")).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 45), app.debugDescription)
        Thread.sleep(forTimeInterval: 10)
        capture("01-library")

        tap("♡ Favorites")
        capture("02-favorites")

        tap("▦ Library")
        tap("▪ Design studio")
        capture("03-group")

        tap("すべて")
        let artwork = app.images["Quiet forms"].firstMatch
        XCTAssertTrue(artwork.waitForExistence(timeout: 20), app.debugDescription)
        if !artwork.isHittable { app.swipeUp() }
        artwork.tap()
        let details = app.buttons["作品の詳細情報"]
        XCTAssertTrue(details.waitForExistence(timeout: 15), app.debugDescription)
        capture("04-artwork")

        details.tap()
        XCTAssertTrue(text("作品の詳細").waitForExistence(timeout: 10), app.debugDescription)
        capture("05-artwork-details")
    }
}
