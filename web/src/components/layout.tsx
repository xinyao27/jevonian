import {
  ActivityIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  MonitorSmartphoneIcon,
  RouteIcon,
  ScrollTextIcon,
  ServerIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { ErrorBoundary } from "@/components/error-boundary";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";

const GITHUB_REPO = "https://github.com/xinyao27/jevonian";

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
    </svg>
  );
}

const links = [
  { to: "/", label: "Overview", icon: LayoutDashboardIcon, end: true },
  { to: "/providers", label: "Providers", icon: ServerIcon },
  { to: "/routing", label: "Routing", icon: RouteIcon },
  { to: "/keys", label: "API keys", icon: KeyRoundIcon },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/clients", label: "Clients", icon: MonitorSmartphoneIcon },
  { to: "/logs", label: "Logs", icon: ScrollTextIcon },
];

export function Layout() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .update()
      .then((response) => {
        if (!cancelled) setVersion(response.update.current);
      })
      .catch(() => {
        // Version is decorative; leave the footer empty if the check fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b border-sidebar-border">
          <NavLink
            to="/"
            className="flex items-center gap-3 rounded-lg px-2 py-2.5 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0"
          >
            <span className="relative flex size-8 shrink-0 overflow-hidden rounded-xl bg-background shadow-[0_0_0_1px_var(--sidebar-border)]">
              <img src="/jevonian-logo.png" alt="" className="size-full object-cover" />
            </span>
            <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold tracking-tight">Jevonian</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {version ? `v${version}` : "Model router"}
              </span>
            </span>
          </NavLink>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {links.map((link) => (
                  <SidebarMenuItem key={link.to}>
                    <SidebarMenuButton
                      asChild
                      tooltip={link.label}
                      className="[&.active]:bg-sidebar-accent [&.active]:font-medium [&.active]:text-sidebar-accent-foreground"
                    >
                      <NavLink to={link.to} end={link.end}>
                        <link.icon />
                        <span>{link.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Star on GitHub" className="text-muted-foreground">
                <a href={GITHUB_REPO} target="_blank" rel="noreferrer">
                  <GitHubIcon className="size-4 shrink-0" />
                  <span>Star on GitHub</span>
                  <StarIcon className="ml-auto size-3.5 opacity-70" />
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 md:hidden">
          <SidebarTrigger />
        </header>
        <div className="min-w-0 flex-1 p-6">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
