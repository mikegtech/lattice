import { Module, Optional } from "@nestjs/common";
import { KafkaService } from "../kafka/kafka.service.js";
import { HealthController } from "./health.controller.js";
import {
	DATABASE_HEALTH,
	type DatabaseHealthCheck,
	HealthService,
} from "./health.service.js";

@Module({
	controllers: [HealthController],
	providers: [
		{
			provide: HealthService,
			useFactory: (kafka: KafkaService, dbHealth?: DatabaseHealthCheck) => {
				return new HealthService(kafka, dbHealth);
			},
			inject: [KafkaService, { token: DATABASE_HEALTH, optional: true }],
		},
	],
	exports: [HealthService],
})
export class HealthModule {}
