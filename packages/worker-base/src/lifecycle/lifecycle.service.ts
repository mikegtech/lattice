import {
  Injectable,
  OnApplicationShutdown,
  BeforeApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { LoggerService, LOGGER } from '../telemetry/logger.service.js';
import { TelemetryService } from '../telemetry/telemetry.service.js';

export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'ERROR';

type ShutdownCallback = () => Promise<void>;

@Injectable()
export class LifecycleService
  implements OnApplicationShutdown, BeforeApplicationShutdown
{
  private shutdownCallbacks: ShutdownCallback[] = [];
  private isShuttingDown = false;

  constructor(
    @Inject(LOGGER) private readonly logger: LoggerService,
    private readonly telemetry: TelemetryService,
  ) {
    // Register signal handlers
    process.on('SIGTERM', () => this.handleSignal('SIGTERM'));
    process.on('SIGINT', () => this.handleSignal('SIGINT'));
    process.on('uncaughtException', (error) => this.handleUncaughtException(error));
    process.on('unhandledRejection', (reason) => this.handleUnhandledRejection(reason));
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
    this.logger.info('Application shutdown starting', { signal });
    this.telemetry.increment('worker.shutdown_started');
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('Executing shutdown callbacks', {
      callback_count: this.shutdownCallbacks.length,
      signal,
    });

    // Execute shutdown callbacks in reverse order (LIFO)
    for (const callback of this.shutdownCallbacks.reverse()) {
      try {
        await callback();
      } catch (error) {
        this.logger.error(
          'Shutdown callback failed',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.telemetry.increment('worker.shutdown_completed');
    this.logger.info('Application shutdown complete');
  }

  private handleSignal(signal: ShutdownSignal): void {
    if (this.isShuttingDown) {
      this.logger.warn('Received signal during shutdown, ignoring', { signal });
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('Received shutdown signal', { signal });
    this.telemetry.increment('worker.signal_received', 1, { signal });
  }

  private handleUncaughtException(error: Error): void {
    this.logger.error('Uncaught exception', error.stack);
    this.telemetry.increment('worker.uncaught_exception');

    // Give time for logs to flush, then exit
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }

  private handleUnhandledRejection(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;

    this.logger.error('Unhandled rejection', stack, message);
    this.telemetry.increment('worker.unhandled_rejection');

    // Give time for logs to flush, then exit
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
}
