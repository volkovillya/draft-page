#!/usr/bin/env bash
# Pauses DraftPage to save credits: the app goes to 0 tasks (no Fargate or public-IP cost)
# and the database stops (storage keeps billing, ~$2.40/month). Paused ≈ $4/month in total.
# AWS starts a stopped database again by itself after 7 days; run this again to re-stop it.
# Resume with scripts/aws-resume.sh. No Terraform changes: Terraform ignores the task count.
source "$(dirname "$0")/aws-lib.sh"
require_session
CLUSTER=$(tf_out ecs_cluster_name)
SERVICE=$(tf_out ecs_service_name)

echo "▸ app → 0 tasks"
aws_ ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 >/dev/null
aws_ ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
echo "  stopped"

state=$(aws_ rds describe-db-instances --db-instance-identifier draftpage --query 'DBInstances[0].DBInstanceStatus' --output text)
if [ "$state" = available ]; then
  echo "▸ stopping the database (takes a few minutes)"
  aws_ rds stop-db-instance --db-instance-identifier draftpage >/dev/null
  echo "  stop requested; it shows 'stopped' in the RDS console when done"
else
  echo "▸ database is '$state', leaving it"
fi
echo "✓ paused. Note: AWS restarts a stopped database automatically after 7 days."
