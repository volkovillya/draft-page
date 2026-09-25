terraform {
  required_version = ">= 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
  }

  # Local state for now (master prompt §37). terraform.tfstate can contain secrets and is
  # gitignored; a remote backend comes only when there is a concrete need.
}
