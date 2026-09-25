# Phase 2 step 8c: the public HTTPS entry point (decision D9, instead of a load balancer).
#
#   browser ──HTTPS──▶ API Gateway (HTTP API) ──VPC Link──▶ Cloud Map ──▶ Fargate task :3000
#
# This part creates only the API and its stage, which gives DraftPage a permanent URL with
# a TLS certificate managed by AWS: https://<id>.execute-api.eu-north-1.amazonaws.com
# The route to the app (VPC Link, Cloud Map, integration) comes in 8d. Until then every
# request gets a 404 from API Gateway. Cost: $1.06 per million requests, so ≈ $0 here.

resource "aws_apigatewayv2_api" "web" {
  name          = "draftpage"
  protocol_type = "HTTP" # HTTP API: the simpler, ~70% cheaper flavor of API Gateway
  description   = "Public HTTPS entry point for the DraftPage web app"
  tags          = { Name = "draftpage" }
}

# "$default" serves the API at the root of the URL (no /prod prefix), which is what the
# Next.js app expects. auto_deploy publishes route changes as soon as Terraform makes them.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.web.id
  name        = "$default"
  auto_deploy = true

  # A ceiling on traffic, so a runaway client or bot can't run up the bill or overload the
  # single small task. 5/s sustained is still well above what a few reviewers need (a page
  # load is a short burst, which the burst allowance absorbs). The ceiling limits requests,
  # not bytes: a bot pulling the largest public JS file (~230 KB) at 5/s for a month would
  # move ~3 TB (≈ $260 of data transfer), so the hourly traffic alarms in cost-guards.tf
  # email within the hour; pause the app (npm run aws:pause) if one fires unexpectedly.
  default_route_settings {
    throttling_rate_limit  = 5 # requests per second, sustained
    throttling_burst_limit = 50
  }

  # One JSON line per request. integrationError says why API Gateway couldn't get an answer
  # from the app (e.g. a reset connection), which is what a 503 alone never tells you.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId         = "$context.requestId"
      time              = "$context.requestTime"
      method            = "$context.httpMethod"
      path              = "$context.path"
      routeKey          = "$context.routeKey"
      status            = "$context.status"
      integrationStatus = "$context.integrationStatus"
      integrationError  = "$context.integrationErrorMessage"
      latencyMs         = "$context.responseLatency"
      integrationMs     = "$context.integrationLatency"
    })
  }

  tags = { Name = "draftpage" }
}

# ---- 8d: wiring API Gateway to the app ------------------------------------------------

# Cloud Map: a private phone book for the VPC. ECS writes each running task's IP and port
# into it; API Gateway reads it on every request, so the changing task IP never matters.
resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "draftpage.internal"
  description = "Private service discovery for DraftPage"
  vpc         = aws_vpc.main.id # creates a private Route 53 hosted zone (~$0.50/month)
  tags        = { Name = "draftpage" }
}

resource "aws_service_discovery_service" "app" {
  name = "app" # app.draftpage.internal

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    # SRV records carry the port as well as the IP; API Gateway needs both.
    dns_records {
      type = "SRV"
      ttl  = 10
    }
  }

  # ECS reports task health to Cloud Map, so an unhealthy task stops receiving traffic.
  # failure_threshold is deprecated (AWS always uses 1) and triggers a warning, but an empty
  # block isn't sent to AWS at all, which leaves the health config off and makes Terraform
  # want to replace this service on every plan. Keep it.
  health_check_custom_config {
    failure_threshold = 1
  }

  tags = { Name = "draftpage-app" }
}

# The VPC Link places small AWS-managed network interfaces in our private subnets, so API
# Gateway (outside the VPC) can reach the task privately. HTTP API VPC Links cost nothing.
resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "draftpage"
  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.vpc_link.id]
  tags               = { Name = "draftpage" }
}

# Forward every request as-is (method, path, headers, body) to whatever task Cloud Map lists.
resource "aws_apigatewayv2_integration" "app" {
  api_id                 = aws_apigatewayv2_api.web.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.main.id
  integration_uri        = aws_service_discovery_service.app.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 30000 # API Gateway's maximum; plenty for page renders

  # Public traffic can never claim to be the AI worker: whatever this header says, API
  # Gateway replaces it with "none" (the app only trusts it on the signed route below).
  request_parameters = {
    "overwrite:header.x-draftpage-caller-arn" = "none"
  }
}

# "$default" catches every path (/, /pages, /api/..., /_next/static/...).
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.web.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.app.id}"
}

# ---- Phase 3 step 7: the worker-only route (decision D11) -----------------------------
#
#   Lambda ──SigV4-signed──▶ ANY /api/internal/{proxy+} (IAM auth) ──VPC Link──▶ app
#
# API Gateway verifies the AWS signature and the caller's execute-api:Invoke permission
# before forwarding, so unsigned or other callers get 403 without reaching the app. It then
# passes the verified caller (an assumed-role ARN) in a header, which the app checks against
# DRAFTPAGE_WORKER_ROLE_ARN as a second line of defence. No keys or shared secrets.

resource "aws_apigatewayv2_integration" "app_internal" {
  api_id                 = aws_apigatewayv2_api.web.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.main.id
  integration_uri        = aws_service_discovery_service.app.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 30000

  request_parameters = {
    "overwrite:header.x-draftpage-caller-arn" = "$context.identity.userArn"
  }
}

# More specific than $default, so every /api/internal/* request lands here, signed or not.
resource "aws_apigatewayv2_route" "internal" {
  api_id             = aws_apigatewayv2_api.web.id
  route_key          = "ANY /api/internal/{proxy+}"
  authorization_type = "AWS_IAM"
  target             = "integrations/${aws_apigatewayv2_integration.app_internal.id}"
}

# Access logs for the HTTP API (a few hundred bytes per request, kept two weeks).
resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/draftpage"
  retention_in_days = 14
  tags              = { Name = "draftpage-api-access" }
}
