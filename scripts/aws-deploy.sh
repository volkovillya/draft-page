#!/usr/bin/env bash
# Deploys a new version of DraftPage to AWS, migrations first:
#   1. build the image (linux/arm64) and push it to ECR with a new, unique tag
#   2. YOU plan + apply with the migrate task on the new tag (only that task definition changes)
#   3. run the migrations with that image (scripts/aws-migrate.sh)
#   4. the script sets app_image_tag in infra/terraform.tfvars; YOU plan + apply (app moves)
#   5. check the live URL
# After each of your applies it checks AWS really uses the new tag before going on.
# Terraform plan/apply are never run by this script; it prints them and waits for you.
# Usage: bash scripts/aws-deploy.sh [tag]   (default: git commit hash, else a timestamp)
source "$(dirname "$0")/aws-lib.sh"
require_session

REPO=$(tf_out ecr_repository_url)
URL=$(tf_out app_url)
if [ -n "${1:-}" ]; then
  TAG=$1
elif git rev-parse --verify -q HEAD >/dev/null && [ -z "$(git status --porcelain)" ]; then
  TAG=$(git rev-parse --short=12 HEAD)
else
  TAG=$(date -u +%Y%m%d-%H%M%S) # no commit, or uncommitted changes: a timestamp tag
fi
CURRENT=$(tf_var app_image_tag)
echo "▸ deploying $TAG (currently running $CURRENT) to $URL"

echo "▸ 1/5 build and push $REPO:$TAG"
aws_ ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}" >/dev/null
docker build --quiet --platform linux/arm64 -t "$REPO:$TAG" . >/dev/null
docker push --quiet "$REPO:$TAG" >/dev/null
echo "  pushed"

echo "▸ 2/5 point the migrate task at the new image. In a SECOND terminal (keep this one open), run:"
echo "    terraform -chdir=infra plan -var migrate_image_tag=$TAG -out=deploy-migrate.tfplan"
echo "    terraform -chdir=infra apply deploy-migrate.tfplan"
echo "  Expected plan: 1 to add, 0 to change, 1 to destroy (aws_ecs_task_definition.migrate only)."
pause_for
wait_for_tag "migrate task" "$TAG" "task_family_tag draftpage-migrate"

echo "▸ 3/5 migrate"
bash scripts/aws-migrate.sh

echo "▸ 4/5 move the app. Setting app_image_tag = \"$TAG\" in infra/terraform.tfvars. In your SECOND terminal, run:"
sed -i '' -E "s/^app_image_tag( *)= \".*\"/app_image_tag\1= \"$TAG\"/" infra/terraform.tfvars
echo "    terraform -chdir=infra plan -out=deploy-app.tfplan"
echo "    terraform -chdir=infra apply deploy-app.tfplan"
echo "  Expected plan: 1 to add, 1 to change, 1 to destroy (app task definition replaced,"
echo "  service updated). Apply waits until the new task is healthy; a failing one is rolled back."
pause_for
CLUSTER=$(tf_out ecs_cluster_name)
SERVICE=$(tf_out ecs_service_name)
wait_for_tag "running app service" "$TAG" "service_tag $CLUSTER $SERVICE"

echo "▸ 5/5 check $URL"
curl -fsS "$URL/api/health?db=1" && echo
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
[ "$code" = 200 ] || { echo "✗ landing page returned $code"; exit 1; }
echo "✓ $TAG is live. Rollback: set app_image_tag back to \"$CURRENT\" in infra/terraform.tfvars, then plan + apply."
