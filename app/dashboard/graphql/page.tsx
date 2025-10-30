import { getUser } from "@/lib/auth"
import { GraphQLExplorer } from "@/components/graphql-explorer"

export default async function GraphQLPage() {
  const user = await getUser()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">GraphQL Explorer</h1>
        <p className="text-muted-foreground mt-1">Test GraphQL queries and explore your API schema</p>
      </div>
      <GraphQLExplorer />
    </div>
  )
}
