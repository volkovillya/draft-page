provider "aws" {
  region  = var.region
  profile = var.aws_profile

  # Guard rail: this laptop also has company AWS profiles. Any plan or apply against an
  # account other than the personal DraftPage one fails before touching anything.
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "draftpage"
      ManagedBy   = "terraform"
      Environment = "dev"
    }
  }
}
