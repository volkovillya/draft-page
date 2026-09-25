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
  read -r -p "  ⏎ Press Enter when that's done (Ctrl+C to stop here) " _
}
