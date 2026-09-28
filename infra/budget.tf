# Cost safety first (master prompt §42, Phase 2 step 1).
#
# Created by hand in the Console, then adopted into Terraform with a one-time `import`
# block (applied 2026-09-25, since removed). Terraform now owns it.

resource "aws_budgets_budget" "monthly" {
  name         = "Future Unicorn Monthly Cost"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "40.0"
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  # Usage before credits and before tax: credits would hide real spending, and tax (VAT)
  # would shift every threshold by the tax rate.
  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = ["Credit", "Tax"]
      }
    }
  }

  # On the Paid plan the fixed infrastructure alone is ≈ $29 a month, so the old $10/$20/$25
  # alerts would fire every month and train you to ignore them. These only fire when a
  # month is really off: more than a running month should cost, or heading past $40.
  # Amounts are before tax.
  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 35
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 40
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}

# A daily ceiling: a normal running day costs ≈ $0.97 (paused ≈ $0.13), so a day over $2
# means something new is spending, whatever the service. Faster than the monthly budget, and
# unlike anomaly detection it needs no history, so a brand-new service (e.g. a stolen login
# starting machines) is caught after one day of billing data.
resource "aws_budgets_budget" "daily" {
  name         = "draftpage-daily"
  budget_type  = "COST"
  time_unit    = "DAILY"
  limit_amount = "2.0"
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  # Usage before credits and before tax: credits would hide real spending, and tax (VAT)
  # would shift every threshold by the tax rate.
  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = ["Credit", "Tax"]
      }
    }
  }

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}

# Step emails (owner request 2026-09-28): one email each time this month's usage, before
# credits and tax, passes $3, $5, $10, $20 and $30. A month running all the time (≈ $29)
# sends four of them; a mostly paused month one or two. AWS allows 5 alerts per budget.
resource "aws_budgets_budget" "steps" {
  name         = "draftpage-usage-steps"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "30.0"
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = ["Credit", "Tax"]
      }
    }
  }

  dynamic "notification" {
    for_each = [3, 5, 10, 20, 30]
    content {
      notification_type          = "ACTUAL"
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "ABSOLUTE_VALUE"
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
}

# "Something is charged to the card": the bill after credits (and with tax) passes one cent.
# Stays silent while the credits cover everything; fires when they run out or expire, or for
# charges they don't cover (e.g. some AWS Marketplace products).
resource "aws_budgets_budget" "out_of_pocket" {
  name         = "draftpage-charged-to-card"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "1.0"
  limit_unit   = "USD"
  # No filter and no metrics: the plain unblended bill, credits and tax included.

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 0.01
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
