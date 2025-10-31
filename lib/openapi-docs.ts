/**
 * @swagger
 * /api/auth/sign-in:
 *   post:
 *     tags: [Authentication]
 *     summary: Sign in user
 *     description: Authenticate user with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address
 *               password:
 *                 type: string
 *                 description: User password
 *     responses:
 *       200:
 *         description: Successful authentication
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/auth/sign-up:
 *   post:
 *     tags: [Authentication]
 *     summary: Sign up new user
 *     description: Create a new user account
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, name]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 description: User password (minimum 8 characters)
 *               name:
 *                 type: string
 *                 description: User full name
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/auth/sign-out:
 *   post:
 *     tags: [Authentication]
 *     summary: Sign out user
 *     description: Sign out current user and clear session
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Successfully signed out
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/tables:
 *   get:
 *     tags: [Tables]
 *     summary: List all tables
 *     description: Get a list of all tables with row counts
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of tables
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tables:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Table'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/tables/{tableName}:
 *   get:
 *     tags: [Tables]
 *     summary: Get table schema
 *     description: Get schema information for a specific table
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - name: tableName
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the table
 *     responses:
 *       200:
 *         description: Table schema
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 schema:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       column_name:
 *                         type: string
 *                       data_type:
 *                         type: string
 *                       is_nullable:
 *                         type: string
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/tables/{tableName}/rows:
 *   get:
 *     tags: [Tables]
 *     summary: Get table rows
 *     description: Get paginated rows from a table
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - name: tableName
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the table
 *       - $ref: '#/components/parameters/LimitParam'
 *       - $ref: '#/components/parameters/CursorParam'
 *       - name: select
 *         in: query
 *         description: Columns to select (comma-separated)
 *         schema:
 *           type: string
 *       - name: where
 *         in: query
 *         description: WHERE clause conditions
 *         schema:
 *           type: string
 *       - name: orderBy
 *         in: query
 *         description: ORDER BY clause
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Table rows
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - type: object
 *                   properties:
 *                     rows:
 *                       type: array
 *                       items:
 *                         type: object
 *                 - $ref: '#/components/schemas/PaginationResponse'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *   post:
 *     tags: [Tables]
 *     summary: Insert table row
 *     description: Insert a new row into a table
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - name: tableName
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the table
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [data]
 *             properties:
 *               data:
 *                 type: object
 *                 description: Row data as key-value pairs
 *     responses:
 *       201:
 *         description: Row created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 row:
 *                   type: object
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/storage:
 *   get:
 *     tags: [Storage]
 *     summary: List storage files
 *     description: Get a paginated list of user's storage files
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/LimitParam'
 *       - $ref: '#/components/parameters/CursorParam'
 *       - name: prefix
 *         in: query
 *         description: File name prefix filter
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of storage files
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - type: object
 *                   properties:
 *                     files:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/StorageFile'
 *                 - $ref: '#/components/schemas/PaginationResponse'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/storage/upload:
 *   post:
 *     tags: [Storage]
 *     summary: Upload file
 *     description: Upload a file to storage
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: File to upload
 *     responses:
 *       201:
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 file:
 *                   $ref: '#/components/schemas/StorageFile'
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/api-keys:
 *   get:
 *     tags: [API Keys]
 *     summary: List API keys
 *     description: Get a list of user's API keys
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: List of API keys
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKeys:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiKey'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *   post:
 *     tags: [API Keys]
 *     summary: Create API key
 *     description: Create a new API key with specified scopes
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, scopes]
 *             properties:
 *               name:
 *                 type: string
 *                 description: API key name
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: API key scopes
 *               expiresAt:
 *                 type: string
 *                 format: date-time
 *                 description: Optional expiration date
 *     responses:
 *       201:
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 apiKey:
 *                   $ref: '#/components/schemas/ApiKey'
 *                 token:
 *                   type: string
 *                   description: The actual API key token (only shown once)
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/webhooks:
 *   get:
 *     tags: [Webhooks]
 *     summary: List webhooks
 *     description: Get a list of user's webhooks
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of webhooks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 webhooks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Webhook'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *   post:
 *     tags: [Webhooks]
 *     summary: Create webhook
 *     description: Create a new webhook subscription
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, events]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *                 description: Webhook URL
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Event types to subscribe to
 *               secret:
 *                 type: string
 *                 description: Optional webhook secret for HMAC verification
 *               headers:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *                 description: Optional custom headers
 *     responses:
 *       201:
 *         description: Webhook created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 webhook:
 *                   $ref: '#/components/schemas/Webhook'
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */

/**
 * @swagger
 * /api/sql/execute:
 *   post:
 *     tags: [SQL]
 *     summary: Execute SQL query
 *     description: Execute a SQL query with optional parameters
 *     security:
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *                 description: SQL query to execute
 *               params:
 *                 type: array
 *                 items:
 *                   oneOf:
 *                     - type: string
 *                     - type: number
 *                     - type: boolean
 *                     - type: 'null'
 *                 description: Optional query parameters
 *               readOnly:
 *                 type: boolean
 *                 default: false
 *                 description: Whether this is a read-only query
 *     responses:
 *       200:
 *         description: Query executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                 rowCount:
 *                   type: number
 *                   description: Number of affected rows
 *       422:
 *         $ref: '#/components/responses/ValidationError'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */