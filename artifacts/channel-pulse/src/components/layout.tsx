import { Link, useLocation, useSearch } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { FocusSidebar } from "@/components/focus-sidebar";
import {
  LayoutDashboard,
  BarChart3,
  TableProperties,
  TrendingUp,
  AlertCircle,
  UploadCloud,
  Settings,
  Lightbulb,
  Activity,
  ReceiptText,
  LogOut,
} from "lucide-react";
import { GlobalFilterBar } from "@/components/global-filter-bar";
import { useFilters } from "@/context/filter-context";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";

const navigation = [
  { name: "SOH", href: "/", icon: LayoutDashboard },
  { name: "Sell Through", href: "/sell-through", icon: BarChart3 },
  { name: "Insights", href: "/insights", icon: Lightbulb },
  { name: "Explorer", href: "/explorer", icon: TableProperties },
  { name: "Trends", href: "/trends", icon: TrendingUp },
  { name: "Alerts", href: "/alerts", icon: AlertCircle },
  { name: "Uploads", href: "/upload", icon: UploadCloud },
  { name: "Scanback Claims", href: "/scanback", icon: ReceiptText },
  { name: "Settings", href: "/admin", icon: Settings },
];

// Pages that show the global filter bar
const FILTER_PATHS = ["/", "/sell-through", "/insights", "/explorer", "/trends", "/alerts"];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const { focusView } = useFilters();
  const { signOut } = useAuth();

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
                        isActive={location === item.href}
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
            {focusView && <FocusSidebar />}
          </SidebarContent>
          <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 text-sidebar-foreground"
              onClick={() => void signOut()}
              aria-label="Sign out of ChannelPulse"
            >
              <LogOut className="h-4 w-4" />
              <span>Sign out</span>
            </Button>
          </SidebarFooter>
        </Sidebar>
        <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
          <div className="flex-none flex items-center gap-2 border-b px-2 py-1 md:hidden">
            <SidebarTrigger aria-label="Open navigation and focus panel" />
            <span className="text-sm font-medium">ChannelPulse</span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              onClick={() => void signOut()}
              aria-label="Sign out of ChannelPulse"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
          {showFilterBar && <GlobalFilterBar />}
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
