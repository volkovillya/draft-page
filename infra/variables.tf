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

variable "ai_region" {
  description = "Region the worker calls Bedrock in; empty = the home region (gpt-oss-120b runs in eu-north-1). GPT-5.6 Luna is only sold in US regions (e.g. us-east-1)."
  type        = string
  default     = ""
}

variable "ai_model_id" {
  description = "Bedrock model or inference profile id for ai_editor = \"bedrock\" (empty while fake), e.g. openai.gpt-oss-120b-1:0 or us.openai.gpt-5.6-luna."
  type        = string
  default     = ""

  validation {
    condition     = var.ai_editor != "bedrock" || can(regex("^[a-z0-9.:-]+$", var.ai_model_id))
    error_message = "ai_editor = \"bedrock\" needs ai_model_id: a Bedrock model or inference profile id such as us.openai.gpt-5.6-luna."
  }
}

variable "ai_kill_switch_usd" {
  description = <<-EOT
    Monthly usage (before credits, whole account) at which AWS Budgets blocks the AI worker
    from calling Bedrock. The fixed infrastructure is ≈ $29 a month, so the default leaves
    ≈ $11 or more for AI. See ai-kill-switch.tf.
  EOT
  type        = number
  default     = 40

  validation {
    condition     = var.ai_kill_switch_usd >= 30
    error_message = "ai_kill_switch_usd must be at least 30, or the fixed infrastructure alone would trip it."
  }
}
