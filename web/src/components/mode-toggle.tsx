import { Menu } from "@base-ui-components/react/menu";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ComponentType } from "react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ThemeOption = {
  value: Theme;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const OPTIONS: readonly ThemeOption[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

/**
 * Compact theme switcher for the sidebar footer right edge.
 *
 * Built on Base UI Menu (no Radix). Opens Light / Dark / System.
 */
export function ModeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("relative shrink-0 text-muted-foreground", className)}
            aria-label="Toggle theme"
          />
        }
      >
        <SunIcon className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <MoonIcon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        <span className="sr-only">Toggle theme</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            data-slot="menu-content"
            className="min-w-36 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-sm"
          >
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = option.value === theme;
              return (
                <Menu.Item
                  key={option.value}
                  data-slot="menu-item"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  onClick={() => setTheme(option.value)}
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{option.label}</span>
                  {selected ? (
                    <CheckIcon className="absolute right-2 size-3.5" aria-hidden="true" />
                  ) : null}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
