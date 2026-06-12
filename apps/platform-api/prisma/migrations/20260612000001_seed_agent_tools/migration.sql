-- Seed built-in agent tool catalogue.
-- Rows are idempotent: ON CONFLICT (tool_id) DO NOTHING means re-running this
-- migration never overwrites admin-customised rows.

INSERT INTO agent_tools (id, tool_id, name, description, input_schema, output_schema, risk, mutating, enabled)
VALUES
  (
    gen_random_uuid(),
    'web_search',
    'Web Search',
    'Search the web and return ranked results.',
    '{"type":"object","properties":{"query":{"type":"string"},"maxResults":{"type":"integer","default":5}},"required":["query"]}',
    '{"type":"object","properties":{"results":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"url":{"type":"string"},"snippet":{"type":"string"}}}}}}',
    'low',
    false,
    true
  ),
  (
    gen_random_uuid(),
    'code_interpreter',
    'Code Interpreter',
    'Execute Python code in an isolated sandbox and return stdout/stderr.',
    '{"type":"object","properties":{"code":{"type":"string"},"timeoutSeconds":{"type":"integer","default":30}},"required":["code"]}',
    '{"type":"object","properties":{"stdout":{"type":"string"},"stderr":{"type":"string"},"exitCode":{"type":"integer"}}}',
    'medium',
    false,
    true
  ),
  (
    gen_random_uuid(),
    'data_query',
    'Data Query',
    'Run a read-only SQL query against project data structures.',
    '{"type":"object","properties":{"sql":{"type":"string"},"dataStructureId":{"type":"string"}},"required":["sql"]}',
    '{"type":"object","properties":{"rows":{"type":"array"},"rowCount":{"type":"integer"}}}',
    'low',
    false,
    true
  ),
  (
    gen_random_uuid(),
    'data_write',
    'Data Write',
    'Insert or update rows in a project data structure. Requires allowMutating opt-in.',
    '{"type":"object","properties":{"dataStructureId":{"type":"string"},"operation":{"type":"string","enum":["insert","update","delete"]},"rows":{"type":"array"}},"required":["dataStructureId","operation","rows"]}',
    '{"type":"object","properties":{"affected":{"type":"integer"}}}',
    'high',
    true,
    true
  ),
  (
    gen_random_uuid(),
    'file_read',
    'File Read',
    'Read a file from project file storage.',
    '{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}',
    '{"type":"object","properties":{"content":{"type":"string"},"sizeBytes":{"type":"integer"},"contentType":{"type":"string"}}}',
    'low',
    false,
    true
  ),
  (
    gen_random_uuid(),
    'file_write',
    'File Write',
    'Write or overwrite a file in project file storage. Requires allowMutating opt-in.',
    '{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"contentType":{"type":"string"}},"required":["path","content"]}',
    '{"type":"object","properties":{"path":{"type":"string"},"sizeBytes":{"type":"integer"}}}',
    'medium',
    true,
    true
  ),
  (
    gen_random_uuid(),
    'http_request',
    'HTTP Request',
    'Make an outbound HTTP request. Disabled by default; enable per-project. Requires allowMutating opt-in.',
    '{"type":"object","properties":{"url":{"type":"string"},"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"],"default":"GET"},"headers":{"type":"object"},"body":{"type":"string"}},"required":["url"]}',
    '{"type":"object","properties":{"status":{"type":"integer"},"headers":{"type":"object"},"body":{"type":"string"}}}',
    'medium',
    true,
    false
  )
ON CONFLICT (tool_id) DO NOTHING;
