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
- Confirm store privacy/data-safety declarations against the implementation and published privacy/support/deletion pages.
- Verify native release builds on devices; capture real iPhone/iPad/Android screenshots.
- Complete listing details, age rating, content declarations, reviewer access and release settings in the respective consoles.
- Check whether the Play account must complete closed testing before production access.

The first signed iOS production build has been uploaded to App Store Connect. App Review submission is still pending.

## Apple account verification

On 2026-11-13, the authenticated Apple Developer account was verified as `grandpianoaoa@gmail.com`, individual team `G28EXCQ6J5`. Membership renewal date shown: 2027-06-26. The updated Apple Developer Program License Agreement was accepted after explicit user confirmation. The update notice disappeared from App Store Connect, and identifier registration became accessible. App Store Connect record `6834296350` was created as `Folio - 画像と作品のライブラリ` using `studio.folio.app` (SKU `pianopia-folio-ios`). The short name `Folio` was unavailable. Japanese description, keywords, marketing URL, version `1.0.0`, copyright and manual-release setting were saved. The subtitle and Graphics & Design primary category were also saved. The App ID is registered with the Sign in with Apple capability; the app/plugin entitlement is configured, and native authentication UI/backend are now implemented. After the user completed EAS two-factor authentication, the existing distribution certificate was reused and a Folio provisioning profile was created (portal ID `4A35NRZ2HA`, expiry 2027-06-30). A signed release binary was subsequently built and uploaded; App Review remains pending.

## Implemented submission requirements

- Native Apple login verifies issuer, audience, nonce, signature, expiry and verified email. Nonces are single-use, and authorization-code tokens must match the signed identity. Refresh tokens are encrypted. Existing accounts are linked only through an explicit authenticated action; matching email addresses alone never merge accounts.
- Apple token exchange/revocation uses a Folio-only Sign in with Apple key stored in the dedicated Secret Manager secret. The runtime service account has access; the downloaded temporary private key was removed. Keys are never bundled into the app or repository.
- Google login uses the platform authentication session and a fixed `folio://auth` callback. Native Drive connection is bound to a one-time, explicitly approved Folio-account ticket and a cookie/state/PKCE protected OAuth exchange, returning to `folio://drive`.
- Account deletion requires explicit confirmation, removes the caller's private Cloud Storage files, metadata, group memberships and sessions, and revokes Apple/Drive authorization. User-owned Drive files remain intact. Failed external cleanup keeps a retryable deletion state; database guards block writes from requests already in flight. A short tombstone outlives the server request deadline.
- `/privacy.html`, `/support.html` and `/delete-account.html` describe the actual data flow, contact and deletion behavior. Native settings link to privacy/support pages.
- Automated API tests cover token verification, replay and identity-linking protections, native Drive account isolation, deletion retries and preservation of other accounts. Device testing, release screenshots and store declarations remain necessary before App Review.

## iOS release milestone — 2026-11-13

- EAS production build `6e54ec46-fe30-4601-aff1-5a08cc300124` succeeded: version `1.0.0`, build `1`.
- EAS submission `19d7330d-8315-4e8d-9f5c-172f9b4edeca` completed successfully. Apple processed build `812e0264-fd0f-4dd6-a399-b5ed2c447b78` as `VALID` / `APP_STORE_ELIGIBLE`, and it is attached to iOS version `1.0.0`.
- A submission key with the `APP_MANAGER` role is stored by EAS for this project. It is separate from the API’s Sign in with Apple key; neither private key is in source control.
- Privacy/support URLs, content-rights declaration, age-rating questionnaire and privacy disclosures were saved. Declared linked data: name, email, user ID, photos/videos and other user content, all for app functionality. No tracking categories were declared.
- Price is free, with Japan as the pricing base. Availability was configured for all 175 territories returned by Apple. Release remains manual.
- Local iOS Release compilation succeeded with no errors or warnings. Simulator installation/boot failed on iOS 26.2 and 18.6 with CoreSimulator Mach `-308`/invalid-state errors. Restarting Simulator and CoreSimulatorService did not resolve the issue, and the UI automation bridge repeatedly timed out. No screenshots were captured or uploaded; native screen/authentication verification is still pending.
- Remaining before App Review: release screenshots, reviewer contact phone and final device/authentication verification. Google Play account is still awaiting confirmation.

## Review-readiness follow-up

The user-provided review phone was saved and verified in App Store Connect (kept out of this public repository). Contact and reviewer access notes are complete. The review draft is `d5906159-96ba-4fa3-a9bf-6e366954abb6`; adding version 1.0.0 now reports only missing iPhone and iPad screenshots. Description, keywords, subtitle and all URLs were re-saved together and verified; localization updates must preserve the existing fields because the Apple SDK turns omitted text fields into null. Google Play remains on hold at the user's request.
