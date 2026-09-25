# Shared helpers for the scripts/aws-*.sh scripts (sourced, not run).
# Everything uses your `aws login --profile draftpage` session and the local Terraform
# outputs; nothing here stores credentials.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE=${AWS_PROFILE_NAME:-draftpage}

tf_out() { terraform -chdir=infra output -raw "$1"; }
tf_var() { terraform -chdir=infra console <<<"var.$1" | tr -d '"'; }

REGION=$(tf_var region)
ACCOUNT=$(tf_var account_id)
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# Refuse to run against any account but DraftPage's (this laptop also has company profiles).
require_session() {
  local who
  if ! who=$(aws_ sts get-caller-identity --query Account --output text 2>/dev/null); then
    echo "✗ No valid AWS session. Run: aws login --profile $PROFILE" >&2
    exit 1
  fi
  if [ "$who" != "$ACCOUNT" ]; then
    echo "✗ Profile $PROFILE points at account $who, expected $ACCOUNT. Stopping." >&2
    exit 1
  fi
}

pause_for() {
  echo
  read -r -p "  ⏎ Press Enter here once the apply has finished (Ctrl+C to stop) " _
}

# Image tag of the latest revision of a task definition family (e.g. draftpage-migrate).
task_family_tag() {
  aws_ ecs describe-task-definition --task-definition "$1" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*://'
}

# Image tag the ECS service is actually running (its primary deployment).
service_tag() {
  local td
  td=$(aws_ ecs describe-services --cluster "$1" --services "$2" \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text)
  aws_ ecs describe-task-definition --task-definition "$td" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*://'
}

# Keeps waiting until `check` prints the wanted tag, so a skipped apply can't slip through.
wait_for_tag() {
  local what=$1 want=$2 check=$3 got
  while got=$($check) && [ "$got" != "$want" ]; do
    echo "  ✗ the $what still uses $got, not $want: run the plan + apply above first."
    pause_for
  done
  echo "  ✓ the $what uses $want"
}
