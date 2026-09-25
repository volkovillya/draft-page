variable "account_id" {
  description = "The only AWS account this configuration may touch (personal DraftPage account)."
  type        = string
  default     = "114990992449"
}

variable "region" {
  description = <<-EOT
    AWS region for DraftPage resources: the project's home region. The Free plan's managed
    SCP denies almost every regional action in us-east-1 and us-west-2 (only global services
    and Bedrock inference are allowed there), so resources must live in the home region.
  EOT
  type        = string
  default     = "eu-north-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile, signed in with `aws login --profile draftpage` (short-lived credentials)."
  type        = string
  default     = "draftpage"
}

variable "budget_alert_email" {
  description = "Where budget alerts are sent. Set in terraform.tfvars (gitignored)."
  type        = string
}

variable "app_port" {
  description = "Port the Next.js server listens on inside the container."
  type        = number
  default     = 3000
}

variable "db_instance_class" {
  description = "RDS instance class: the smallest Graviton (ARM) burstable class."
  type        = string
  default     = "db.t4g.micro"
}

variable "app_image_tag" {
  description = "Image tag the app service runs. scripts/aws-deploy.sh updates it in terraform.tfvars."
  type        = string
  default     = "0.1.2"
}

variable "migrate_image_tag" {
  description = <<-EOT
    Image tag for the one-off migrate task. Empty = same as app_image_tag. A deploy first
    applies with this set to the new tag and runs migrations, and only then moves the app,
    so new code never starts against an old schema.
  EOT
  type        = string
  default     = ""
}

variable "auth0_domain" {
  description = "Auth0 tenant domain (not secret). Set in terraform.tfvars."
  type        = string
}

variable "auth0_client_id" {
  description = "Auth0 application client id (not secret). Set in terraform.tfvars."
  type        = string
}

variable "ai_editor" {
  description = <<-EOT
    Which HTML editor the AI worker uses: "fake" (no model; an invisible edit) or "bedrock".
    Stays "fake" until the account can call Bedrock (the Free plan allows 0 tokens a day).
  EOT
  type        = string
  default     = "fake"

  validation {
    condition     = contains(["fake", "bedrock"], var.ai_editor)
    error_message = "ai_editor must be \"fake\" or \"bedrock\"."
  }
}

variable "ai_model_id" {
  description = "Bedrock model or inference profile id for ai_editor = \"bedrock\" (empty while fake)."
  type        = string
  default     = ""
}
