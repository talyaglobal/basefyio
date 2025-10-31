"use client"

import dynamic from "next/dynamic"
import "swagger-ui-react/swagger-ui.css"

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false })

export default function ApiDocsPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">API Documentation</h1>
        <p className="text-muted-foreground">OpenAPI specification for the Kolaybase API</p>
      </div>
      <div className="bg-white rounded-md border">
        {/* Swagger UI renders client-side */}
        <SwaggerUI url="/api/openapi.json" docExpansion="list" defaultModelsExpandDepth={1} />
      </div>
    </div>
  )
}


