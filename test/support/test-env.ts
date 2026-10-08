const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'error',
  HTTP_PORT: '0',
  INSTANCE_ID: 'test-runner',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5433',
  DATABASE_NAME: 'jungle_wagering',
  DATABASE_USER: 'jungle',
  DATABASE_PASSWORD: 'jungle',
  WALLET_LOCK_TIMEOUT_MS: '8000',
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
