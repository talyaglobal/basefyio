import { BadRequestException, Controller, Get, HttpException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpService } from './mcp.service';

/**
 * The basefyio MCP server: Streamable HTTP, stateless. Every POST is
 * authenticated afresh with a platform API token, and a server holding only
 * the tools that token's scopes allow is built for that one request.
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    // A batch would run many calls on one rate-limit hit; MCP itself dropped batching.
    if (Array.isArray(req.body)) {
      throw new BadRequestException('Send one JSON-RPC message per request; batches are not supported.');
    }
    let token;
    try {
      token = await this.mcp.authenticate(req.headers.authorization);
      await this.mcp.rateLimit(token.id);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 401) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="basefyio"');
      }
      throw err;
    }

    const server = this.mcp.buildServer(token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Stateless: there is no server-sent event stream to open. */
  @Get()
  notAllowed(@Res({ passthrough: true }) res: Response) {
    res.status(405).setHeader('Allow', 'POST');
    return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Send MCP messages with POST.' }, id: null };
  }
}
