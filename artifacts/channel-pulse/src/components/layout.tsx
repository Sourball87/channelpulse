import { Link, useLocation, useSearch } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { FocusSidebar } from "@/components/focus-sidebar";
import {
  LayoutDashboard,
  TableProperties,
  TrendingUp,
  AlertCircle,
  UploadCloud,
  Settings,
  Lightbulb,
  Activity,
} from "lucide-react";
import { GlobalFilterBar } from "@/components/global-filter-bar";
import { useFilters } from "@/context/filter-context";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Insights", href: "/insights", icon: Lightbulb },
  { name: "Explorer", href: "/explorer", icon: TableProperties },
  { name: "Trends", href: "/trends", icon: TrendingUp },
  { name: "Alerts", href: "/alerts", icon: AlertCircle },
  { name: "Uploads", href: "/upload", icon: UploadCloud },
  { name: "Settings", href: "/admin", icon: Settings },
];

// Pages that show the global filter bar
const FILTER_PATHS = ["/", "/insights", "/explorer", "/trends", "/alerts"];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const { focusView } = useFilters();

  const showFilterBar = FILTER_PATHS.includes(location);

  return (
    <SidebarProvider style={{
      "--sidebar": "0 0% 98%",
      "--sidebar-foreground": "220 13% 24%",
      "--sidebar-border": "220 10% 84%",
      "--sidebar-accent": "190 52% 92%",
      "--sidebar-accent-foreground": "193 65% 25%",
    } as React.CSSProperties}>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar className="border-r">
          <SidebarHeader className="h-14 flex items-center px-4 border-b border-sidebar-border">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500/20 ring-1 ring-blue-400/30">
                <Activity className="h-4 w-4 text-cyan-700" />
              </div>
              <span className="text-[15px] font-semibold tracking-tight text-slate-700">
                Channel<span className="text-cyan-600 font-bold">Pulse</span>
              </span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <div className="py-4">
              <SidebarMenu>
                {navigation.map((item) => {
                  // Preserve filter params when navigating between filter-enabled pages
                  const targetIsFilterPage = FILTER_PATHS.includes(item.href);
                  const sourceIsFilterPage = FILTER_PATHS.includes(location);
                  const navParams = new URLSearchParams(search);
                  navParams.delete("view");
                  const navSearch = navParams.toString();
                  const href = targetIsFilterPage && sourceIsFilterPage && navSearch
                    ? `${item.href}?${navSearch}`
                    : item.href;

                  return (
                    <SidebarMenuItem key={item.name}>
                      <SidebarMenuButton
                        asChild
                        isActive={location === item.href && !focusView}
                        tooltip={item.name}
                      >
                        <Link href={href} className="flex items-center gap-3">
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </div>
            {showFilterBar && <FocusSidebar />}
          </SidebarContent>
        </Sidebar>
        <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
          <div className="flex-none flex items-center gap-2 border-b px-2 py-1 md:hidden">
            <SidebarTrigger aria-label="Open navigation and focus panel" />
            <span className="text-sm font-medium">ChannelPulse</span>
          </div>
          {showFilterBar && <GlobalFilterBar />}
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
