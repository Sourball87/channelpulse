import { useState, useMemo } from "react";
import { useGetAlerts, useGetAvailableWeeks } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  AlertTriangle,
  AlertCircle,
  Info,
  PackageX,
  TrendingUp,
  PackageMinus,
  FileWarning,
  ChevronRight
} from "lucide-react";

const SEVERITY_ORDER = { critical: 1, warning: 2, info: 3 };

const ALERT_ICONS = {
  overstocked: PackageMinus,
  stockout_risk: PackageX,
  st_spike: TrendingUp,
  missing_upload: FileWarning,
  negative_soh: AlertCircle
};

const ALERT_TITLES = {
  overstocked: "Overstocked",
  stockout_risk: "Stockout Risk",
  st_spike: "Sell-Through Spike",
  missing_upload: "Missing Upload",
  negative_soh: "Negative SOH"
};

export default function Alerts() {
  const [week, setWeek] = useState<string>("latest");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const { data: weeks } = useGetAvailableWeeks();
  const queryWeek = week === "latest" && weeks?.length ? weeks[0].week_iso : week !== "latest" ? week : undefined;

  const { data: alerts, isLoading } = useGetAlerts({ week_iso: queryWeek });

  const filteredAlerts = useMemo(() => {
    if (!alerts) return [];
    let filtered = alerts;
    if (typeFilter !== "all") {
      filtered = filtered.filter(a => a.type === typeFilter);
    }
    return filtered.sort((a, b) => {
      // Sort by severity first
      const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sevDiff !== 0) return sevDiff;
      // Then by type
      return a.type.localeCompare(b.type);
    });
  }, [alerts, typeFilter]);

  const countsByType = useMemo(() => {
    if (!alerts) return {};
    return alerts.reduce((acc, curr) => {
      acc[curr.type] = (acc[curr.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }, [alerts]);

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <header className="flex-none bg-background border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Exceptions & Alerts</h1>
          <p className="text-sm text-muted-foreground">Auto-generated risks and opportunities</p>
        </div>
        <div className="flex items-center gap-4">
          <Select value={week} onValueChange={setWeek}>
            <SelectTrigger className="w-[180px] bg-background">
              <SelectValue placeholder="Select week" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Latest Week</SelectItem>
              {weeks?.map((w) => (
                <SelectItem key={w.week_iso} value={w.week_iso}>
                  {w.week_iso}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-start">
          
          {/* Filters Sidebar */}
          <div className="space-y-6">
            <Card className="shadow-xs">
              <CardHeader className="p-4 pb-2 border-b bg-muted/10">
                <CardTitle className="text-sm font-medium">Alert Types</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="flex flex-col">
                  <button
                    onClick={() => setTypeFilter("all")}
                    className={`flex items-center justify-between px-4 py-3 text-sm border-b transition-colors ${typeFilter === "all" ? "bg-muted/50 font-medium" : "hover:bg-muted/30"}`}
                  >
                    <span>All Alerts</span>
                    <Badge variant="secondary">{alerts?.length || 0}</Badge>
                  </button>
                  {Object.entries(ALERT_TITLES).map(([type, title]) => (
                    <button
                      key={type}
                      onClick={() => setTypeFilter(type)}
                      className={`flex items-center justify-between px-4 py-3 text-sm border-b last:border-0 transition-colors ${typeFilter === type ? "bg-muted/50 font-medium" : "hover:bg-muted/30"}`}
                    >
                      <div className="flex items-center gap-2">
                        {(() => {
                          const Icon = ALERT_ICONS[type as keyof typeof ALERT_ICONS];
                          return <Icon className="h-4 w-4 text-muted-foreground" />;
                        })()}
                        <span>{title}</span>
                      </div>
                      {countsByType[type] > 0 && (
                        <Badge variant="outline">{countsByType[type]}</Badge>
                      )}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Alert List */}
          <div className="md:col-span-3 space-y-4">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <Card key={i} className="shadow-xs">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-5 w-1/3" />
                        <Skeleton className="h-4 w-2/3" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : filteredAlerts.length === 0 ? (
              <div className="p-12 text-center border border-dashed rounded-lg bg-card text-muted-foreground">
                <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                  <AlertCircle className="h-6 w-6 opacity-50" />
                </div>
                <h3 className="text-lg font-medium text-foreground">No alerts found</h3>
                <p className="mt-1">There are no {typeFilter !== 'all' ? ALERT_TITLES[typeFilter as keyof typeof ALERT_TITLES].toLowerCase() : ''} exceptions for this week.</p>
              </div>
            ) : (
              filteredAlerts.map(alert => {
                const Icon = ALERT_ICONS[alert.type] || Info;
                
                let severityColor = "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800";
                let iconColor = "text-blue-500";
                
                if (alert.severity === 'critical') {
                  severityColor = "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800";
                  iconColor = "text-rose-500";
                } else if (alert.severity === 'warning') {
                  severityColor = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800";
                  iconColor = "text-amber-500";
                }

                return (
                  <Card key={alert.id} className="shadow-xs hover:shadow-md transition-shadow group overflow-hidden">
                    <div className="flex relative">
                      {/* Left color bar indicator */}
                      <div className={`w-1 absolute inset-y-0 left-0 ${
                        alert.severity === 'critical' ? 'bg-rose-500' : 
                        alert.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                      }`} />
                      
                      <CardContent className="p-4 pl-6 flex-1 flex items-start gap-4">
                        <div className={`p-2 rounded-full bg-muted flex shrink-0 ${iconColor}`}>
                          <Icon className="h-5 w-5" />
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-foreground tracking-tight">
                              {ALERT_TITLES[alert.type as keyof typeof ALERT_TITLES] || alert.type}
                            </span>
                            <Badge variant="outline" className={`text-[10px] uppercase font-bold tracking-wider ${severityColor}`}>
                              {alert.severity}
                            </Badge>
                            {alert.part_no && (
                              <Badge variant="secondary" className="font-mono text-xs">{alert.part_no}</Badge>
                            )}
                            {alert.reseller_name && (
                              <Badge variant="secondary" className="text-xs">{alert.reseller_name}</Badge>
                            )}
                          </div>
                          
                          <p className="text-sm text-muted-foreground">{alert.message}</p>
                          
                          {/* Metrics row if applicable */}
                          {(alert.soh != null || alert.st != null || alert.woi != null) && (
                            <div className="flex gap-6 mt-3 text-sm">
                              {alert.soh != null && (
                                <div><span className="text-muted-foreground mr-1">SOH:</span> <span className="font-medium">{alert.soh.toLocaleString()}</span></div>
                              )}
                              {alert.st != null && (
                                <div><span className="text-muted-foreground mr-1">ST:</span> <span className="font-medium">{alert.st.toLocaleString()}</span></div>
                              )}
                              {alert.woi != null && (
                                <div><span className="text-muted-foreground mr-1">WOI:</span> <span className="font-medium">{alert.woi.toFixed(1)}</span></div>
                              )}
                              {alert.trailing_avg_st != null && (
                                <div><span className="text-muted-foreground mr-1">Avg ST:</span> <span className="font-medium">{alert.trailing_avg_st.toFixed(1)}</span></div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Action link if relevant */}
                        {alert.part_id && alert.reseller_id && (
                          <Link href={`/explorer`} className="shrink-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground">
                            <div className="flex items-center gap-1 text-sm font-medium">
                              Drill <ChevronRight className="h-4 w-4" />
                            </div>
                          </Link>
                        )}
                      </CardContent>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}