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

- Confirm Apple Developer and Google Play Console accounts and signing authority.
- Confirm bundle/package IDs are available in those accounts.
- Add an equivalent privacy-preserving login option for iOS alongside Google login.
- Replace the browser/device-code login flow with an appropriate in-app authentication experience.
- Implement in-app account deletion and corresponding server-side data/token cleanup.
- Publish accurate privacy, support and deletion URLs; confirm the store privacy/data-safety declarations against the final implementation.
- Verify native release builds on devices; capture real iPhone/iPad/Android screenshots.
- Complete listing details, age rating, content declarations, reviewer access and release settings in the respective consoles.
- Check whether the Play account must complete closed testing before production access.

No signed store binaries or review submissions have been created yet.
