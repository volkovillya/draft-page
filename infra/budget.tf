# Cost safety first (master prompt §42, Phase 2 step 1).
#
# Created by hand in the Console, then adopted into Terraform with a one-time `import`
# block (applied 2026-09-25, since removed). Terraform now owns it.

resource "aws_budgets_budget" "monthly" {
  name         = "Future Unicorn Monthly Cost"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "25.0"
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  # Free plan: credits offset every charge, so a budget that counts credits always sees $0
  # and never alerts. Excluding the Credit record type makes it track real usage, i.e. how
  # fast the credits are being spent.
  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = ["Credit"]
      }
    }
  }

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 10
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 20
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 25
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
