output "alert_policy_id" {
  description = "ID of the Lattice Workers alert policy"
  value       = newrelic_alert_policy.lattice_workers.id
}

output "dashboard_url" {
  description = "URL to the Lattice Workers dashboard"
  value       = "https://one.newrelic.com/dashboards/${newrelic_one_dashboard.lattice_workers.id}"
}

output "dashboard_id" {
  description = "ID of the Lattice Workers dashboard"
  value       = newrelic_one_dashboard.lattice_workers.id
}
