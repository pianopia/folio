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

No signed store binaries or review submissions have been created yet.

## Apple account verification

On 2026-11-13, the authenticated Apple Developer account was verified as `grandpianoaoa@gmail.com`, individual team `G28EXCQ6J5`. Membership renewal date shown: 2027-06-26. The updated Apple Developer Program License Agreement was accepted after explicit user confirmation. The update notice disappeared from App Store Connect, and identifier registration became accessible. App Store Connect record `6834296350` was created as `Folio - 画像と作品のライブラリ` using `studio.folio.app` (SKU `pianopia-folio-ios`). The short name `Folio` was unavailable. Japanese description, keywords, marketing URL, version `1.0.0`, copyright and manual-release setting were saved. The subtitle and Graphics & Design primary category were also saved. The App ID is registered with the Sign in with Apple capability; the app/plugin entitlement is configured, and native authentication UI/backend are now implemented. After the user completed EAS two-factor authentication, the existing distribution certificate was reused and a Folio provisioning profile was created (portal ID `4A35NRZ2HA`, expiry 2027-06-30). No signed release binary or review submission has been created yet.

## Implemented submission requirements

- Native Apple login verifies issuer, audience, nonce, signature, expiry and verified email. Nonces are single-use, and authorization-code tokens must match the signed identity. Refresh tokens are encrypted. Existing accounts are linked only through an explicit authenticated action; matching email addresses alone never merge accounts.
- Apple token exchange/revocation uses a Folio-only Sign in with Apple key stored in the dedicated Secret Manager secret. The runtime service account has access; the downloaded temporary private key was removed. Keys are never bundled into the app or repository.
- Google login uses the platform authentication session and a fixed `folio://auth` callback. Native Drive connection is bound to a one-time, explicitly approved Folio-account ticket and a cookie/state/PKCE protected OAuth exchange, returning to `folio://drive`.
- Account deletion requires explicit confirmation, removes the caller's private Cloud Storage files, metadata, group memberships and sessions, and revokes Apple/Drive authorization. User-owned Drive files remain intact. Failed external cleanup keeps a retryable deletion state; database guards block writes from requests already in flight. A short tombstone outlives the server request deadline.
- `/privacy.html`, `/support.html` and `/delete-account.html` describe the actual data flow, contact and deletion behavior. Native settings link to privacy/support pages.
- Automated API tests cover token verification, replay and identity-linking protections, native Drive account isolation, deletion retries and preservation of other accounts. Device testing, release screenshots and store declarations remain necessary before App Review.
