import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  TableProperties,
  TrendingUp,
  AlertCircle,
  UploadCloud,
  Settings,
  Lightbulb,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Insights", href: "/insights", icon: Lightbulb },
  { name: "Explorer", href: "/explorer", icon: TableProperties },
  { name: "Trends", href: "/trends", icon: TrendingUp },
  { name: "Alerts", href: "/alerts", icon: AlertCircle },
  { name: "Uploads", href: "/upload", icon: UploadCloud },
  { name: "Settings", href: "/admin", icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar className="border-r">
          <SidebarHeader className="h-14 flex items-center px-4 border-b">
            <span className="font-bold text-lg text-primary tracking-tight">ChannelPulse</span>
          </SidebarHeader>
          <SidebarContent>
            <div className="py-4">
              <SidebarMenu>
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton
                      asChild
                      isActive={location === item.href}
                      tooltip={item.name}
                    >
                      <Link href={item.href} className="flex items-center gap-3">
                        <item.icon className="h-4 w-4" />
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </div>
          </SidebarContent>
        </Sidebar>
        <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
