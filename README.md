# folio

A Google Drive connected artwork library for Web, iOS, and Android.

- Production Web: https://folio-biti2v34ya-an.a.run.app
- API health: https://folio-biti2v34ya-an.a.run.app/api/health
- Public source: https://github.com/pianopia/folio

- Web: Remix 2 + TypeScript, served as an SPA by the Hono application.
- API: Bun + Hono, with the Web and `/api/*` on one Cloud Run origin.
- Database: a dedicated Turso database through `@libsql/client`.
- Mobile: React Native + Expo SDK 54, using the same API.

## Features

Google account sign-in, private per-user Drive connections, explicit group sharing, group and collection organization, search, favorites, artwork editing, Google Drive import, direct image uploads, and one-click image copying. Drive browsing uses 512px thumbnails, 1024px detail previews, bounded caches, nearby-image preloading, and previous/next navigation. Copying fetches the original image and writes PNG data to the clipboard.

Each Google account has its own library and Drive authorization. Groups form access-control boundaries; only owners can add or remove read-only members.

## Local development

Bun 1.2.20 is the validated runtime.

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

Web: `http://127.0.0.1:5173`. API: `http://127.0.0.1:3001/api/health`.

Leave `TURSO_DATABASE_URL` empty to use a local SQLite file through libSQL. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use a dedicated Turso database. The application creates its tables automatically; new accounts receive a private empty group. Production requires Turso and never falls back to an ephemeral local database.

The sample photos are loaded from Unsplash. The sign-in screen offers an explicit sample-only **Demo mode** that keeps demo edits in the browser. Those edits are not synchronized to the API.

## Cloud Run

The root Dockerfile builds the Remix SPA and bundles the Bun/Hono server. The runtime image contains the server, the static assets, and the libSQL runtime dependencies. Static files are public; library and Google Drive APIs require a per-user Google-authenticated session. The former shared workspace API token no longer authenticates any endpoint.

Production defaults:

- GCP project: `pianopia`
- Region: `asia-northeast1`
- Cloud Run service / Artifact Registry repository: `folio`
- Runtime service account: `folio-runtime`
- Database: a new Turso database named `folio`

Runtime configuration:

| Variable                                    | Purpose                                                           |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `UPLOAD_BUCKET`                             | Private Cloud Storage bucket for unconnected users                |
| `TURSO_DATABASE_URL`                        | Dedicated Turso database URL                                      |
| `TURSO_AUTH_TOKEN`                          | Database-scoped token, injected from Secret Manager               |
| `LEGACY_OWNER_EMAIL`                        | Explicit verified owner allowed to migrate the old workspace once |
| `TOKEN_ENCRYPTION_KEY`                      | 64-character hexadecimal key for Google OAuth token encryption    |
| `WEB_ORIGIN`                                | Exact public Web origin for CORS and redirects                    |
| `API_ORIGIN`                                | Public API origin for Google OAuth callbacks                      |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional until Google Drive OAuth is configured                   |

The runtime uses these application secrets:

- `folio-turso-auth-token`
- `folio-token-encryption-key`
- `folio-google-client-id`
- `folio-google-client-secret`

Do not put secret values in source files, Docker build arguments, GitHub, or public build logs. The deployment script references Secret Manager names only. To redeploy after the initial infrastructure setup:

```sh
GCLOUD_ACCOUNT=you@example.com \
PROJECT_ID=pianopia \
TURSO_DATABASE_URL=libsql://YOUR-DEDICATED-DATABASE.turso.io \
./scripts/deploy.sh
```

The script builds an image in Cloud Build, deploys it, and updates the Web/API origins using the actual Cloud Run service URL. Maximum instances default to 3; minimum instances to 0.

Sign in with your Google account on the Web. Each login creates an opaque, random seven-day HttpOnly session; only its SHA-256 hash is stored in Turso. Logout revokes that session immediately. Shared `API_TOKEN` values and old workspace cookies are rejected.

The sign-in flow requests `openid email profile`. Drive connection is separate and requests `drive.readonly` plus `drive.file`; the verified Google subject must match the signed-in user. OAuth uses one-time server-stored state, browser binding, nonce and PKCE. Google ID-token signatures, issuer, audience, expiry and verified email are validated with Google's public keys.

Each account starts with a private group. In Settings, the owner can grant registered users read access to a specific group or remove that access. Members can view/copy only artworks explicitly placed in that group; they cannot browse the owner's Drive, edit artworks, move them to another group, or manage membership. Sharing includes future artworks added to the group. Media requests check current membership every time and send `Cache-Control: no-store`. An already viewed/downloaded image cannot be recalled from a recipient.

Existing unscoped records and the old global Drive credential are quarantined. Only the explicitly configured `LEGACY_OWNER_EMAIL`, verified through Google login, can migrate them into that account. Migration runs once, transactionally; unrelated users never inherit the old workspace or Drive connection. Set this deployment variable only for the known original owner. API credentials and Drive caches are scoped by Google subject. No administrator/shared-token bypass exists.

`GET /api/health` checks the database and reports `storage: "turso"`. An unauthenticated request to `/api/library` returns 401.

## Google Drive setup

Production has a dedicated **Folio Web (Cloud Run)** OAuth client configured in the `pianopia` project. Its credentials are injected from Secret Manager. The consent screen currently uses external **Testing** mode; only registered test users can authorize the application. Account authorization is a separate step from configuring the client.

Enable the Google Drive API in a Google Cloud project, configure the consent screen, and create an OAuth client of type **Web application**. Register this exact redirect URI using your deployed origin:

