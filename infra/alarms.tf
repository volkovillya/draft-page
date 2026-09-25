# Phase 3 step 10: a single alarm for "the AI pipeline broke in a way it couldn't report".
#
#   job message in the dead-letter queue ──▶ CloudWatch alarm ──▶ SNS topic ──▶ email
#
# A normal failure (the model refused, the page is too big) is shown on the thread and never
# reaches the DLQ. A message lands there only when the worker crashed or timed out on every
# attempt, so any message there needs a look. Cost: ≈$0.10/month for the alarm; SNS email is
# free at this volume. AWS sends a confirmation email first: the alarm can only email you
# after you click "Confirm subscription" in it.

resource "aws_sns_topic" "alerts" {
  name = "draftpage-alerts"
  tags = { Name = "draftpage-alerts" }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

resource "aws_cloudwatch_metric_alarm" "ai_dlq_not_empty" {
  alarm_name        = "draftpage-ai-jobs-dlq-not-empty"
  alarm_description = "An AI job failed on every attempt without reporting back. Look at the DLQ and /aws/lambda/draftpage-ai-worker."

  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.ai_jobs_dlq.name }
  statistic           = "Maximum"
  period              = 300 # SQS reports every 5 minutes
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching" # no data = empty queue, not an alarm

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn] # also tells you when it's cleared
  tags          = { Name = "draftpage-ai-jobs-dlq-not-empty" }
}
