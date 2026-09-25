# Cost guards for the Paid plan ($0: everything below is free at this size; CloudWatch gives
# 10 standard alarms free, and this project uses 4).
#
#   1. Cost Anomaly Detection: learns what a normal day costs per service and emails when a
#      day costs ≥ $5 more than expected, whatever the cause (a stolen login starting GPU
#      machines, a bot flood, a forgotten experiment). Budgets only look at month totals.
#   2. An email whenever the database starts, and an automatic stop again when RDS restarts
#      it on its own after 7 days stopped, so a paused database can't quietly bill again.
#   3. Hourly alarms on traffic and database CPU: email within the hour, not a day later.

# ---- 1. Cost Anomaly Detection ----------------------------------------------------------
# One monitor over every AWS service in the account. AWS allows one monitor of this kind; if
# the account already has one (some new accounts get a default), the apply fails with a
# limit error: then delete that default in Billing → Cost Anomaly Detection and apply again.
resource "aws_ce_anomaly_monitor" "services" {
  name              = "draftpage-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "email" {
  name             = "draftpage-cost-anomalies"
  frequency        = "DAILY" # email subscribers get a daily summary (immediate needs SNS)
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "EMAIL"
    address = var.budget_alert_email
  }

  # Ignore noise: only anomalies that cost at least $5 more than expected.
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["5"]
    }
  }
}

# ---- 2. "The database started" ----------------------------------------------------------
# RDS sends its events to the existing alert topic (alarms.tf). The "notification" category
# includes "DB instance started" and "started because it was stopped for 7 days".
resource "aws_db_event_subscription" "db_started" {
  name             = "draftpage-db-started"
  sns_topic        = aws_sns_topic.alerts.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.main.identifier]
  event_categories = ["notification"]
  depends_on       = [aws_sns_topic_policy.alerts]
}

# Who may publish to the alert topic. Setting a policy replaces the default one, so it spells
# out all three publishers: the account itself, CloudWatch alarms, and RDS events.
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "AccountOwnerManages"
    actions   = ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:ListSubscriptionsByTopic"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "CloudWatchAlarmsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
  statement {
    sid       = "RdsEventsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.rds.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

# If the database was paused and RDS restarted it on its own (7 days stopped), stop it again.
# Only that event (RDS-EVENT-0154), never a start you asked for. Runs AWS's own automation
# runbook AWS-StopRdsInstance; the "database started" email above still tells you.
resource "aws_cloudwatch_event_rule" "db_auto_started" {
  name        = "draftpage-db-auto-started"
  description = "RDS restarted the paused DraftPage database after 7 days: stop it again"
  event_pattern = jsonencode({
    source        = ["aws.rds"]
    "detail-type" = ["RDS DB Instance Event"]
    resources     = [aws_db_instance.main.arn]
    detail        = { EventID = ["RDS-EVENT-0154"] }
  })
}

resource "aws_cloudwatch_event_target" "db_restop" {
  rule     = aws_cloudwatch_event_rule.db_auto_started.name
  arn      = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:automation-definition/AWS-StopRdsInstance:$DEFAULT"
  role_arn = aws_iam_role.db_restop_events.arn
  input = jsonencode({
    InstanceId           = [aws_db_instance.main.identifier]
    AutomationAssumeRole = [aws_iam_role.db_restop_automation.arn]
  })
}

# EventBridge starts the runbook with this role...
resource "aws_iam_role" "db_restop_events" {
  name        = "draftpage-db-restop-events"
  description = "EventBridge: start the AWS-StopRdsInstance runbook for the DraftPage database"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "db_restop_events" {
  name = "draftpage-db-restop-events"
  role = aws_iam_role.db_restop_events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartStopRunbook"
        Effect   = "Allow"
        Action   = "ssm:StartAutomationExecution"
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:automation-definition/AWS-StopRdsInstance:*"
      },
      {
        Sid       = "HandTheRunbookItsRole"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.db_restop_automation.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" } }
      },
    ]
  })
}

# ...and the runbook itself may only look at and stop this one database.
resource "aws_iam_role" "db_restop_automation" {
  name        = "draftpage-db-restop-automation"
  description = "SSM Automation: stop the DraftPage database after RDS restarts it on its own"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ssm.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "db_restop_automation" {
  name = "draftpage-db-restop-automation"
  role = aws_iam_role.db_restop_automation.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "StopOnlyThisDatabase"
      Effect   = "Allow"
      Action   = ["rds:StopDBInstance", "rds:DescribeDBInstances"]
      Resource = aws_db_instance.main.arn
    }]
  })
}

# ---- 3. Hourly alarms ------------------------------------------------------------------
# Normal use is a few hundred requests and a few MB an hour. These catch a bot or a runaway
# client within the hour, including bytes, which the request throttle doesn't limit.
resource "aws_cloudwatch_metric_alarm" "api_requests" {
  alarm_name        = "draftpage-api-requests-high"
  alarm_description = "Over 10,000 requests in an hour. A bot or runaway client? Check the API access log; pause the app if it's not you."
  namespace         = "AWS/ApiGateway"
  metric_name       = "Count"
  dimensions = {
    ApiId = aws_apigatewayv2_api.web.id
    Stage = aws_apigatewayv2_stage.default.name
  }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_bytes" {
  alarm_name        = "draftpage-api-data-high"
  alarm_description = "Over 1 GB served in an hour (≈ $0.09 of data transfer each). Check the API access log; pause the app if it's not you."
  namespace         = "AWS/ApiGateway"
  metric_name       = "DataProcessed"
  dimensions = {
    ApiId = aws_apigatewayv2_api.web.id
    Stage = aws_apigatewayv2_stage.default.name
  }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1073741824 # bytes
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# db.t4g instances on RDS always run in "unlimited" CPU mode: CPU above the small baseline is
# billed extra ($0.075 per vCPU-hour; pinned at 100% ≈ $98/month on top of the instance).
# Surplus credits are charged only after the earned ones run out, so any charge means the
# database has been busy far beyond normal. 30 credits = 30 vCPU-minutes ≈ $0.04.
resource "aws_cloudwatch_metric_alarm" "db_cpu_surplus" {
  alarm_name          = "draftpage-db-cpu-surplus-charged"
  alarm_description   = "The database is paying for extra CPU. A runaway query or a loop? Check RDS CPU and the app logs."
  namespace           = "AWS/RDS"
  metric_name         = "CPUSurplusCreditsCharged"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 30
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
