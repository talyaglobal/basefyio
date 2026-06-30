import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ApiKeyPayload } from '../guards/api-key.guard';

export const ApiKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiKeyPayload | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.apiKeyPayload;
  },
);
