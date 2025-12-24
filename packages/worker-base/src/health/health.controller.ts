import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { HealthService } from './health.service.js';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    kafka: { status: 'ok' | 'unhealthy'; message?: string };
    database?: { status: 'ok' | 'unhealthy'; message?: string };
  };
}

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness probe - is the process alive?
   * Used by Kubernetes to determine if container should be restarted.
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  async liveness(): Promise<{ status: 'ok' }> {
    return { status: 'ok' };
  }

  /**
   * Readiness probe - is the service ready to accept traffic?
   * Used by Kubernetes to determine if pod should receive traffic.
   */
  @Get('ready')
  async readiness(): Promise<HealthResponse> {
    const result = await this.healthService.check();

    if (result.status === 'unhealthy') {
      throw new ReadinessError(result);
    }

    return result;
  }

  /**
   * Detailed health check - returns full status
   */
  @Get()
  async getHealth(): Promise<HealthResponse> {
    return this.healthService.check();
  }
}

class ReadinessError extends Error {
  constructor(public readonly health: HealthResponse) {
    super('Service not ready');
  }
}
