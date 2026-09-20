import type { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';

type ParsedAddr = ReturnType<typeof ipaddr.parse>;

export function ipAllowList(allowedIp: string | undefined) {
  if (!allowedIp?.trim()) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const allowed = allowedIp.split(',').map((entry, index) => {
    try {
      return parseAllowed(entry);
    } catch {
      throw new Error(`WEBHOOK_ALLOWED_IP contains an invalid entry at position ${index + 1}`);
    }
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = normalizeIp(req.ip ?? '');
    const remoteAddress = normalizeIp(req.socket.remoteAddress ?? '');

    if (allowed.some((entry) => isAllowed(entry, ip) || isAllowed(entry, remoteAddress))) {
      return next();
    }

    res.status(403).json({ ok: false });
  };
}

type Allowed =
  | { kind: 'single'; addr: ParsedAddr }
  | {
      kind: 'cidr';
      addr: ParsedAddr;
      prefix: number;
    };

function parseAllowed(input: string): Allowed {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty allowlist entry');
  if (trimmed.includes('/')) {
    const [addr, prefix] = ipaddr.parseCIDR(trimmed);
    return { kind: 'cidr', addr, prefix };
  }

  return { kind: 'single', addr: ipaddr.parse(trimmed) };
}

function isAllowed(allowed: Allowed, ip: string): boolean {
  if (!ip) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;

  if (allowed.kind === 'single') {
    return parsed.toString() === allowed.addr.toString();
  }

  if (parsed.kind() !== allowed.addr.kind()) return false;
  return parsed.match(allowed.addr, allowed.prefix);
}

function parseIp(ip: string): ParsedAddr | null {
  try {
    return ipaddr.process(ip);
  } catch {
    return null;
  }
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice('::ffff:'.length);
  return trimmed;
}
