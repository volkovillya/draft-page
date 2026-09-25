# Phase 2 step 4: the image registry (~$0.10/month for a few images).
# Fargate pulls the app image from here. Images are pushed from the laptop for now
# (master prompt §38: prove the manual flow before any CI/CD).

resource "aws_ecr_repository" "app" {
  name = "draftpage"

  # A tag always points at the same image: redeploying "0.1.0" can never silently run
  # different code. Every build gets a new tag.
  image_tag_mutability = "IMMUTABLE"

  # Free basic scan for known OS package vulnerabilities on every push.
  image_scanning_configuration {
    scan_on_push = true
  }

  # AES-256 with an AWS-owned key: encrypted at rest, no KMS key to pay for or manage.
  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "draftpage" }
}

# Storage is billed per GB, so keep only what a rollback could need.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images (e.g. layers of interrupted pushes) after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 5 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 5
        }
        action = { type = "expire" }
      },
    ]
  })
}
