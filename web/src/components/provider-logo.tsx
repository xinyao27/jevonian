import { PROVIDER_IMAGES, PROVIDER_LOGOS } from "@/lib/logos";
import { cn } from "@/lib/utils";

function initials(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProviderLogo({ id, className }: { id: string; className?: string }) {
  const svg = PROVIDER_LOGOS[id];
  if (svg) {
    return (
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center [&_svg]:size-full",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  const image = PROVIDER_IMAGES[id];
  if (image) {
    return (
      <span className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}>
        <img src={image} alt="" className="size-full object-contain" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-sm border bg-muted text-[9px] font-semibold text-muted-foreground",
        className,
      )}
    >
      {initials(id)}
    </span>
  );
}
