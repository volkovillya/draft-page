# Phase 2 step 3: networking. Everything in this file is free.
#
#   internet ── IGW ── public subnets (a, b)   ← the Fargate task (public IP for outbound only)
#                        │
#                     private subnets (a, b)   ← RDS (no route to or from the internet)
#
# No NAT Gateway (~$33/mo): the task sits in a public subnet with a public IPv4 address for
# outbound calls (Auth0, ECR, Secrets Manager, CloudWatch), while its security group accepts
# inbound traffic only from the API Gateway VPC Link (decision D9). RDS needs no internet.

locals {
  vpc_cidr = "10.20.0.0/16"
  # Two AZs: an RDS subnet group requires subnets in at least two, even for single-AZ.
  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnets  = ["10.20.0.0/24", "10.20.1.0/24"]
  private_subnets = ["10.20.10.0/24", "10.20.11.0/24"]
}

data "aws_availability_zones" "available" {
  state = "available"
  # Only regular AZs, not Local Zones or Wavelength Zones.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_vpc" "main" {
  cidr_block = local.vpc_cidr
  # DNS in the VPC: needed to resolve the RDS endpoint and Cloud Map's private names.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "draftpage" }
}

# Lock the VPC's default security group down to no rules, so nothing can use it by accident.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "draftpage-default-unused" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "draftpage" }
}

# ---- Public subnets (Fargate) -----------------------------------------------------------

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_subnets[count.index]
  availability_zone = local.azs[count.index]
  # The ECS service asks for a public IP explicitly; nothing else here should get one.
  map_public_ip_on_launch = false

  tags = { Name = "draftpage-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "draftpage-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---- Private subnets (RDS) --------------------------------------------------------------

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.private_subnets[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "draftpage-private-${local.azs[count.index]}", Tier = "private" }
}

# Only the implicit "local" route (inside the VPC). No internet in either direction.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "draftpage-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---- Security groups (stateful firewalls on network interfaces) -------------------------
# Rules reference each other, so traffic is allowed by "who", not by IP address:
#   VPC Link  ──3000──▶  app  ──5432──▶  db

resource "aws_security_group" "vpc_link" {
  name        = "draftpage-vpc-link"
  description = "API Gateway VPC Link ENIs; may only reach the app port"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "draftpage-vpc-link" }
}

resource "aws_security_group" "app" {
  name        = "draftpage-app"
  description = "DraftPage Fargate task (and the one-off migrate task)"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "draftpage-app" }
}

resource "aws_security_group" "db" {
  name        = "draftpage-db"
  description = "RDS PostgreSQL; only the app may connect"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "draftpage-db" }
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_app" {
  security_group_id            = aws_security_group.vpc_link.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  description                  = "Forward requests to the app"
}

resource "aws_vpc_security_group_ingress_rule" "app_from_vpc_link" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.vpc_link.id
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  description                  = "Only API Gateway (via the VPC Link) reaches the app"
}

resource "aws_vpc_security_group_egress_rule" "app_https_out" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to Auth0, ECR, Secrets Manager, CloudWatch (later Bedrock)"
}

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the app only"
}
