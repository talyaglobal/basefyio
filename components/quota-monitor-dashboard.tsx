"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, CheckCircle, Clock, Shield, Database, HardDrive, Zap, Package } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface QuotaViolation {
  id: string
  resource: 'database' | 'storage' | 'api' | 'backup'
  severity: 'low' | 'medium' | 'high' | 'critical'
  message: string
  utilizationPercent: number
  timestamp: string
  acknowledged: boolean
}

interface QuotaStatus {
  violationsDetected: number
  violations: QuotaViolation[]
  summary: {
    critical: number
    high: number
    medium: number
    low: number
  }
}

const resourceIcons = {
  database: Database,
  storage: HardDrive,
  api: Zap,
  backup: Package
}

const severityColors = {
  low: 'text-blue-600 bg-blue-50',
  medium: 'text-yellow-600 bg-yellow-50',
  high: 'text-orange-600 bg-orange-50',
  critical: 'text-red-600 bg-red-50'
}

const severityBadgeColors = {
  low: 'bg-blue-100 text-blue-800',
  medium: 'bg-yellow-100 text-yellow-800', 
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800'
}

export function QuotaMonitorDashboard() {
  const [quotaStatus, setQuotaStatus] = useState<QuotaStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const { toast } = useToast()

  const fetchQuotaStatus = async () => {
    try {
      const response = await fetch('/api/quotas/monitor')
      if (!response.ok) {
        throw new Error('Failed to fetch quota status')
      }
      const data = await response.json()
      setQuotaStatus(data)
    } catch (error) {
      console.error('Error fetching quota status:', error)
      toast({
        title: "Error",
        description: "Failed to load quota status",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const acknowledgeViolation = async (violationId: string) => {
    try {
      const response = await fetch(`/api/quotas/violations/${violationId}/acknowledge`, {
        method: 'POST'
      })
      
      if (!response.ok) {
        throw new Error('Failed to acknowledge violation')
      }

      // Update local state
      setQuotaStatus(prev => {
        if (!prev) return prev
        return {
          ...prev,
          violations: prev.violations.map(v => 
            v.id === violationId ? { ...v, acknowledged: true } : v
          )
        }
      })

      toast({
        title: "Success",
        description: "Violation acknowledged successfully",
      })
    } catch (error) {
      console.error('Error acknowledging violation:', error)
      toast({
        title: "Error",
        description: "Failed to acknowledge violation",
        variant: "destructive",
      })
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchQuotaStatus()
  }

  useEffect(() => {
    fetchQuotaStatus()
    
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchQuotaStatus, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 bg-gray-200 rounded"></div>
            ))}
          </div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      </div>
    )
  }

  const unacknowledgedViolations = quotaStatus?.violations.filter(v => !v.acknowledged) || []
  const hasActiveCritical = unacknowledgedViolations.some(v => v.severity === 'critical')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Quota Monitor</h2>
          <p className="text-muted-foreground">
            Real-time monitoring of resource quotas and usage
          </p>
        </div>
        <div className="flex items-center space-x-2">
          {hasActiveCritical && (
            <div className="flex items-center space-x-2 text-red-600">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm font-medium">Critical Issues</span>
            </div>
          )}
          <Button 
            onClick={handleRefresh} 
            disabled={refreshing}
            variant="outline"
            size="sm"
          >
            {refreshing ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 mr-2"></div>
                Refreshing
              </>
            ) : (
              'Refresh'
            )}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Violations</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {quotaStatus?.violationsDetected || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {unacknowledgedViolations.length} unacknowledged
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Critical</CardTitle>
            <div className="h-4 w-4 rounded-full bg-red-500"></div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {quotaStatus?.summary.critical || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">High</CardTitle>
            <div className="h-4 w-4 rounded-full bg-orange-500"></div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">
              {quotaStatus?.summary.high || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Medium</CardTitle>
            <div className="h-4 w-4 rounded-full bg-yellow-500"></div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {quotaStatus?.summary.medium || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Violations List */}
      <Card>
        <CardHeader>
          <CardTitle>Active Violations</CardTitle>
          <CardDescription>
            Current quota violations requiring attention
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!quotaStatus?.violations.length ? (
            <div className="text-center py-8">
              <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-green-600">All Good!</h3>
              <p className="text-muted-foreground">No quota violations detected</p>
            </div>
          ) : (
            <div className="space-y-4">
              {quotaStatus.violations.map((violation) => {
                const ResourceIcon = resourceIcons[violation.resource]
                return (
                  <div 
                    key={violation.id}
                    className={`p-4 rounded-lg border ${severityColors[violation.severity]} ${
                      violation.acknowledged ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <ResourceIcon className="h-5 w-5" />
                        <div>
                          <div className="flex items-center space-x-2">
                            <Badge className={severityBadgeColors[violation.severity]}>
                              {violation.severity.toUpperCase()}
                            </Badge>
                            <span className="capitalize font-medium">
                              {violation.resource}
                            </span>
                            {violation.acknowledged && (
                              <Badge variant="outline" className="text-green-600">
                                Acknowledged
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm mt-1">{violation.message}</p>
                          <div className="flex items-center space-x-4 mt-2 text-xs text-muted-foreground">
                            <span className="flex items-center space-x-1">
                              <span>Usage:</span>
                              <span className="font-mono">
                                {violation.utilizationPercent.toFixed(1)}%
                              </span>
                            </span>
                            <span className="flex items-center space-x-1">
                              <Clock className="h-3 w-3" />
                              <span>
                                {new Date(violation.timestamp).toLocaleString()}
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>
                      
                      {!violation.acknowledged && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => acknowledgeViolation(violation.id)}
                        >
                          Acknowledge
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}