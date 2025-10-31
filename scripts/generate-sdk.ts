#!/usr/bin/env tsx
/**
 * Generates TypeScript SDK client from OpenAPI spec
 * 
 * Usage: npx tsx scripts/generate-sdk.ts
 */

import { writeFileSync } from "fs"
import { join } from "path"

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000"
const OPENAPI_URL = `${BASE_URL}/api/openapi.json`

async function generateSDK() {
  console.log(`Fetching OpenAPI spec from ${OPENAPI_URL}...`)
  
  try {
    const response = await fetch(OPENAPI_URL)
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: ${response.statusText}`)
    }
    
    const spec = await response.json()
    console.log("OpenAPI spec loaded successfully")
    
    // Generate basic typed client
    const clientCode = generateClient(spec)
    
    const outputPath = join(process.cwd(), "lib", "generated-client.ts")
    writeFileSync(outputPath, clientCode, "utf-8")
    
    console.log(`✅ SDK generated at ${outputPath}`)
  } catch (error) {
    console.error("❌ Failed to generate SDK:", error)
    process.exit(1)
  }
}

function generateClient(spec: any): string {
  const paths = spec.paths || {}
  const methods: string[] = []
  
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(operations as any)) {
      if (["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())) {
        const opObj = op as any
        const summary = opObj.summary || `${method.toUpperCase()} ${path}`
        const operationId = opObj.operationId || `${method}${path.replace(/[^a-zA-Z0-9]/g, "")}`
        
        const params: string[] = []
        const queryParams: string[] = []
        const pathParams = path.match(/\{(\w+)\}/g) || []
        
        if (pathParams.length > 0) {
          pathParams.forEach((p) => {
            const paramName = p.replace(/[{}]/g, "")
            params.push(`${paramName}: string`)
          })
        }
        
        // Check for query params
        const queryParamsList = opObj.parameters?.filter((p: any) => p.in === "query") || []
        if (queryParamsList.length > 0) {
          queryParams.push("query?: {")
          queryParamsList.forEach((p: any) => {
            queryParams.push(`  ${p.name}?: ${p.schema?.type || "string"}`)
          })
          queryParams.push("}")
          params.push(queryParams.join("\n"))
        }
        
        // Check for request body
        const requestBody = opObj.requestBody
        if (requestBody) {
          params.push("body?: any")
        }
        
        const returnType = opObj.responses?.["200"]?.content?.["application/json"]?.schema
          ? "any"
          : "Promise<any>"
        
        methods.push(`
  /**
   * ${summary}
   * ${opObj.description || ""}
   */
  ${operationId}(${params.join(", ")}): ${returnType} {
    ${pathParams.length > 0 
      ? `const url = \`${path.replace(/\{(\w+)\}/g, "${$1}")}\``
      : `const url = "${path}"`}
    ${queryParams.length > 0 
      ? `const searchParams = new URLSearchParams(); if (query) { Object.entries(query).forEach(([k, v]) => { if (v !== undefined) searchParams.set(k, String(v)) }); }`
      : ""}
    ${queryParams.length > 0 ? `const fullUrl = url + (searchParams.toString() ? "?" + searchParams.toString() : "")` : `const fullUrl = url`}
    return fetch(fullUrl, {
      method: "${method.toUpperCase()}",
      ${requestBody ? "body: JSON.stringify(body)," : ""}
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: \`Bearer \${this.token}\` } : {}) },
      credentials: "include",
    }).then(r => r.json())
  }`)
      }
    }
  }
  
  return `/**
 * Generated TypeScript SDK Client
 * Auto-generated from OpenAPI spec - DO NOT EDIT MANUALLY
 */

export class KolaybaseSDK {
  private token?: string
  private baseUrl: string

  constructor(baseUrl = "${BASE_URL}") {
    this.baseUrl = baseUrl
  }

  setToken(token: string) {
    this.token = token
  }
${methods.join("\n")}
}

export const sdk = new KolaybaseSDK()
`
}

if (require.main === module) {
  generateSDK()
}

export { generateSDK }

