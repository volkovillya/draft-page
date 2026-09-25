# Phase 3 step 6: the AI worker Lambda (≈$0: 1M requests and 400k GB-seconds a month are free).
#
#   SQS draftpage-ai-jobs ──(trigger, step 9)──▶ draftpage-ai-worker ──signed HTTPS──▶ app /api/internal/*
#                                                        └──(after the Paid plan upgrade)──▶ Bedrock
#
# It runs outside the VPC (decision D11): no NAT or endpoint needed to reach Bedrock, and it
# never connects to the database; it reads and saves jobs through the app's internal API.
# The code is built by `npm run build:worker` into infra/build/ai-worker.zip (not in Git).
# Until step 9 adds the SQS trigger, nothing invokes it.

locals {
  worker_name = "draftpage-ai-worker"
  worker_zip  = "${path.module}/build/ai-worker.zip"
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "ai_worker" {
  name               = local.worker_name
  description        = "DraftPage AI worker Lambda: read the job queue, call the app's internal API, write its logs"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "ai_worker" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ai_worker.arn}:*"]
  }
  # What the SQS trigger needs to pull and delete messages, plus setting a message's retry delay.
  statement {
    sid = "ConsumeJobQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.ai_jobs.arn]
  }
  # Only the internal job routes of this API. API Gateway checks this on every call.
  statement {
    sid       = "CallInternalJobApi"
    actions   = ["execute-api:Invoke"]
    resources = ["${aws_apigatewayv2_api.web.execution_arn}/$default/POST/api/internal/ai-jobs/*"]
  }
  # Bedrock (bedrock:InvokeModel on one model) is added with the real model, after the upgrade.
}

resource "aws_iam_role_policy" "ai_worker" {
  name   = local.worker_name
  role   = aws_iam_role.ai_worker.id
  policy = data.aws_iam_policy_document.ai_worker.json
}

resource "aws_cloudwatch_log_group" "ai_worker" {
  name              = "/aws/lambda/${local.worker_name}"
  retention_in_days = 14
  tags              = { Name = local.worker_name }
}

resource "aws_lambda_function" "ai_worker" {
  function_name = local.worker_name
  description   = "Runs DraftPage @Claude edit jobs from SQS"
  role          = aws_iam_role.ai_worker.arn

  filename         = local.worker_zip
  source_code_hash = filebase64sha256(local.worker_zip) # a new upload only when the code changed
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  architectures    = ["arm64"] # Graviton: ~20% cheaper per GB-second

  memory_size = 256 # MB; plenty for HTTP calls (CPU scales with memory)
  # A full 32k-token reply can take several minutes. The model call gives up at 300 s
  # (src/ai/bedrock-editor.ts), which leaves time for the claim and save calls; the queue's
  # visibility timeout is 6× this.
  timeout = 360

  environment {
    variables = {
      DRAFTPAGE_APP_URL         = aws_apigatewayv2_api.web.api_endpoint
      DRAFTPAGE_AI_QUEUE_URL    = aws_sqs_queue.ai_jobs.url
      DRAFTPAGE_AI_MAX_ATTEMPTS = "3" # = maxReceiveCount in the queue's redrive policy
      DRAFTPAGE_AI_EDITOR       = var.ai_editor
      DRAFTPAGE_AI_MODEL_ID     = var.ai_model_id
      DRAFTPAGE_AI_REGION       = var.ai_region          # empty: the Lambda's own region
      NODE_OPTIONS              = "--enable-source-maps" # readable stack traces in the logs
    }
  }

  logging_config {
    log_format = "Text" # the worker already writes one JSON object per line
    log_group  = aws_cloudwatch_log_group.ai_worker.name
  }

  depends_on = [aws_iam_role_policy.ai_worker]
  tags       = { Name = local.worker_name }
}

# ---- Phase 3 step 9: the SQS trigger ----------------------------------------------------
# Lambda's pollers long-poll the queue (using the function's role, no resource policy) and
# invoke the function with each message. One message per invocation, so a failure never
# delays another job; at most 2 run at once, which keeps model spend and load on the small
# app task bounded. Failed messages are reported individually (partial batch response).
resource "aws_lambda_event_source_mapping" "ai_jobs" {
  event_source_arn        = aws_sqs_queue.ai_jobs.arn
  function_name           = aws_lambda_function.ai_worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2 # the lowest SQS allows
  }
}
