import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export interface RequestWithTraceId extends Request {
  traceId?: string;
}

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: RequestWithTraceId, res: Response, next: NextFunction) {
    const incomingTraceId = req.headers['x-trace-id'];
    const traceId =
      (Array.isArray(incomingTraceId) ? incomingTraceId[0] : incomingTraceId) ||
      randomUUID();
    req.traceId = String(traceId);
    res.setHeader('x-trace-id', req.traceId);
    next();
  }
}
