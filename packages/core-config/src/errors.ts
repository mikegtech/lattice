export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class MissingEnvVarError extends ConfigError {
  constructor(
    public readonly variableName: string,
    public readonly description?: string
  ) {
    super(
      `Missing required environment variable: ${variableName}${
        description ? ` (${description})` : ''
      }`
    );
    this.name = 'MissingEnvVarError';
  }
}

export class ValidationError extends ConfigError {
  constructor(
    message: string,
    public readonly errors: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
