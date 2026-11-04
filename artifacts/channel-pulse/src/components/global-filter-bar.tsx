import { formatWeekLabel } from "@/lib/week-display";
import { customerLabel } from "@/lib/customer-display";
import { useState, useMemo } from "react";
import { useFilters } from "@/context/filter-context";
import { useGetParts, useGetResellers } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ChevronDown, X, Filter, Calendar, Package, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const PRESETS = [
  { value: "last4",  label: "Last 4 wks" },
  { value: "last8",  label: "Last 8 wks" },
  { value: "last12", label: "Last 12 wks" },
  { value: "mtd",   label: "Month to date" },
  { value: "qtd",   label: "Qtr to date" },
  { value: "ytd",   label: "Year to date" },
  { value: "custom", label: "Custom…" },
];

// ── Parts Picker ──────────────────────────────────────────────────────────────

function PartsPicker() {
  const { partIds, setFilters } = useFilters();
  const { data: allParts } = useGetParts();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const grouped = useMemo(() => {
    if (!allParts) return {};
    const q = search.toLowerCase();
    const filtered = q
      ? allParts.filter(p => p.part_no.toLowerCase().includes(q) || (p.display_name?.toLowerCase() ?? "").includes(q))
      : allParts;
    const map: Record<string, typeof filtered> = {};
    for (const p of filtered) {
      const cat = p.category ?? "Other";
      map[cat] = map[cat] ?? [];
      map[cat].push(p);
    }
    return map;
  }, [allParts, search]);

  const togglePart = (id: number) => {
    const next = partIds.includes(id) ? partIds.filter(x => x !== id) : [...partIds, id];
    setFilters({ partIds: next });
  };

  const toggleCategory = (cat: string) => {
    const catIds = (grouped[cat] ?? []).map(p => p.id);
    const allSelected = catIds.every(id => partIds.includes(id));
    const next = allSelected
      ? partIds.filter(id => !catIds.includes(id))
      : [...new Set([...partIds, ...catIds])];
    setFilters({ partIds: next });
  };

  const clearParts = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFilters({ partIds: [] });
  };

  const label = partIds.length === 0
    ? "All Models"
    : partIds.length === 1
    ? (allParts?.find(p => p.id === partIds[0])?.part_no ?? "1 Model")
    : `${partIds.length} Models`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1.5 text-xs font-medium",
            partIds.length > 0 && "border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-600",
          )}
        >
          <Package className="h-3.5 w-3.5" />
          {label}
          {partIds.length > 0 ? (
            <span onClick={clearParts} className="ml-1 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800 p-0.5 -mr-1">
              <X className="h-3 w-3" />
            </span>
          ) : (
            <ChevronDown className="h-3 w-3 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search models…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No models found</CommandEmpty>
            {Object.entries(grouped).map(([cat, catParts]) => {
              const catIds = catParts.map(p => p.id);
              const allSel = catIds.length > 0 && catIds.every(id => partIds.includes(id));
              const someSel = catIds.some(id => partIds.includes(id));
              return (
                <CommandGroup key={cat} heading={
                  <div className="flex items-center gap-2 pr-2">
                    <Checkbox
                      checked={allSel ? true : someSel ? "indeterminate" : false}
                      onCheckedChange={() => toggleCategory(cat)}
                      className="h-3.5 w-3.5"
                    />
                    <span>{cat}</span>
                  </div>
                }>
                  {catParts.map(p => (
                    <CommandItem
                      key={p.id}
                      onSelect={() => togglePart(p.id)}
                      className="pl-6 gap-2"
                    >
                      <Checkbox
                        checked={partIds.includes(p.id)}
                        className="h-3.5 w-3.5 pointer-events-none"
                      />
                      <span className="font-mono text-xs">{p.part_no}</span>
                      {p.display_name && (
                        <span className="text-muted-foreground truncate text-xs">{p.display_name}</span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
          {partIds.length > 0 && (
            <div className="border-t p-2">
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs" onClick={() => setFilters({ partIds: [] })}>
                Clear selection ({partIds.length})
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Resellers Picker ──────────────────────────────────────────────────────────

function ResellersPicker() {
  const { resellerIds, setFilters } = useFilters();
  const { data: allResellers } = useGetResellers();
  const [open, setOpen] = useState(false);

  const toggleReseller = (id: number) => {
    const next = resellerIds.includes(id) ? resellerIds.filter(x => x !== id) : [...resellerIds, id];
    setFilters({ resellerIds: next });
  };

  const clearResellers = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFilters({ resellerIds: [] });
  };

  const label = resellerIds.length === 0
    ? "All Customers"
    : resellerIds.length === 1
    ? (allResellers?.find(r => r.id === resellerIds[0])?.name ?? "1 Customer")
    : `${resellerIds.length} Customers`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1.5 text-xs font-medium",
            resellerIds.length > 0 && "border-violet-400 bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-600",
          )}
        >
          <Users className="h-3.5 w-3.5" />
          {label}
          {resellerIds.length > 0 ? (
            <span onClick={clearResellers} className="ml-1 rounded-full hover:bg-violet-200 dark:hover:bg-violet-800 p-0.5 -mr-1">
              <X className="h-3 w-3" />
            </span>
          ) : (
            <ChevronDown className="h-3 w-3 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {(allResellers ?? []).map(r => (
                <CommandItem key={r.id} onSelect={() => toggleReseller(r.id)} className="gap-2">
                  <Checkbox checked={resellerIds.includes(r.id)} className="h-3.5 w-3.5 pointer-events-none" />
                  <span className="text-sm">{r.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground font-mono">{customerLabel(r.code)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {resellerIds.length > 0 && (
            <div className="border-t p-2">
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs" onClick={() => setFilters({ resellerIds: [] })}>
                Clear selection ({resellerIds.length})
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Date Picker ───────────────────────────────────────────────────────────────

function DatePicker() {
  const { mode, weekIso, preset, weekFrom, weekTo, resolvedWeek, periodLabel, availableWeeks, setFilters } = useFilters();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>(mode);

  const clearDate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFilters({ clearDate: true });
  };

  const isCustom = preset === "custom" || (!preset && weekFrom && weekTo);

  const buttonLabel = mode === "week"
    ? formatWeekLabel(resolvedWeek)
    : periodLabel;

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setTab(mode); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1.5 text-xs font-medium",
            mode === "period" && "border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-600",
          )}
        >
          <Calendar className="h-3.5 w-3.5" />
          {buttonLabel}
          {(weekIso || weekFrom || preset != null) ? (
            <span onClick={clearDate} className="ml-1 rounded-full hover:bg-amber-200 dark:hover:bg-amber-800 p-0.5 -mr-1">
              <X className="h-3 w-3" />
            </span>
          ) : (
            <ChevronDown className="h-3 w-3 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(460px,calc(100vw-2rem))] p-3" align="start">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full mb-3">
            <TabsTrigger value="week" className="flex-1 text-xs">Single Week</TabsTrigger>
            <TabsTrigger value="period" className="flex-1 text-xs">Period</TabsTrigger>
          </TabsList>

          {tab === "week" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Reporting week · Monday–Sunday (not the upload date)</p>
              <Select
                value={weekIso ?? resolvedWeek ?? ""}
                onValueChange={v => { setFilters({ weekIso: v }); setOpen(false); }}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Latest week" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={availableWeeks[0] ?? "latest"}>Latest · {formatWeekLabel(availableWeeks[0])}</SelectItem>
                  {availableWeeks.slice(1).map(w => (
                    <SelectItem key={w} value={w}>{formatWeekLabel(w)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {tab === "period" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Aggregate across a week range</p>
              <div className="grid grid-cols-2 gap-1.5">
                {PRESETS.filter(p => p.value !== "custom").map(p => (
                  <Button
                    key={p.value}
                    variant={preset === p.value && !isCustom ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => { setFilters({ preset: p.value }); if (p.value !== "custom") setOpen(false); }}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>

              <Separator />
              <p className="text-xs text-muted-foreground font-medium">Custom range</p>
              <div className="flex flex-col items-stretch gap-2">
                <Select
                  value={weekFrom ?? ""}
                  onValueChange={v => setFilters({ weekFrom: v, weekTo: weekTo ?? availableWeeks[0] })}
                >
                  <SelectTrigger className="h-7 text-xs flex-1">
                    <SelectValue placeholder="From" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableWeeks.slice().reverse().map(w => (
                      <SelectItem key={w} value={w} className="text-xs">{formatWeekLabel(w)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">to</span>
                <Select
                  value={weekTo ?? ""}
                  onValueChange={v => setFilters({ weekTo: v, weekFrom: weekFrom ?? availableWeeks[availableWeeks.length - 1] })}
                >
                  <SelectTrigger className="h-7 text-xs flex-1">
                    <SelectValue placeholder="To" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableWeeks.map(w => (
                      <SelectItem key={w} value={w} className="text-xs">{formatWeekLabel(w)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {weekFrom && weekTo && (
                <Button size="sm" className="w-full h-7 text-xs" onClick={() => setOpen(false)}>
                  Apply
                </Button>
              )}
            </div>
          )}
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

// ── Main GlobalFilterBar ──────────────────────────────────────────────────────

export function GlobalFilterBar() {
  const { isFiltered, clearFilters, periodLabel, partIds, resellerIds, mode, availableWeeks } = useFilters();

  if (!availableWeeks.length) return null; // don't show until weeks data is loaded

  return (
    <div className="flex-none border-b bg-muted/30 backdrop-blur-sm px-4 py-1.5 flex items-center gap-2 flex-wrap">
      <Filter className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />

      <PartsPicker />
      <ResellersPicker />
      <DatePicker />

      {isFiltered && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <Badge
            variant="secondary"
            className="h-6 gap-1 cursor-pointer text-xs hover:bg-muted/80 px-2"
            onClick={clearFilters}
          >
            <X className="h-3 w-3" /> Clear filters
          </Badge>
        </>
      )}

      {isFiltered && (
        <span className="ml-auto text-xs text-muted-foreground hidden sm:block truncate max-w-[300px]">
          {[
            partIds.length > 0 && `${partIds.length} model${partIds.length > 1 ? "s" : ""}`,
            resellerIds.length > 0 && `${resellerIds.length} customer${resellerIds.length > 1 ? "s" : ""}`,
            mode === "period" ? periodLabel : null,
          ].filter(Boolean).join(" · ")}
        </span>
      )}
    </div>
  );
}
