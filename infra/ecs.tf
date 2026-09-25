# Phase 2 step 8: ECS (Elastic Container Service), built in small pieces.
#
# 8a (this part): the cluster and the log group. A cluster is only a named grouping for
# tasks and services; on Fargate it has no servers of its own and costs nothing. You pay
# only for tasks while they run.

resource "aws_ecs_cluster" "main" {
  name = "draftpage"

  # Container Insights sends extra per-task metrics to CloudWatch (billed). The basic
  # CPU/memory metrics ECS always publishes are free and enough for now.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = { Name = "draftpage" }
}

# Tasks run on regular Fargate. (Fargate Spot is ~70% cheaper but can be stopped with two
# minutes' notice; with a single task that would mean random downtime.)
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# Everything the containers print to stdout/stderr lands here (JSON lines from the app).
# Two weeks is enough to debug; older logs are deleted so storage never grows unbounded.
resource "aws_cloudwatch_log_group" "app" {
  name              = local.log_group_name
  retention_in_days = 14
  tags              = { Name = "draftpage" }
}

# ---- 8b: the one-off migration task ---------------------------------------------------
# A "task definition" is a recipe for starting containers: image, CPU/memory, env, secrets,
# logging. This one runs the migration runner and exits. Run it before each deploy with
# scripts/aws-migrate.sh. It connects as the RDS admin, whose password ECS reads from the
# RDS-managed secret at start, so the 7-day rotation never affects it.

locals {
  app_image     = "${aws_ecr_repository.app.repository_url}:${var.app_image_tag}"
  migrate_image = "${aws_ecr_repository.app.repository_url}:${coalesce(var.migrate_image_tag, var.app_image_tag)}"
  db_secret     = aws_db_instance.main.master_user_secret[0].secret_arn
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "draftpage-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # each task gets its own network interface and security group
  cpu                      = 256      # 0.25 vCPU
  memory                   = 512      # MB; plenty for applying SQL files
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  # No task role: the migration makes no AWS calls of its own.

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64" # matches the image; Graviton is ~20% cheaper
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = local.migrate_image
      essential = true
      command   = ["node", "migrate/src/server/db/migrate.ts"]
      environment = [
        { name = "DRAFTPAGE_DB_HOST", value = aws_db_instance.main.address },
        { name = "DRAFTPAGE_DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DRAFTPAGE_DB_NAME", value = aws_db_instance.main.db_name },
        { name = "DRAFTPAGE_DATABASE_SSL", value = "verify-full" },
      ]
      # "<secret ARN>:<JSON key>::" makes ECS put one key of the secret into one env var.
      secrets = [
        { name = "DRAFTPAGE_DB_USER", valueFrom = "${local.db_secret}:username::" },
        { name = "DRAFTPAGE_DB_PASSWORD", valueFrom = "${local.db_secret}:password::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "migrate"
        }
      }
    },
  ])

  tags = { Name = "draftpage-migrate" }
}

# ---- 8d: the app ------------------------------------------------------------------------

resource "aws_ecs_task_definition" "app" {
  family                   = "draftpage-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256  # 0.25 vCPU
  memory                   = 1024 # MB; Next.js is comfortable here (512 is tight)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app.arn # the app's own identity (IAM DB sign-in, ECS Exec)

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = local.app_image
      essential = true
      portMappings = [
        { name = "http", containerPort = var.app_port, protocol = "tcp" },
      ]
      environment = [
        # Fargate sets HOSTNAME to the task's own name, and Next.js listens only on the
        # address in HOSTNAME. 0.0.0.0 = every interface, so the health check on 127.0.0.1
        # and the VPC Link on the task IP can both reach it.
        { name = "HOSTNAME", value = "0.0.0.0" },
        # Node closes idle keep-alive connections after 5 s by default, while API Gateway's
        # VPC Link keeps its connections to the task open much longer. When it reuses one Node
        # has just closed, the request fails with a 503. Keeping connections open longer than
        # the VPC Link does (≈350 s, the NLB idle timeout it's built on) removes that race.
        { name = "KEEP_ALIVE_TIMEOUT", value = "360000" },
        { name = "APP_BASE_URL", value = aws_apigatewayv2_api.web.api_endpoint },
        { name = "AUTH0_DOMAIN", value = var.auth0_domain },
        { name = "AUTH0_CLIENT_ID", value = var.auth0_client_id },
        { name = "AWS_REGION", value = var.region },
        # Database: the limited app user with 15-minute IAM tokens, no password (decision D10).
        { name = "DRAFTPAGE_DB_HOST", value = aws_db_instance.main.address },
        { name = "DRAFTPAGE_DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DRAFTPAGE_DB_NAME", value = aws_db_instance.main.db_name },
        { name = "DRAFTPAGE_DB_USER", value = local.db_app_user },
        { name = "DRAFTPAGE_DB_IAM_AUTH", value = "true" },
        { name = "DRAFTPAGE_DATABASE_SSL", value = "verify-full" },
        # Phase 3: the outbox relay publishes AI jobs here, and /api/internal/* accepts only
        # callers signed as the worker Lambda's role (decision D11).
        { name = "DRAFTPAGE_AI_QUEUE_URL", value = aws_sqs_queue.ai_jobs.url },
        { name = "DRAFTPAGE_WORKER_ROLE_ARN", value = aws_iam_role.ai_worker.arn },
      ]
      secrets = [
        { name = "AUTH0_SECRET", valueFrom = "${aws_secretsmanager_secret.auth0.arn}:AUTH0_SECRET::" },
        { name = "AUTH0_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.auth0.arn}:AUTH0_CLIENT_SECRET::" },
      ]
      # ECS restarts the task if this fails 3 times in a row. Liveness only (no database).
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.app_port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      # SIGTERM first; Next.js finishes in-flight requests, then exits. SIGKILL after 30 s.
      stopTimeout = 30
      # A tiny init process as PID 1: forwards signals and reaps processes; ECS Exec needs it.
      linuxParameters = { initProcessEnabled = true }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "app"
        }
      }
    },
  ])

  tags = { Name = "draftpage-app" }
}

resource "aws_ecs_service" "app" {
  name            = "draftpage-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  # 1 task. After creation the running count belongs to scripts/aws-pause.sh and
  # aws-resume.sh (0 = paused), so Terraform ignores it (lifecycle below).
  desired_count = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  # Public subnet + public IP for outbound calls (Auth0, ECR, Secrets Manager, logs), no NAT.
  # Inbound is closed except from the VPC Link (security group draftpage-app).
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  # Registers each task's IP and port in Cloud Map, where API Gateway looks them up.
  service_registries {
    registry_arn   = aws_service_discovery_service.app.arn
    container_name = "app"
    container_port = var.app_port
  }

  # Deploys start the new task before stopping the old one (briefly two tasks), and a
  # deployment that never gets healthy is rolled back to the last working version.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command = true # ECS Exec: shell / port-forward tunnel into the task
  propagate_tags         = "SERVICE"

  # `terraform apply` waits until the task is running and healthy, so you see failures here.
  wait_for_steady_state = true

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_iam_role_policy.ecs_execution, aws_iam_role_policy.app]
  tags       = { Name = "draftpage-app" }
}
