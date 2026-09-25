# Phase 3: a hard stop for AI spending, independent of the app's own daily limits ($0).
#
#   month's usage passes var.ai_kill_switch_usd ──▶ AWS Budgets action ──▶ attaches "deny Bedrock"
#                                                                            to the worker's role
#
# After that every AI job fails with "The AI model isn't available for this account", and the
# rest of DraftPage keeps working. Nothing detaches it automatically, not even the next month:
# to turn AI back on, open Billing → Budgets → draftpage-ai-kill-switch → Actions and reverse it.
#
# It watches the whole bill (usage before credits and tax, like the other budgets), because each
# third-party model on Bedrock is billed under its own service name, which a service filter
# could miss. The fixed infrastructure is ≈ $29 of a month, so $40 leaves about $11 for AI at
# the end of a month and more earlier on. AWS's billing data runs a few hours behind, so this
# is a backstop; the app's limits (10 per person, 30 in total a day) are the first line.
# The first two budgets with actions are free.

resource "aws_budgets_budget" "ai_kill_switch" {
  name         = "draftpage-ai-kill-switch"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = tostring(var.ai_kill_switch_usd)
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  # Before credits and tax, like the monthly budget (budget.tf).
  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = ["Credit", "Tax"]
      }
    }
  }

  # A heads-up before the switch fires ($36: above a normal running month with some AI).
  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 90
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}

# What gets attached. A Deny always wins over the worker's own permissions.
resource "aws_iam_policy" "deny_bedrock" {
  name        = "draftpage-deny-bedrock"
  description = "Attached to the AI worker by the AI kill-switch budget: no more model calls"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AiSpendingKillSwitch"
      Effect   = "Deny"
      Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
      Resource = "*"
    }]
  })
}

# The identity AWS Budgets uses to run the action: it may attach or detach only that one
# policy, and only on the worker's role.
resource "aws_iam_role" "budget_kill_switch" {
  name        = "draftpage-budget-kill-switch"
  description = "AWS Budgets uses this to attach draftpage-deny-bedrock to the AI worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "budgets.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        # Only this budget may use the role.
        ArnLike = { "aws:SourceArn" = "arn:aws:budgets::${data.aws_caller_identity.current.account_id}:budget/draftpage-ai-kill-switch" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "budget_kill_switch" {
  name = "draftpage-budget-kill-switch"
  role = aws_iam_role.budget_kill_switch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ToggleDenyBedrockOnWorker"
      Effect   = "Allow"
      Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
      Resource = aws_iam_role.ai_worker.arn
      Condition = {
        ArnEquals = { "iam:PolicyARN" = aws_iam_policy.deny_bedrock.arn }
      }
    }]
  })
}

resource "aws_budgets_budget_action" "ai_kill_switch" {
  budget_name        = aws_budgets_budget.ai_kill_switch.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC" # no one has to click anything at 3 a.m.
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_kill_switch.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.deny_bedrock.arn
      roles      = [aws_iam_role.ai_worker.name]
    }
  }

  subscriber {
    address           = var.budget_alert_email
    subscription_type = "EMAIL"
  }

  depends_on = [aws_iam_role_policy.budget_kill_switch]
}
