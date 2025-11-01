"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ActivityFeed } from "@/components/activity-feed"
import { DatabaseRequired } from "@/components/database-required"

export default function ActivityPage() {
  return (
    <DatabaseRequired message="Select or create a database to view activity.">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Activity</h1>
          <p className="text-muted-foreground mt-1">Recent actions across your project</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Events like table changes, storage uploads, and policy updates</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityFeed />
          </CardContent>
        </Card>
      </div>
    </DatabaseRequired>
  )
}


