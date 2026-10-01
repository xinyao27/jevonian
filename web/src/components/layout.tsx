import {
  KeyRoundIcon,
  LayoutDashboardIcon,
  MonitorSmartphoneIcon,
  RouteIcon,
  ScrollTextIcon,
  ServerIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { ErrorBoundary } from "@/components/error-boundary";
import { ModeToggle } from "@/components/mode-toggle";
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

const linkGroups = [
  {
    label: "Workspace",
    links: [
      { to: "/", label: "Overview", icon: LayoutDashboardIcon, end: true },
      { to: "/logs", label: "Logs", icon: ScrollTextIcon },
    ],
  },
  {
    label: "Configuration",
    links: [
      { to: "/providers", label: "Providers", icon: ServerIcon },
      { to: "/routing", label: "Routing", icon: RouteIcon },
      { to: "/clients", label: "Clients", icon: MonitorSmartphoneIcon },
      { to: "/keys", label: "API keys", icon: KeyRoundIcon },
    ],
  },
];

const pageNames: Record<string, string> = {
  "/": "Overview",
  "/providers": "Providers",
  "/routing": "Routing",
  "/keys": "API keys",
  "/clients": "Clients",
  "/logs": "Logs",
};

export function Layout() {
  const { pathname } = useLocation();
  const pageName = pathname.startsWith("/logs/")
    ? "Log detail"
    : (pageNames[pathname] ?? "Overview");
  // Prefer the running process version from the API. Baked web assets can drift
  // ahead when the package on disk was updated without restarting the server.
  const [version, setVersion] = useState(__JEVONIAN_VERSION__);
  useEffect(() => {
    void api
      .update()
      .then((response) => setVersion(response.update.current))
      .catch(() => {
        /* keep the build-time fallback */
      });
  }, []);

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="border-sidebar-border">
        <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-2 py-0">
          <NavLink
            to="/"
            className="flex items-center gap-3 rounded-xl px-2 py-1 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0"
          >
            <span className="relative flex size-8 shrink-0 overflow-hidden rounded-xl bg-background shadow-[0_0_0_1px_var(--sidebar-border)]">
              <img src="/jevonian-logo.png" alt="" className="size-full object-cover" />
            </span>
            <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-base font-semibold tracking-tight">jevonian</span>
              <span className="truncate text-[11px] text-muted-foreground">Local model router</span>
            </span>
          </NavLink>
        </SidebarHeader>
        <SidebarContent className="gap-5 px-2 py-5">
          {linkGroups.map((group) => (
            <SidebarGroup key={group.label} className="gap-2 p-0">
              <p className="px-3 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase group-data-[collapsible=icon]:hidden">
                {group.label}
              </p>
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
                  {group.links.map((link) => (
                    <SidebarMenuItem key={link.to}>
                      <SidebarMenuButton
                        tooltip={link.label}
                        className="h-9 rounded-lg px-3 text-[13px] text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground [&.active]:bg-sidebar-accent [&.active]:font-semibold [&.active]:text-sidebar-accent-foreground"
                        render={
                          <NavLink to={link.to} end={link.end}>
                            <link.icon />
                            <span>{link.label}</span>
                          </NavLink>
                        }
                      />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-stretch">
            <SidebarMenu className="min-w-0 flex-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Star on GitHub"
                  className="text-muted-foreground"
                  render={
                    <a href={GITHUB_REPO} target="_blank" rel="noreferrer">
                      <GitHubIcon className="size-4 shrink-0" />
                      <span>Star on GitHub</span>
                    </a>
                  }
                />
              </SidebarMenuItem>
            </SidebarMenu>
            <ModeToggle className="group-data-[collapsible=icon]:w-full" />
          </div>
          <span className="px-2 text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            Version {version} · running locally
          </span>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background/90 px-5 backdrop-blur-sm md:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger className="md:hidden" />
            <span className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Workspace
            </span>
            <span className="text-muted-foreground/50">/</span>
            <span className="truncate text-xs font-semibold">{pageName}</span>
          </div>
          <span className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Local dashboard
          </span>
        </header>
        <main className="min-w-0 flex-1 px-5 py-8 md:px-10 md:py-10">
          <div className="mx-auto max-w-6xl">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
