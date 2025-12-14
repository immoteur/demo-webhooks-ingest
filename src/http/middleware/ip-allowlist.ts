import type { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';

type ParsedAddr = ReturnType<typeof ipaddr.parse>;

export function ipAllowList(allowedIp: string | undefined) {
  if (!allowedIp) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const allowed = parseAllowed(allowedIp);

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = normalizeIp(req.ip ?? '');
    const remoteAddress = normalizeIp(req.socket.remoteAddress ?? '');

    if (isAllowed(allowed, ip) || isAllowed(allowed, remoteAddress)) return next();

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
