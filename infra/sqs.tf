# Phase 3 step 4a: the AI job queue ($0 at this volume; the first 1M requests a month are free).
#
#   app (outbox relay) ──SendMessage "job 42"──▶ draftpage-ai-jobs ──▶ Lambda worker (step 6)
#
# SQS holds each job until the worker has finished it, so a worker or model outage only
# delays jobs instead of losing them. Delivery is at least once: the same job can arrive
# twice, which the worker and the database's unique job key already tolerate.
# The dead-letter queue (jobs that keep failing) is added in the next step.

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

  tags = { Name = "draftpage-ai-jobs" }
}
