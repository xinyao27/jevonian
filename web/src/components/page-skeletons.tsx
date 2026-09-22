import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function PageHeaderSkeleton({ descriptionWidth = "w-96" }: { descriptionWidth?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-28" />
      <Skeleton className={cn("h-4 max-w-full", descriptionWidth)} />
    </div>
  );
}

export function StatCardsSkeleton({
  count = 4,
  columns = "grid-cols-2 lg:grid-cols-4",
}: {
  count?: number;
  columns?: string;
}) {
  return (
    <div className={cn("grid gap-4", columns)}>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function TableRowsSkeleton({ rows = 5, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3 border-b pb-2">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-3 py-2">
          {Array.from({ length: columns }, (_, col) => (
            <Skeleton
              key={col}
              className={cn("h-4 flex-1", col === 0 ? "max-w-[30%]" : undefined)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardBlockSkeleton({
  lines = 4,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={cn("h-4", index % 2 === 0 ? "w-full" : "w-[80%]")} />
        ))}
      </CardContent>
    </Card>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading overview">
      <PageHeaderSkeleton descriptionWidth="w-[28rem]" />
      <CardBlockSkeleton lines={5} />
      <StatCardsSkeleton count={4} />
      <CardBlockSkeleton lines={3} />
      <CardBlockSkeleton lines={2} />
    </div>
  );
}

export function ProvidersSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading providers">
      <PageHeaderSkeleton descriptionWidth="w-[32rem]" />
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-28" />
        </CardHeader>
        <CardContent>
          <TableRowsSkeleton rows={4} columns={6} />
        </CardContent>
      </Card>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-72 max-w-full" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function KeysSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading keys">
      <PageHeaderSkeleton descriptionWidth="w-full max-w-2xl" />
      <CardBlockSkeleton lines={3} />
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-56" />
        </CardHeader>
        <CardContent>
          <TableRowsSkeleton rows={4} columns={7} />
        </CardContent>
      </Card>
    </div>
  );
}

export function ClientsSkeleton() {
  return (
    <div
      className="mx-auto flex max-w-4xl flex-col gap-6"
      aria-busy="true"
      aria-label="Loading clients"
    >
      <div className="flex items-start justify-between gap-4">
        <PageHeaderSkeleton descriptionWidth="w-80" />
        <Skeleton className="h-8 w-24 shrink-0" />
      </div>
      <Skeleton className="h-10 w-full rounded-md" />
      <div className="flex flex-col gap-4">
        {Array.from({ length: 2 }, (_, index) => (
          <Card key={index}>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-6 rounded-md" />
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function RoutingSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading routing">
      <PageHeaderSkeleton descriptionWidth="w-[36rem]" />
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-80 max-w-full" />
          </div>
          <Skeleton className="h-8 w-28" />
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-3 rounded-lg border p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-[75%]" />
              <div className="flex flex-wrap gap-2 pt-1">
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading activity">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeaderSkeleton descriptionWidth="w-80" />
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <StatCardsSkeleton count={3} columns="grid-cols-1 sm:grid-cols-3" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CardBlockSkeleton lines={4} />
        <CardBlockSkeleton lines={4} />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-56" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-44 w-full rounded-md" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent>
          <TableRowsSkeleton rows={5} columns={6} />
        </CardContent>
      </Card>
    </div>
  );
}

export function LogsTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading requests">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-12 items-center gap-2 border-b border-border/40 px-4 py-2.5"
        >
          <Skeleton className="col-span-1 h-3 w-12" />
          <Skeleton className="col-span-3 h-3 w-full max-w-[90%]" />
          <Skeleton className="col-span-2 h-3 w-20" />
          <Skeleton className="col-span-1 h-3 w-12" />
          <Skeleton className="col-span-1 h-3 w-10" />
          <Skeleton className="col-span-1 h-3 w-10" />
          <Skeleton className="col-span-1 h-3 w-12" />
          <Skeleton className="col-span-1 h-3 w-10" />
          <Skeleton className="col-span-1 ml-auto h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

export function LogDetailSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-busy="true" aria-label="Loading log detail">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="ml-auto h-8 w-28" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-md border px-3 py-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-4 w-24" />
          </div>
        ))}
      </div>
      <CardBlockSkeleton lines={6} />
      <CardBlockSkeleton lines={8} />
    </div>
  );
}
