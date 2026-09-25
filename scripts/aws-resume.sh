#!/usr/bin/env bash
# Resumes DraftPage after scripts/aws-pause.sh: starts the database, waits until it's
# available, then runs 1 app task and waits until it's healthy.
source "$(dirname "$0")/aws-lib.sh"
require_session
CLUSTER=$(tf_out ecs_cluster_name)
SERVICE=$(tf_out ecs_service_name)
URL=$(tf_out app_url)

state=$(aws_ rds describe-db-instances --db-instance-identifier draftpage --query 'DBInstances[0].DBInstanceStatus' --output text)
if [ "$state" = stopped ]; then
  echo "▸ starting the database (usually 3–6 minutes)"
  aws_ rds start-db-instance --db-instance-identifier draftpage >/dev/null
elif [ "$state" != available ]; then
  echo "▸ database is '$state'; waiting for it"
fi
aws_ rds wait db-instance-available --db-instance-identifier draftpage
echo "  database available"

echo "▸ app → 1 task"
aws_ ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 >/dev/null
aws_ ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
curl -fsS "$URL/api/health?db=1" && echo
echo "✓ running: $URL"
