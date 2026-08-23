export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { createLogger, initTelemetry } = await import('@leadops/observability');
    const { validateProductionConfig } = await import('@leadops/core');

    const prodConfig = validateProductionConfig(process.env, 'web');
    const environment = prodConfig.environment;
    const logger = createLogger({ service: 'web', pretty: environment === 'local' });
    logger.info({ event: 'web.startup', environment }, 'Web server initializing');

    if (!prodConfig.valid) {
      logger.fatal(
        { event: 'web.configuration_error', errors: prodConfig.errors },
        'Production configuration validation failed: ' + prodConfig.errors.join('; '),
      );
      process.exit(1);
    }
    logger.info({ event: 'web.config_valid', environment }, 'Configuration validated');

    try {
      await initTelemetry({
        serviceName: 'leadops-web',
        environment,
        otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        enabled: process.env.OTEL_ENABLED === 'true',
        logger,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ event: 'telemetry.init_error', error: message }, 'Telemetry initialization error');
      if (environment === 'production' || environment === 'staging') {
        throw err;
      }
      logger.warn({ event: 'telemetry.fallback' }, 'Continuing without telemetry');
    }
  }
}
