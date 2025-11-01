"use client"

import { GraphQLExplorer } from "@/components/graphql-explorer"
import { DatabaseRequired } from "@/components/database-required"

export default function GraphQLPage() {
  return (
    <DatabaseRequired message="Select or create a database to explore GraphQL API.">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">GraphQL Explorer</h1>
          <p className="text-muted-foreground mt-1">Test GraphQL queries and explore your API schema</p>
        </div>
        <GraphQLExplorer />
      </div>
    </DatabaseRequired>
  )
}
