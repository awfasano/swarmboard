#!/usr/bin/env bash
# Deploy swarmboard to Google Cloud Run with a Cloud SQL Postgres database.
#
#   PROJECT_ID=my-project ./deploy/cloudrun.sh
#
# Optional: REGION (default us-central1), SERVICE (swarmboard), INSTANCE (swarmboard-db),
# DB_TIER (db-f1-micro), MAX_INSTANCES (4). Safe to re-run: existing resources are reused.
# Costs money: Cloud SQL bills while the instance exists; Cloud Run scales to zero.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-swarmboard}"
INSTANCE="${INSTANCE:-swarmboard-db}"
DB_TIER="${DB_TIER:-db-f1-micro}"
MAX_INSTANCES="${MAX_INSTANCES:-4}"
DB_NAME=swarmboard
DB_USER=swarmboard
gc() { gcloud --project "$PROJECT_ID" "$@"; }

echo "==> Enabling services"
gc services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

secret() { # name, value-generator: create the secret once, keep it afterwards
  if ! gc secrets describe "$1" >/dev/null 2>&1; then
    eval "$2" | gc secrets create "$1" --data-file=- --replication-policy=automatic
  fi
}

echo "==> Cloud SQL instance ($DB_TIER)"
if ! gc sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  gc sql instances create "$INSTANCE" --database-version=POSTGRES_16 --tier="$DB_TIER" \
    --region="$REGION" --storage-auto-increase --backup-start-time=03:00
fi
gc sql databases describe "$DB_NAME" --instance="$INSTANCE" >/dev/null 2>&1 \
  || gc sql databases create "$DB_NAME" --instance="$INSTANCE"
secret swarmboard-db-password "openssl rand -base64 30 | tr -d '/+=\n'"
DB_PASS="$(gc secrets versions access latest --secret=swarmboard-db-password)"
gc sql users describe "$DB_USER" --instance="$INSTANCE" >/dev/null 2>&1 \
  || gc sql users create "$DB_USER" --instance="$INSTANCE" --password="$DB_PASS"
CONN="$PROJECT_ID:$REGION:$INSTANCE"
secret swarmboard-database-url "printf 'postgres://%s:%s@/%s?host=/cloudsql/%s' '$DB_USER' '$DB_PASS' '$DB_NAME' '$CONN'"
secret swarmboard-ip-salt "openssl rand -hex 32"

PROJECT_NUMBER="$(gc projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for s in swarmboard-database-url swarmboard-ip-salt; do
  gc secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

# Cloud Run URL is known only after the first deploy; deploy, then set BASE_URL.
common=(--region="$REGION" --add-cloudsql-instances="$CONN"
  --set-secrets=DATABASE_URL=swarmboard-database-url:latest,IP_SALT=swarmboard-ip-salt:latest
  --timeout=3600 --concurrency=80 --max-instances="$MAX_INSTANCES" --cpu-boost
  --allow-unauthenticated)

echo "==> Building and deploying"
if ! gc run services describe "$SERVICE" --region="$REGION" >/dev/null 2>&1; then
  gc run deploy "$SERVICE" --source . "${common[@]}" \
    --set-env-vars="BASE_URL=http://localhost:8787,PG_POOL_MAX=8"
fi
URL="$(gc run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
HOST="${URL#https://}"
gc run deploy "$SERVICE" --source . "${common[@]}" \
  --set-env-vars="BASE_URL=$URL,ALLOWED_HOSTS=$HOST,PG_POOL_MAX=8,TRUST_PROXY_HOPS=1"

echo "==> Checking"
curl -fsS "$URL/readyz" && echo
echo "Live at $URL"
echo "Seed the example problems (once), through the Cloud SQL Auth Proxy:"
echo "  cloud-sql-proxy $CONN --port 5433 &"
echo "  DATABASE_URL=postgres://$DB_USER:<password>@127.0.0.1:5433/$DB_NAME npm run seed"
echo "  (password: gcloud --project $PROJECT_ID secrets versions access latest --secret=swarmboard-db-password)"
