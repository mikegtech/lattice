import {
	type BeforeApplicationShutdown,
	Injectable,
	type OnApplicationShutdown,
} from "@nestjs/common";
import type { EventLogger } from "../telemetry/events.js";
import type { LoggerService } from "../telemetry/logger.service.js";
import type { TelemetryService } from "../telemetry/telemetry.service.js";

export type ShutdownSignal = "SIGTERM" | "SIGINT" | "ERROR";

type ShutdownCallback = () => Promise<void>;

@Injectable()
export class LifecycleService
	implements OnApplicationShutdown, BeforeApplicationShutdown
{
	private shutdownCallbacks: ShutdownCallback[] = [];
	private isShuttingDown = false;
	private shutdownStartTime?: number;
	private shutdownSignal?: string;
	private inFlightCount = 0;

	constructor(
		private readonly logger: LoggerService,
		private readonly telemetry: TelemetryService,
		private readonly eventLogger: EventLogger,
	) {
		// Register signal handlers
		process.on("SIGTERM", () => this.handleSignal("SIGTERM"));
		process.on("SIGINT", () => this.handleSignal("SIGINT"));
		process.on("uncaughtException", (error) =>
			this.handleUncaughtException(error),
		);
		process.on("unhandledRejection", (reason) =>
			this.handleUnhandledRejection(reason),
		);
	}

	/**
	 * Update the in-flight message count (called by KafkaService)
	 */
	setInFlightCount(count: number): void {
		this.inFlightCount = count;
	}

	/**
	 * Register a callback to be executed during shutdown
	 */
	onShutdown(callback: ShutdownCallback): void {
		this.shutdownCallbacks.push(callback);
	}

	/**
	 * Check if shutdown is in progress
	 */
	isShutdownInProgress(): boolean {
		return this.isShuttingDown;
	}

	async beforeApplicationShutdown(signal?: string): Promise<void> {
		this.shutdownStartTime = Date.now();
		this.shutdownSignal = signal;
		this.eventLogger.workerShutdownInitiated(this.inFlightCount, signal);
		this.telemetry.increment("worker.shutdown_started");
	}

	async onApplicationShutdown(signal?: string): Promise<void> {
		// Execute shutdown callbacks in reverse order (LIFO)
		for (const callback of this.shutdownCallbacks.reverse()) {
			try {
				await callback();
			} catch (error) {
				this.logger.error(
					"Shutdown callback failed",
					error instanceof Error ? error.stack : String(error),
				);
			}
		}

		const durationMs = this.shutdownStartTime
			? Date.now() - this.shutdownStartTime
			: 0;
		const reason = this.shutdownSignal ? "signal" : "graceful";
		this.eventLogger.workerShutdownCompleted(durationMs, reason);
		this.telemetry.increment("worker.shutdown_completed");
	}

	private handleSignal(signal: ShutdownSignal): void {
		if (this.isShuttingDown) {
			return;
		}

		this.isShuttingDown = true;
		this.shutdownSignal = signal;
		this.telemetry.increment("worker.signal_received", 1, { signal });
	}

	private handleUncaughtException(error: Error): void {
		this.logger.error("Uncaught exception", error.stack);
		this.telemetry.increment("worker.uncaught_exception");

		// Give time for logs to flush, then exit
		setTimeout(() => {
			process.exit(1);
		}, 1000);
	}

	private handleUnhandledRejection(reason: unknown): void {
		const message = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error ? reason.stack : undefined;

		this.logger.error("Unhandled rejection", stack, message);
		this.telemetry.increment("worker.unhandled_rejection");

		// Give time for logs to flush, then exit
		setTimeout(() => {
			process.exit(1);
		}, 1000);
	}
}
