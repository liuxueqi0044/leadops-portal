import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export interface CallbackAddress {
  address: string;
  family: 4 | 6;
}

export type CallbackDnsLookup = (hostname: string) => Promise<readonly CallbackAddress[]>;

export interface CallbackUrlOptions {
  allowLocalhost?: boolean;
  lookup?: CallbackDnsLookup;
}

export interface ResolvedCallbackUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

export class UnsafeCallbackUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCallbackUrlError';
  }
}

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function normalizeMappedIpv4(address: string): string {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  return dotted?.[1] ?? normalized;
}

function isLocalhostName(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

function isAllowedLoopback(address: string): boolean {
  const normalized = normalizeMappedIpv4(address);
  return normalized === '127.0.0.1' || normalized === '::1';
}

export function isPublicCallbackAddress(
  address: string,
  options: Pick<CallbackUrlOptions, 'allowLocalhost'> = {},
): boolean {
  const normalized = normalizeMappedIpv4(address);
  if (normalized.startsWith('::ffff:')) return false;
  const family = isIP(normalized);
  if (family === 0 || normalized.includes('%')) return false;
  if (options.allowLocalhost && isAllowedLoopback(normalized)) return true;
  return !blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

export function parseCallbackUrl(
  input: string,
  options: Pick<CallbackUrlOptions, 'allowLocalhost'> = {},
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeCallbackUrlError('callback URL is invalid');
  }

  if (url.username || url.password) {
    throw new UnsafeCallbackUrlError('callback URL userinfo is not allowed');
  }
  if (url.hash) {
    throw new UnsafeCallbackUrlError('callback URL fragments are not allowed');
  }

  const hostname = stripIpv6Brackets(url.hostname);
  const localTarget = isLocalhostName(hostname) || isAllowedLoopback(hostname);
  const localException = options.allowLocalhost === true && localTarget;

  if (url.protocol !== 'https:' && !(localException && url.protocol === 'http:')) {
    throw new UnsafeCallbackUrlError('callback URL must use HTTPS');
  }

  if (url.port && !localException && url.port !== '443') {
    throw new UnsafeCallbackUrlError('callback URL must use the standard HTTPS port');
  }

  if (isLocalhostName(hostname) && !options.allowLocalhost) {
    throw new UnsafeCallbackUrlError('localhost callback targets are not allowed');
  }

  if (isIP(hostname) !== 0 && !isPublicCallbackAddress(hostname, options)) {
    throw new UnsafeCallbackUrlError('callback URL resolves to a non-public address');
  }

  return url;
}

const systemLookup: CallbackDnsLookup = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

export async function resolveCallbackUrl(
  input: string,
  options: CallbackUrlOptions = {},
): Promise<ResolvedCallbackUrl> {
  const url = parseCallbackUrl(input, options);
  const hostname = stripIpv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);

  if (literalFamily !== 0) {
    if (!isPublicCallbackAddress(hostname, options)) {
      throw new UnsafeCallbackUrlError('callback URL resolves to a non-public address');
    }
    return { url, address: hostname, family: literalFamily === 6 ? 6 : 4 };
  }

  let addresses: readonly CallbackAddress[];
  try {
    addresses = await (options.lookup ?? systemLookup)(hostname);
  } catch {
    throw new UnsafeCallbackUrlError('callback hostname could not be resolved');
  }

  if (addresses.length === 0) {
    throw new UnsafeCallbackUrlError('callback hostname has no addresses');
  }

  for (const candidate of addresses) {
    if (!isPublicCallbackAddress(candidate.address, options)) {
      throw new UnsafeCallbackUrlError('callback hostname resolves to a non-public address');
    }
  }

  const selected = addresses[0];
  if (!selected) throw new UnsafeCallbackUrlError('callback hostname has no addresses');
  return { url, address: selected.address, family: selected.family };
}
