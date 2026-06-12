# Developer Access — Connection Info

GET /v1/projects/:projectId/access

Returns connection endpoints, entitlements, and ready-to-use snippets.
No passwords or private keys are ever returned.

## Response shape

```json
{ "projectId": "...", "slug": "...", "endpoints": [], "entitlements": {}, "warning": "..." }
```

Each endpoint includes: `engineType`, `host`, `port`, `username`, `database`,
`connectionString` (no password), `sslMode`, `requiresClientCert`, `snippets`.

`warning` is optional and is present when access is not yet provisioned or
the plan does not include the feature.

## SDK

```ts
const info = await client.access.getProjectAccess('proj-id');
if (info.warning) console.warn(info.warning);
for (const ep of info.endpoints) {
  console.log(ep.connectionString);
}
```

## CLI

```sh
basefyio access <projectId>
```

## Error codes

| Code | Meaning |
|------|---------|
| 403  | Plan does not include `externalDbAccess`, or user is not a project member. |
| 404  | Project not found. |
