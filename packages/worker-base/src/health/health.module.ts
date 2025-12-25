import { Module } from "@nestjs/common";
import { KafkaService } from "../kafka/kafka.service.js";
import { HealthController } from "./health.controller.js";
import {
	DATABASE_HEALTH,
	type DatabaseHealthCheck,
	HEALTH_SERVICE,
	HealthService,
} from "./health.service.js";

@Module({
	controllers: [HealthController],
	providers: [
		{
			provide: HEALTH_SERVICE,
			useFactory: (kafka: KafkaService, dbHealth?: DatabaseHealthCheck) => {
				return new HealthService(kafka, dbHealth);
			},
			inject: [KafkaService, { token: DATABASE_HEALTH, optional: true }],
		},
	],
	exports: [HEALTH_SERVICE],
})
export class HealthModule {}
