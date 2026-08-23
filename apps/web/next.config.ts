import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  ...(process.env.LEADOPS_STANDALONE_BUILD === 'true'
    ? {
        output: 'standalone' as const,
        outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
      }
    : {}),
  poweredByHeader: false,
  // The root CI gate runs the shared flat ESLint config explicitly. Avoid
  // Next 15's legacy build-time detector producing a false missing-plugin warning.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@leadops/db', '@leadops/core', '@leadops/events', '@leadops/email', '@leadops/n8n'],
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
