import { Injectable } from "@nestjs/common";
import type { KafkaService } from "../kafka/kafka.service.js";
import type { HealthResponse } from "./health.controller.js";

export interface DatabaseHealthCheck {
	check(): Promise<boolean>;
}

export const DATABASE_HEALTH = "DATABASE_HEALTH";
export const HEALTH_SERVICE = "HEALTH_SERVICE";

@Injectable()
export class HealthService {
	constructor(
		private readonly kafka: KafkaService,
		private readonly dbHealth?: DatabaseHealthCheck,
	) {}

	async check(): Promise<HealthResponse> {
		const checks: HealthResponse["checks"] = {
			kafka: { status: "unhealthy" },
		};

		// Check Kafka
		if (this.kafka.isAlive()) {
			checks.kafka = { status: "ok" };
		} else {
			checks.kafka = { status: "unhealthy", message: "Kafka not connected" };
		}

		// Check database if available
		if (this.dbHealth) {
			try {
				const isHealthy = await this.dbHealth.check();
				checks.database = isHealthy
					? { status: "ok" }
					: { status: "unhealthy", message: "Database check failed" };
			} catch (error) {
				checks.database = {
					status: "unhealthy",
					message:
						error instanceof Error ? error.message : "Database check failed",
				};
			}
		}

		// Determine overall status
		const allOk = Object.values(checks).every((c) => c.status === "ok");
		const anyUnhealthy = Object.values(checks).some(
			(c) => c.status === "unhealthy",
		);

		return {
			status: allOk ? "ok" : anyUnhealthy ? "unhealthy" : "degraded",
			timestamp: new Date().toISOString(),
			checks,
		};
	}
}
