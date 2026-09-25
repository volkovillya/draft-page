#!/usr/bin/env bash
# Runs the one-off migration task on ECS and waits for it (run before each deploy).
#   1. starts the draftpage-migrate task definition on Fargate in a public subnet
#      (public IP only so it can pull the image and read the secret; nothing can reach it)
#   2. waits until it stops, prints its log lines, and fails if the exit code isn't 0
# Uses your `aws login --profile draftpage` session and the local Terraform outputs.
source "$(dirname "$0")/aws-lib.sh"
require_session

CLUSTER=$(tf_out ecs_cluster_name)
SUBNET=$(terraform -chdir=infra output -json public_subnet_ids | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0))[0])')
SG=$(tf_out app_security_group_id)

echo "▸ starting draftpage-migrate in $CLUSTER ($REGION)"
TASK_ARN=$(aws_ ecs run-task --cluster "$CLUSTER" --task-definition draftpage-migrate --launch-type FARGATE \
  --count 1 --started-by migrate-script \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
TASK_ID=${TASK_ARN##*/}
echo "  task $TASK_ID"

echo "▸ waiting for it to finish (usually under a minute)"
aws_ ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

read -r CODE REASON < <(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text)

echo "▸ logs"
aws_ logs get-log-events --log-group-name /ecs/draftpage --log-stream-name "migrate/migrate/$TASK_ID" \
  --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || echo "  (no log stream: the container never started)"

if [ "$CODE" = "0" ]; then
  echo "✓ migrations applied"
else
  echo "✗ migrate task failed: exit code $CODE, reason: $REASON"
  exit 1
fi
