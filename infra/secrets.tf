# Phase 2 step 6: runtime secrets (~$0.40/month per secret).
#
# The database password already lives in the RDS-managed secret (see rds.tf). This adds the
# one other secret the app needs: the Auth0 values that must never be in the image, the repo
# or Terraform state. Non-secret Auth0 settings (domain, client id, base URL) are plain
# environment variables in the task definition.
#
# Terraform creates only the empty container. The value is written from the laptop with the
# AWS CLI (commands in the Phase 2 notes), so it never appears in Terraform code or state.
# ECS injects each JSON key as an environment variable when a task starts.

resource "aws_secretsmanager_secret" "auth0" {
  name        = "draftpage/auth0"
  description = "Auth0 secrets for DraftPage: {\"AUTH0_SECRET\": \"…\", \"AUTH0_CLIENT_SECRET\": \"…\"}"

  # Encrypted with the AWS-managed key aws/secretsmanager (no KMS key cost).
  # A deleted secret can be restored for 7 days before it's gone.
  recovery_window_in_days = 7

  tags = { Name = "draftpage-auth0" }
}
