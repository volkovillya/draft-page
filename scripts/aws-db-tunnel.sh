#!/usr/bin/env bash
# Opens a tunnel from your laptop to the production database through the running app task
# (ECS Exec port forwarding). Nothing is exposed to the internet: the traffic goes
# laptop → AWS Systems Manager → the Fargate task → RDS, authorized by your aws login session.
#   Needs: the Session Manager plugin (brew install --cask session-manager-plugin)
#          and a running app task (scripts/aws-resume.sh if paused).
# Usage: bash scripts/aws-db-tunnel.sh [local port, default 15432]; Ctrl+C closes it.
source "$(dirname "$0")/aws-lib.sh"
require_session
command -v session-manager-plugin >/dev/null || {
  echo "✗ Install the Session Manager plugin first: brew install --cask session-manager-plugin" >&2
  exit 1
}
LOCAL_PORT=${1:-15432}
CLUSTER=$(tf_out ecs_cluster_name)
SERVICE=$(tf_out ecs_service_name)
DB_HOST=$(tf_out db_endpoint)

TASK_ARN=$(aws_ ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING --query 'taskArns[0]' --output text)
[ "$TASK_ARN" != None ] || { echo "✗ No running app task. Run scripts/aws-resume.sh first." >&2; exit 1; }
TASK_ID=${TASK_ARN##*/}
RUNTIME_ID=$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[?name==`app`].runtimeId | [0]' --output text)

cat <<INFO
▸ tunnel: localhost:$LOCAL_PORT → $DB_HOST:5432 (via task $TASK_ID)

  Connect in another terminal, either way:

  As the app user (read/write data, no DDL), with a 15-minute IAM token:
    PGPASSWORD="\$(aws rds generate-db-auth-token --profile $PROFILE --region $REGION \\
      --hostname $DB_HOST --port 5432 --username draftpage_app)" \\
      psql "host=localhost port=$LOCAL_PORT dbname=draftpage user=draftpage_app sslmode=require"

  As the admin (full rights; be careful), with the RDS-managed password:
    PGPASSWORD="\$(aws secretsmanager get-secret-value --profile $PROFILE --region $REGION \\
      --secret-id "$(tf_out db_master_secret_arn)" --query SecretString --output text \\
      | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).password)')" \\
      psql "host=localhost port=$LOCAL_PORT dbname=draftpage user=draftpage_admin sslmode=require"

  (sslmode=require, not verify-full: the certificate is for $DB_HOST, not localhost.)
  Ctrl+C here closes the tunnel.
INFO

aws_ ssm start-session \
  --target "ecs:${CLUSTER}_${TASK_ID}_${RUNTIME_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$DB_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT"
