import { Router } from 'express';
import { defaultDisputeService } from '../services/disputeService.js';
import { refundsCache } from '../services/refundsCacheWarm.js';
import { successEnvelope, errorEnvelope, getRequestId } from '../lib/envelope.js';
import type { ResponseMeta } from '../types/ResponseEnvelope.js';

const router = Router();

function listRefunds(requestId: string, refunds: any, statusFilter?: string): any {
  const total = refunds.length;
  const meta: ResponseMeta = { total };
  return successEnvelope(refunds, requestId, meta);
}

function authenticateUser(req: Request): string | null {
  const userId = req.header('x-user-id');
  if (userId) return userId.trim();

  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const token = authHeader.slice(7);
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
          userId?: string;
          sub?: string;
        };
        return payload.userId || payload.sub || null;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function authenticateAdmin(req: Request): boolean {
  const apiKey = req.header('x-admin-api-key');
  const configuredKey = process.env.ADMIN_API_KEY;
  if (apiKey && configuredKey && timingSafeStringEqual(apiKey, configuredKey)) {
    return true;
  }

  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const token = authHeader.slice(7);
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
          role?: string;
        };
        if (payload.role === 'admin') {
          return true;
        }
      } catch {
        // fall through
      }
    }
  }
  return false;
}

import { timingSafeStringEqual } from '../lib/timingSafe.js';

router.post('/', (req, res) => {
  const requestId = getRequestId(req);
  const userId = authenticateUser(req);
  if (!userId) {
    res.status(401).json(errorEnvelope('UNAUTHORIZED', 'Authentication required', requestId));
    return;
  }

  const body = req.body as {
    usageEventId?: string;
    reason?: string;
    amountUsdc?: string;
  };

  if (!body.usageEventId) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'usageEventId is required', requestId, ['usageEventId is required']));
    return;
  }

  if (!body.reason) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'reason is required', requestId, ['reason is required']));
    return;
  }

  if (body.reason.length < 10) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'reason must be at least 10 characters', requestId, ['reason must be at least 10 characters']));
    return;
  }

  if (body.reason.length > 1000) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'reason must be at most 1000 characters', requestId, ['reason must be at most 1000 characters']));
    return;
  }

  if (!body.amountUsdc) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'amountUsdc is required', requestId, ['amountUsdc is required']));
    return;
  }

  const amount = Number(body.amountUsdc);
  if (isNaN(amount) || !isFinite(amount)) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'amountUsdc must be a valid number', requestId, ['amountUsdc must be a valid number']));
    return;
  }

  if (amount <= 0) {
    res.status(400).json(errorEnvelope('BAD_REQUEST', 'amountUsdc must be a positive number', requestId, ['amountUsdc must be a positive number']));
    return;
  }

  const dispute = defaultDisputeService.openDispute(
    { usage_event_id: body.usageEventId, reason: body.reason, amountUsdc: body.amountUsdc },
    userId
  );

  res.status(201).json(successEnvelope({ ...dispute, developerId: userId }, requestId));
});

router.get('/', (req, res) => {
  const requestId = getRequestId(req);
  const statusFilter = (req.query.status as string) || undefined;

  if (statusFilter && !['pending', 'approved', 'rejected'].includes(statusFilter)) {
    res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'Invalid status query param', requestId));
    return;
  }

  if (authenticateAdmin(req)) {
    const cached = refundsCache.get('admin:all');
    if (cached !== undefined) {
      const filtered = statusFilter
        ? cached.filter((d: any) => d.status === statusFilter)
        : cached;
      res.json(listRefunds(requestId, filtered, statusFilter));
      return;
    }

    const all = defaultDisputeService.listAll();
    const refunds = all.filter((d) => d.status === 'REFUNDED');
    refundsCache.set('admin:all', refunds);

    const filtered = statusFilter
      ? refunds.filter((d: any) => d.status === statusFilter)
      : refunds;
    res.json(listRefunds(requestId, filtered, statusFilter));
    return;
  }

  const userId = authenticateUser(req);
  if (!userId) {
    res.status(401).json(errorEnvelope('UNAUTHORIZED', 'Authentication required', requestId));
    return;
  }

  const cacheKey = `user:${userId}`;
  const cached = refundsCache.get(cacheKey);
  if (cached !== undefined) {
    const filtered = statusFilter
      ? cached.filter((d: any) => d.status === statusFilter)
      : cached;
    res.json(listRefunds(requestId, filtered, statusFilter));
    return;
  }

  const all = defaultDisputeService.listAll();
  const refunds = all.filter((d) => d.status === 'REFUNDED' && d.opened_by === userId);
  refundsCache.set(cacheKey, refunds);

  const filtered = statusFilter
    ? refunds.filter((d: any) => d.status === statusFilter)
    : refunds;
  res.json(listRefunds(requestId, filtered, statusFilter));
});

export function getRefundStore() {
  return (defaultDisputeService as any).repo?.disputes || new Map();
}

export function clearRefundStore() {
  const repo = (defaultDisputeService as any).repo;
  if (repo && repo.disputes) {
    repo.disputes.clear();
  }
}

export default router;