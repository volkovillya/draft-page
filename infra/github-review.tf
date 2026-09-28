# The role the AI pull-request review (.github/workflows/ai-review.yml) assumes through GitHub
# OIDC. It trusts only pull_request runs of this repository and may do exactly one thing:
# invoke the review model in the home region. It is covered by the AI spending kill switch
# (ai-kill-switch.tf).

resource "aws_iam_role" "github_reviewer" {
  name                 = "draftpage-github-reviewer"
  description          = "GitHub Actions AI review of pull requests: invoke one Bedrock model"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Pull request runs only (ID-based sub claim, see github.tf).
          "token.actions.githubusercontent.com:sub" = "repo:${local.github_sub_repo}:pull_request"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_reviewer" {
  name = "draftpage-github-reviewer"
  role = aws_iam_role.github_reviewer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeReviewModel"
      Effect   = "Allow"
      Action   = "bedrock:InvokeModel" # what Converse needs; no streaming
      Resource = "arn:aws:bedrock:${var.region}::foundation-model/${var.ai_review_model_id}"
    }]
  })
}
