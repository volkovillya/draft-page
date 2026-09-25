# Phase 3 step 4a: the AI job queue ($0 at this volume; the first 1M requests a month are free).
#
#   app (outbox relay) ──SendMessage "job 42"──▶ draftpage-ai-jobs ──▶ Lambda worker (step 6)
#
# SQS holds each job until the worker has finished it, so a worker or model outage only
# delays jobs instead of losing them. Delivery is at least once: the same job can arrive
# twice, which the worker and the database's unique job key already tolerate.
# Jobs that keep failing without reporting back move to the dead-letter queue (4b, below).

resource "aws_sqs_queue" "ai_jobs" {
  name = "draftpage-ai-jobs"

  # How long a job stays hidden from other consumers after the worker picks it up. AWS
  # advises 6× the Lambda timeout (planned: 3 minutes) so a slow run is never handed to a
  # second worker while the first is still going.
  visibility_timeout_seconds = 1080

  # Unfinished jobs are kept 4 days (covers a paused weekend), then SQS drops them.
  message_retention_seconds = 345600

  # Long polling: a receive waits up to 20 s for a message instead of returning empty at
  # once, so an idle queue makes far fewer (billed) requests.
  receive_wait_time_seconds = 20

  # Encryption at rest with an SQS-owned key: free and nothing to manage.
  sqs_managed_sse_enabled = true

  # After 3 receives without success (the worker crashed or timed out every time), SQS moves
  # the message to the dead-letter queue instead of retrying forever. Matches the worker's
  # MAX_JOB_ATTEMPTS: on the 3rd attempt it normally marks the job failed itself, so only
  # jobs whose worker couldn't even report back end up in the DLQ.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ai_jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "draftpage-ai-jobs" }
}

# ---- 4b: the dead-letter queue ----------------------------------------------------------

resource "aws_sqs_queue" "ai_jobs_dlq" {
  name = "draftpage-ai-jobs-dlq"

  # The longest SQS allows (14 days), so there's time to look at what failed and why.
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = { Name = "draftpage-ai-jobs-dlq" }
}

# Only the job queue may send its failures here. A separate resource, because the main
# queue already points at the DLQ and the DLQ can't point back in the same block (a cycle).
resource "aws_sqs_queue_redrive_allow_policy" "ai_jobs_dlq" {
  queue_url = aws_sqs_queue.ai_jobs_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ai_jobs.arn]
  })
}