```text
https://YOUR-CLOUD-RUN-ORIGIN/api/drive/callback
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on Cloud Run (use Secret Manager for the secret). Sign in, then choose **Google Drive を接続** in the Web.

The application requests `drive.readonly` for browsing and `drive.file` to create/manage files created or selected through Folio. Existing read-only connections must be reauthorized before uploading. It does not change or delete original Drive files. OAuth access/refresh tokens are encrypted with AES-256-GCM before being saved to Turso. The token-encryption key must remain stable across revisions. Disconnecting revokes Google's token and clears the preview caches.

Google OAuth credentials must be configured separately; deploying the service does not create a Google OAuth client or connect a Drive account.

## Image uploads

Choose **作品を追加** to select or drop up to 10 images. Click any selected thumbnail to inspect it at full size, move between images with the buttons or arrow keys, and remove unwanted files before uploading. Additional file selections and drops keep the pending selection, deduplicate the same files and enforce a combined limit of ten. One button uploads the entire selection with overall and per-file progress; successful files stay saved when another file fails. Supported originals: JPEG, PNG, WebP and GIF, up to 20 MiB and 32 million pixels each. The server decodes images to validate their actual format and creates bounded 512/1024px WebP previews. SVG, HTML and invalid image payloads are rejected.

The server selects the destination from the signed-in user's connection: connected accounts save to their own **Folio uploads** folder in Drive, and unconnected accounts save to private Cloud Storage. Missing Drive write permission asks for reauthorization; Drive failures never silently switch storage providers. Drive originals are kept when removing a library item. Removing a Cloud Storage artwork deletes its managed original and preview objects; a failed initial registration cleans up the objects created by that request.

Production uses bucket `pianopia-folio-artworks` in Tokyo with uniform bucket-level access and public access prevention. Set `UPLOAD_BUCKET` and grant the runtime service account `roles/storage.objectUser` on that bucket only. Originals and previews have no public or signed links; the API checks user/group access before serving either. Newly uploaded Drive images are primed into the private preview cache for immediate display.

API: `GET /api/uploads/status` reports the current destination and any required reauthorization. `POST /api/artworks/upload` accepts multipart fields `file`, `groupId`, optional `title` and `collection`. Clients cannot override the owner or destination. React Native uses the system photo picker and the same upload API.

## Mobile

```sh
cd apps/mobile
bun run start
# Xcode or Android SDK required for local simulators:
bun run ios
bun run android
```

Open the project in Expo Go, then choose **ブラウザでGoogleログイン** in Settings. Confirm the displayed device code in the signed-in Web app, approve that device, and return to the mobile app to finish. This exchanges a single-use device secret for a per-user session stored in SecureStore. It never uses the old workspace token. Local iOS simulators can use `http://localhost:3001`; Android emulators use `http://10.0.2.2:3001`. Use an HTTPS API origin with Google OAuth configured for physical devices.

Google Drive is connected from the Web first. The mobile app then uses the same signed-in user’s private connection. Store publication and signed app binaries are not included.

## Validation

```sh
bun run check
bun run test
bun run build
cd apps/mobile
bunx expo export --platform all --output-dir /tmp/folio-mobile-export
```

The API tests exercise cross-user isolation, group membership and revocation, rejection of legacy shared tokens, session revocation, one-time legacy migration, single-use mobile grants, signed Google ID-token validation, OAuth state/nonce/PKCE, per-user thumbnail caching, persistence, concurrency limits, and expiry recovery. Upload UI tests cover preview/navigation/removal before upload, additional selection and drops, the combined selection limit, sending the complete selection with one action, and retrying only failed files. Local API tests use isolated in-memory libSQL databases. Real Google-account latency depends on the connected Drive; the preview tests use a simulated Drive provider.

## API overview

| Method         | Path                                | Purpose                                  |
| -------------- | ----------------------------------- | ---------------------------------------- |
| GET            | `/api/health`                       | Readiness/database check                 |
| GET            | `/api/auth/login`                   | Sign in with Google                      |
| GET            | `/api/auth/me`                      | Current signed-in user                   |
| DELETE         | `/api/session`                      | Revoke current session                   |
| POST           | `/api/auth/device/start`            | Start mobile device sign-in              |
| POST           | `/api/auth/device/approve`          | Approve a device as signed-in user       |
| POST           | `/api/auth/device/token`            | Redeem the single-use device grant       |
| GET / POST     | `/api/groups/:id/members`           | Owner lists/adds read-only group members |
| DELETE         | `/api/groups/:id/members/:userId`   | Owner removes access                     |
| GET            | `/api/artworks/:id/thumbnail`       | Preview after checking group access      |
| GET            | `/api/artworks/:id/image`           | Original after checking group access     |
| GET            | `/api/library`                      | Groups and artworks                      |
| POST           | `/api/groups`                       | Create a group                           |
| POST           | `/api/artworks`                     | Add an HTTPS image URL                   |
| PATCH / DELETE | `/api/artworks/:id`                 | Edit/remove a library item               |
| GET            | `/api/drive/status`                 | Drive configuration/connection status    |
| GET            | `/api/drive/connect`                | Start Google OAuth                       |
| GET            | `/api/drive/callback`               | OAuth callback                           |
| GET            | `/api/drive/files`                  | Paged image/folder list                  |
| POST           | `/api/drive/import`                 | Import selected image references         |
| GET            | `/api/drive/thumbnail/:id?size=512` | Cached preview (1024 also supported)     |
| GET            | `/api/drive/image/:id`              | Original image for copying               |
| DELETE         | `/api/drive`                        | Disconnect Drive                         |
