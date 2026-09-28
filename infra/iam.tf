# Phase 2 step 7: IAM for the web workload ($0). Two roles, each allowed only what it uses.
#
#   execution role  → used by ECS itself to START a task: pull the image, fetch secrets
#                     into env vars, write logs. The app code never gets these rights.
#   app (task) role → the identity of the running DraftPage code: sign in to the database
#                     as draftpage_app with an IAM token, send AI jobs to SQS, and allow
#                     the ECS Exec tunnel.
# No access keys anywhere: both are assumed by the ECS service with temporary credentials.

locals {
  # Created in the ECS step; named here so the execution role can be scoped to it.
  log_group_name = "/ecs/draftpage"
  db_app_user    = "draftpage_app"
}

data "aws_caller_identity" "current" {}

# Only ECS tasks in this account may assume these roles (guards against "confused deputy").
data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

# ---- Execution role (ECS agent) ---------------------------------------------------------

resource "aws_iam_role" "ecs_execution" {
  name               = "draftpage-ecs-execution"
  description        = "ECS uses this to start DraftPage tasks: pull the image, read its secrets, write logs"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "ecs_execution" {
  # Registry login tokens are account-wide; AWS doesn't support narrowing this one.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPullDraftpageImage"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid     = "ReadOnlyTheseSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.auth0.arn,
      aws_db_instance.main.master_user_secret[0].secret_arn, # used only by the migrate task
    ]
  }
  statement {
    sid       = "WriteTaskLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:${local.log_group_name}:*"]
  }
  # Both secrets use the AWS-managed key aws/secretsmanager, so no kms:Decrypt grant is needed.
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "draftpage-ecs-execution"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}

# ---- App role (the running code) --------------------------------------------------------

resource "aws_iam_role" "app" {
  name               = "draftpage-app"
  description        = "Identity of the running DraftPage app: database sign-in via IAM token, ECS Exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "app" {
  statement {
    sid     = "DatabaseSignInAsAppUser"
    actions = ["rds-db:connect"]
    # This database, this user only. The admin user can't be reached with this role.
    resources = ["arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.main.resource_id}/${local.db_app_user}"]
  }
  # Phase 3: the outbox relay in the app publishes each "@Claude" job to the queue.
  statement {
    sid       = "PublishAiJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ai_jobs.arn]
  }
  # ECS Exec: lets you open a shell or a port-forward tunnel (e.g. laptop → RDS) through the
  # task with `aws ssm start-session`. The agent needs these message channels; they have no
  # resource-level scoping.
  statement {
    sid = "EcsExecChannels"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "draftpage-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}
