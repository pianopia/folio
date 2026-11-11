#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ID="${PROJECT_ID:-pianopia}"
REGION="${REGION:-asia-northeast1}"
SERVICE_NAME="${SERVICE_NAME:-folio}"
: "${GCLOUD_ACCOUNT:?Set GCLOUD_ACCOUNT to the Google account authorized for this project}"
: "${TURSO_DATABASE_URL:?Set the dedicated Turso database URL}"
TAG="$(git rev-parse --short=12 HEAD)"
GCLOUD=(gcloud --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT")
"${GCLOUD[@]}" builds submit . --config=cloudbuild.yaml \
  --substitutions="_REGION=$REGION,_REPOSITORY=folio,_TAG=$TAG"
"${GCLOUD[@]}" run deploy "$SERVICE_NAME" \
  --image="$REGION-docker.pkg.dev/$PROJECT_ID/folio/folio:$TAG" \
  --region="$REGION" --platform=managed --allow-unauthenticated \
  --service-account="folio-runtime@$PROJECT_ID.iam.gserviceaccount.com" \
  --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=3 \
  --concurrency=40 --timeout=120 \
  --update-env-vars="NODE_ENV=production,HOST=0.0.0.0,TURSO_DATABASE_URL=$TURSO_DATABASE_URL,LEGACY_OWNER_EMAIL=${LEGACY_OWNER_EMAIL:-},UPLOAD_BUCKET=${UPLOAD_BUCKET:-pianopia-folio-artworks}" \
  --update-secrets="TURSO_AUTH_TOKEN=folio-turso-auth-token:latest,TOKEN_ENCRYPTION_KEY=folio-token-encryption-key:latest" --remove-secrets="API_TOKEN" --quiet
SERVICE_URL="$("${GCLOUD[@]}" run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)')"
"${GCLOUD[@]}" run services update "$SERVICE_NAME" --region="$REGION" \
  --update-env-vars="WEB_ORIGIN=$SERVICE_URL,API_ORIGIN=$SERVICE_URL" --quiet
printf 'Web: %s\nAPI: %s/api/health\n' "$SERVICE_URL" "$SERVICE_URL"
