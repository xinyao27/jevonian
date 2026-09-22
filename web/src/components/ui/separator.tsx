import { Separator as BaseSeparator } from "@base-ui-components/react/separator";
import * as React from "react";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof BaseSeparator> & {
  /** Decorative separators are hidden from assistive tech, like Radix's `decorative`. */
  decorative?: boolean;
}) {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      // Base UI always emits `role="separator"`; `none` restores decorative semantics.
      {...(decorative ? { role: "none" as const } : {})}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
