process.env.NODE_ENV ??= 'development';
process.env.AI_PROVIDER ??= 'fake';
process.env.DATABASE_URL ??=
  'postgresql://leadops:leadops_dev@localhost:5432/leadops';

await import('./index.js');

export {};
