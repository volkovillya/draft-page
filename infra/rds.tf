# Phase 2 step 5: the database. The first component that really costs money
# (~$12–13/month instance + ~$2.40/month storage in eu-north-1, paid from credits).
# It can be stopped for up to 7 days at a time to save credits (storage keeps billing).

# Newest PostgreSQL 18.x that RDS offers in this region; plan fails clearly if there's none.
data "aws_rds_engine_version" "postgres" {
  engine  = "postgres"
  version = "18"
  latest  = true
}

# Fails at plan time if the chosen class isn't sold for this engine version in this region.
data "aws_rds_orderable_db_instance" "db" {
  engine         = data.aws_rds_engine_version.postgres.engine
  engine_version = data.aws_rds_engine_version.postgres.version_actual
  instance_class = var.db_instance_class
  storage_type   = "gp3"
}

# Which subnets RDS may place the database in: the two private ones (no internet route).
resource "aws_db_subnet_group" "main" {
  name       = "draftpage"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "draftpage" }
}

resource "aws_db_instance" "main" {
  identifier     = "draftpage"
  engine         = data.aws_rds_engine_version.postgres.engine
  engine_version = data.aws_rds_engine_version.postgres.version_actual
  instance_class = data.aws_rds_orderable_db_instance.db.instance_class

  # Storage: 20 GB gp3 (the minimum), encrypted with the AWS-managed RDS key (no KMS cost).
  # No storage autoscaling, so the bill can't grow on its own.
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "draftpage"
  username = "draftpage_admin"
  # RDS generates the password and keeps it in Secrets Manager (~$0.40/month). It never
  # appears in Terraform code, state or our env files. ECS will read it from that secret.
  manage_master_user_password = true

  # Network: private subnets only, no public IP, only the app's security group may connect.
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  # The app signs in as draftpage_app with 15-minute IAM tokens, not a password (decision D10).
  iam_database_authentication_enabled = true
  multi_az                            = false # single-AZ on purpose (master prompt §16)
  port                                = 5432

  # Backups: daily automated snapshots with point-in-time restore inside the window.
  # The Free plan caps retention at 1 day (FreeTierRestrictionError above that); raise it to
  # 7 after upgrading the account plan. Backup storage up to the database size is free.
  backup_retention_period = 1
  backup_window           = "02:00-03:00"         # UTC
  maintenance_window      = "sun:03:30-sun:04:30" # UTC, after the backup
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade  = true  # 18.x security patches in the maintenance window
  allow_major_version_upgrade = false # a major upgrade is a deliberate, reviewed change

  # Safety: `terraform destroy` can't delete it until protection is switched off first,
  # and deleting it leaves a final snapshot.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "draftpage-final"

  # Apply changes now instead of waiting for the Sunday maintenance window. Careful: a
  # change that needs a restart (e.g. instance class) then restarts the database right away.
  apply_immediately = true

  # Extra monitoring features cost money or add noise; off for now.
  performance_insights_enabled = false
  monitoring_interval          = 0

  tags = { Name = "draftpage" }
}
