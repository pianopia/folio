# Store submission

`ja-JP.json` contains draft Japanese listing copy. It has not been published.

## Build

From `apps/mobile`, after EAS linking and signing credentials are configured:

```sh
bunx eas-cli@latest build --platform all --profile production
```

`production` produces store-signed iOS and Android builds. Android submissions target an internal draft release. An iOS EAS submission uploads to App Store Connect/TestFlight; it does not submit the app for App Review.

## Verification

Expo configuration introspection confirms the photo permission is localized and camera/microphone permissions are removed. Expo Doctor passes 17 of 18 checks; its remaining check flags React 18 in the Remix workspace alongside React 19 in the mobile workspace. Metro already resolves native React imports from the mobile package, but signed native builds and device testing must verify that isolation before submission.

## Remaining prerequisites

- Apple Developer membership/team are verified; confirm the Google Play Console account and signing authority.
- Apple bundle ID `studio.folio.app` is registered; confirm Android package availability in Play Console.
- Add an equivalent privacy-preserving login option for iOS alongside Google login.
- Replace the browser/device-code login flow with an appropriate in-app authentication experience.
- Implement in-app account deletion and corresponding server-side data/token cleanup.
- Publish accurate privacy, support and deletion URLs; confirm the store privacy/data-safety declarations against the final implementation.
- Verify native release builds on devices; capture real iPhone/iPad/Android screenshots.
- Complete listing details, age rating, content declarations, reviewer access and release settings in the respective consoles.
- Check whether the Play account must complete closed testing before production access.

No signed store binaries or review submissions have been created yet.

## Apple account verification

On 2026-11-13, the authenticated Apple Developer account was verified as `grandpianoaoa@gmail.com`, individual team `G28EXCQ6J5`. Membership renewal date shown: 2027-06-26. The updated Apple Developer Program License Agreement was accepted after explicit user confirmation. The update notice disappeared from App Store Connect, and identifier registration became accessible. App Store Connect record `6834296350` was created as `Folio - 画像と作品のライブラリ` using `studio.folio.app` (SKU `pianopia-folio-ios`). The short name `Folio` was unavailable. Japanese description, keywords, marketing URL, version `1.0.0`, copyright and manual-release setting were saved. The subtitle and Graphics & Design primary category were also saved. The App ID is registered with the Sign in with Apple capability; the app/plugin entitlement is configured, while authentication UI/backend implementation remains pending. No signing certificate or signed release binary has been created. EAS restored the Apple account from the local Keychain but requires fresh two-factor authentication; browser login alone does not authenticate the signing CLI.
