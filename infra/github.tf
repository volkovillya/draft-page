# Pause and resume DraftPage from a phone: GitHub Actions buttons (.github/workflows/aws-power.yml).
#
#   GitHub Actions ──OIDC token──▶ AWS STS ──▶ role draftpage-github-ops ──▶ ECS service count
#                                                                        └─▶ RDS stop / start
#
# No AWS keys are stored in GitHub. On each run GitHub issues a short-lived signed token that
# says which repository and branch the workflow runs from; AWS checks it against the trust
# policy below and hands out credentials for one hour. ($0: IAM and OIDC are free; the repo is
# private, so each run uses a few of the 2,000 free GitHub Actions minutes a month.)
# The Free plan's SCP blocked creating OIDC providers; the Paid plan allows it.

locals {
  github_repo = "volkovillya/draft-page"
}

# Tells AWS to trust tokens signed by GitHub Actions. AWS verifies GitHub's certificate
# itself, so no thumbprint is needed.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = { Name = "github-actions" }
}

# Only workflows running from this repository's main branch may use the role. Pull requests,
# other branches, forks and other repositories get a different "sub" and are refused.
data "aws_iam_policy_document" "github_ops_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_ops" {
  name                 = "draftpage-github-ops"
  description          = "GitHub Actions (main branch of ${local.github_repo}): pause/resume the DraftPage app and database"
  assume_role_policy   = data.aws_iam_policy_document.github_ops_trust.json
  max_session_duration = 3600
}

# Exactly what pause and resume need, on exactly these two resources. It can't deploy, change
# the task definition, read data or touch anything else.
data "aws_iam_policy_document" "github_ops" {
  statement {
    sid       = "ScaleTheAppService"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.app.id]
  }
  statement {
    sid       = "StopStartTheDatabase"
    actions   = ["rds:StopDBInstance", "rds:StartDBInstance", "rds:DescribeDBInstances"]
    resources = [aws_db_instance.main.arn]
  }
}

resource "aws_iam_role_policy" "github_ops" {
  name   = "draftpage-github-ops"
  role   = aws_iam_role.github_ops.id
  policy = data.aws_iam_policy_document.github_ops.json
}
