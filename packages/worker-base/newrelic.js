/**
 * New Relic agent configuration for Lattice workers.
 *
 * See full configuration options at:
 * https://docs.newrelic.com/docs/apm/agents/nodejs-agent/installation-configuration/nodejs-agent-configuration/
 *
 * This file is loaded via -r newrelic when TELEMETRY_PROVIDER=newrelic
 */
exports.config = {
	/**
	 * Application name - set via NEW_RELIC_APP_NAME environment variable
	 */
	app_name: [process.env.NEW_RELIC_APP_NAME || "lattice-worker"],

	/**
	 * License key - set via NEW_RELIC_LICENSE_KEY environment variable
	 */
	license_key: process.env.NEW_RELIC_LICENSE_KEY || "",

	/**
	 * Enable/disable the agent - controlled via NEW_RELIC_ENABLED or TELEMETRY_PROVIDER
	 */
	agent_enabled:
		process.env.NEW_RELIC_ENABLED === "true" ||
		process.env.TELEMETRY_PROVIDER === "newrelic",

	/**
	 * Distributed tracing - W3C trace context format
	 */
	distributed_tracing: {
		enabled: true,
	},

	/**
	 * Transaction tracer settings
	 */
	transaction_tracer: {
		enabled: true,
		record_sql: "obfuscated",
		explain_threshold: 500,
	},

	/**
	 * Error collector settings
	 */
	error_collector: {
		enabled: true,
		ignore_status_codes: [404],
	},

	/**
	 * Logging configuration
	 */
	logging: {
		level: process.env.NEW_RELIC_LOG_LEVEL || "info",
		enabled: true,
		filepath: "stdout",
	},

	/**
	 * Allow all message headers for Kafka trace propagation
	 */
	allow_all_headers: true,

	/**
	 * Custom attributes
	 */
	attributes: {
		enabled: true,
		include: ["request.parameters.*", "message.parameters.*"],
	},

	/**
	 * Application logging configuration
	 *
	 * IMPORTANT: Log forwarding is DISABLED here because we use Fluent Bit
	 * (newrelic-logging.yml) for log shipping. Enabling both would cause
	 * duplicate logs in New Relic.
	 *
	 * - forwarding: DISABLED - Fluent Bit handles log shipping via Docker labels
	 * - local_decorating: ENABLED - Adds NR-LINKING metadata for trace correlation
	 * - metrics: ENABLED - Log count metrics still collected
	 */
	application_logging: {
		enabled: true,
		forwarding: {
			enabled: false, // Fluent Bit handles log shipping - see newrelic-logging.yml
		},
		metrics: {
			enabled: true,
		},
		local_decorating: {
			enabled: true, // Adds trace correlation metadata to logs
		},
	},
};
