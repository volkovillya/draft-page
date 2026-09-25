output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "ecr_repository_url" {
  description = "Where to push the app image (docker push <url>:<tag>)."
  value       = aws_ecr_repository.app.repository_url
}

output "db_endpoint" {
  description = "RDS hostname (private; reachable only from inside the VPC)."
  value       = aws_db_instance.main.address
}

output "db_engine_version" {
  value = aws_db_instance.main.engine_version_actual
}

output "db_master_secret_arn" {
  description = "Secrets Manager secret (managed by RDS) holding the database username and password."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "auth0_secret_arn" {
  value = aws_secretsmanager_secret.auth0.arn
}

output "db_resource_id" {
  description = "Stable RDS resource id, used in the IAM policy that lets the app sign in (rds-db:connect)."
  value       = aws_db_instance.main.resource_id
}

output "ecs_execution_role_arn" {
  value = aws_iam_role.ecs_execution.arn
}

output "app_role_arn" {
  value = aws_iam_role.app.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "app_url" {
  description = "DraftPage's public HTTPS URL (APP_BASE_URL; add it to Auth0)."
  value       = aws_apigatewayv2_api.web.api_endpoint
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "ai_jobs_queue_url" {
  value = aws_sqs_queue.ai_jobs.url
}

output "ai_jobs_queue_arn" {
  value = aws_sqs_queue.ai_jobs.arn
}
