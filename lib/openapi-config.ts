import swaggerJsdoc from "swagger-jsdoc"

const options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "KolayBase API",
      version: "1.0.0",
      description: "A comprehensive API for database management, storage, and authentication",
      contact: {
        name: "API Support",
        email: "support@kolaybase.com",
      },
    },
    servers: [
      {
        url: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api",
        description: "Development server",
      },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "kb_token",
          description: "JWT token stored in HTTP-only cookie",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "API key for authentication",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: {
              type: "string",
              description: "Error code",
            },
            message: {
              type: "string",
              description: "Human-readable error message",
            },
            details: {
              type: "object",
              description: "Additional error details",
            },
          },
        },
        User: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "User ID",
            },
            email: {
              type: "string",
              format: "email",
              description: "User email address",
            },
          },
        },
        Table: {
          type: "object",
          properties: {
            table_name: {
              type: "string",
              description: "Table name",
            },
            row_count: {
              type: "number",
              description: "Number of rows in the table",
            },
          },
        },
        StorageFile: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "File ID",
            },
            name: {
              type: "string",
              description: "File name",
            },
            size: {
              type: "number",
              description: "File size in bytes",
            },
            type: {
              type: "string",
              description: "MIME type",
            },
            url: {
              type: "string",
              format: "uri",
              description: "File URL",
            },
            created_at: {
              type: "string",
              format: "date-time",
              description: "Creation timestamp",
            },
          },
        },
        ApiKey: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "API key ID",
            },
            name: {
              type: "string",
              description: "API key name",
            },
            scopes: {
              type: "array",
              items: {
                type: "string",
              },
              description: "API key scopes",
            },
            created_at: {
              type: "string",
              format: "date-time",
              description: "Creation timestamp",
            },
            expires_at: {
              type: "string",
              format: "date-time",
              description: "Expiration timestamp",
              nullable: true,
            },
          },
        },
        Webhook: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Webhook ID",
            },
            url: {
              type: "string",
              format: "uri",
              description: "Webhook URL",
            },
            events: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Event types to subscribe to",
            },
            active: {
              type: "boolean",
              description: "Whether the webhook is active",
            },
            created_at: {
              type: "string",
              format: "date-time",
              description: "Creation timestamp",
            },
          },
        },
        PaginationResponse: {
          type: "object",
          properties: {
            nextCursor: {
              type: "string",
              nullable: true,
              description: "Cursor for next page",
            },
            hasMore: {
              type: "boolean",
              description: "Whether there are more results",
            },
          },
        },
      },
      responses: {
        UnauthorizedError: {
          description: "Authentication required",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        ForbiddenError: {
          description: "Insufficient permissions",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        NotFoundError: {
          description: "Resource not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        ValidationError: {
          description: "Request validation failed",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/Error" },
                  {
                    type: "object",
                    properties: {
                      details: {
                        type: "object",
                        properties: {
                          errors: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                path: {
                                  type: "array",
                                  items: {
                                    type: "string",
                                  },
                                },
                                message: {
                                  type: "string",
                                },
                                code: {
                                  type: "string",
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        InternalError: {
          description: "Internal server error",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        RateLimitError: {
          description: "Rate limit exceeded",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
      },
      parameters: {
        LimitParam: {
          name: "limit",
          in: "query",
          description: "Maximum number of items to return",
          schema: {
            type: "number",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
        },
        CursorParam: {
          name: "cursor",
          in: "query",
          description: "Cursor for pagination",
          schema: {
            type: "string",
          },
        },
        SortByParam: {
          name: "sortBy",
          in: "query",
          description: "Field to sort by",
          schema: {
            type: "string",
          },
        },
        SortOrderParam: {
          name: "sortOrder",
          in: "query",
          description: "Sort order",
          schema: {
            type: "string",
            enum: ["asc", "desc"],
            default: "desc",
          },
        },
      },
    },
    security: [
      {
        cookieAuth: [],
      },
      {
        apiKeyAuth: [],
      },
    ],
  },
  apis: [
    "./app/api/**/*.ts",
    "./lib/openapi-docs.ts",
  ],
}

export const specs = swaggerJsdoc(options)