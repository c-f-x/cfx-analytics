import type { ProjectInfo, TrendResult } from "@cfanalytics/shared";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BarChart3, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Snippet } from "@/features/board/install.tsx";
import { DEFAULT_BOARD, querySpecOf } from "@/lib/board.ts";
import { cn } from "@/lib/cn.ts";
import { change, count, moment } from "@/lib/format.ts";
import { useAnswer, useCreateProject, useProjects } from "@/lib/queries.ts";

// All products: each with its visitors over the last seven days, and a way to
// add one. A new product's dialog shows its token and snippet straight away.

const VISITORS = { kind: "trend", measure: "visitors", granularity: "day", compare: true } as const;

function Visitors({ projectId }: { projectId: string }) {
  const answer = useAnswer<TrendResult>(projectId, querySpecOf(VISITORS, DEFAULT_BOARD));
  const series = answer.data?.result.series[0];
  if (answer.isError) return <span className="text-muted-foreground text-[13px]">Unavailable</span>;
  if (series === undefined) return <span className="h-5 w-12 animate-pulse rounded bg-muted" />;
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-semibold text-base tabular-nums">{count(series.total)}</span>
      {series.change === undefined || series.total === 0 ? null : (
        <span
          className={cn(
            "font-medium text-xs tabular-nums",
            series.change === null || series.change >= 0 ? "text-success" : "text-destructive",
          )}
        >
          {change(series.change)}
        </span>
      )}
    </span>
  );
}

function ProductRow({ project }: { project: ProjectInfo }) {
  return (
    <li>
      <Link
        to="/p/$projectId"
        params={{ projectId: project.id }}
        className="grid grid-cols-[1fr_160px_140px] items-center gap-4 px-5 py-4 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-inset max-sm:grid-cols-[1fr_auto]"
      >
        <span className="flex flex-col">
          <span className="font-medium text-sm">{project.name}</span>
          <span className="font-mono text-muted-foreground text-xs">{project.token}</span>
        </span>
        <Visitors projectId={project.id} />
        <span className="text-muted-foreground text-[13px] max-sm:hidden">
          Added {moment(project.createdAt)}
        </span>
      </Link>
    </li>
  );
}

function NewProduct({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<ProjectInfo | null>(null);
  const create = useCreateProject();
  const navigate = useNavigate();
  const close = (next: boolean) => {
    if (next) return;
    onOpenChange(false);
    setName("");
    setMade(null);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        {made === null ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                { name: name.trim() },
                {
                  onSuccess: setMade,
                  onError: (error) => toast.error(error.message),
                },
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>New product</DialogTitle>
              <DialogDescription>
                A product is one site or app. Its data is kept apart from every other product's.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-name">Name</Label>
              <Input
                id="product-name"
                autoFocus
                maxLength={100}
                placeholder="My website"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={name.trim() === "" || create.isPending}
              >
                Add product
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{made.name} is ready</DialogTitle>
              <DialogDescription>
                Add this snippet to the site. Events show on the board as they arrive.
              </DialogDescription>
            </DialogHeader>
            <Snippet token={made.token} />
            <DialogFooter>
              <Button
                variant="primary"
                onClick={() => {
                  close(false);
                  void navigate({ to: "/p/$projectId", params: { projectId: made.id } });
                }}
              >
                Open the board
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsScreen() {
  const projects = useProjects();
  const search = useSearch({ from: "/projects" });
  const navigate = useNavigate({ from: "/projects" });
  const open = search.create === true;
  const setOpen = (next: boolean) => void navigate({ search: next ? { create: true } : {} });
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="All products">
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus />
          New product
        </Button>
      </PageHeader>
      <PageBody>
        {projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : projects.data === undefined ? (
          <SkeletonRows rows={4} />
        ) : projects.data.length === 0 ? (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="No products yet"
              action={
                <button
                  type="button"
                  className={buttonVariants({ variant: "primary" })}
                  onClick={() => setOpen(true)}
                >
                  <Plus />
                  New product
                </button>
              }
            >
              Add the first site or app, and paste its snippet into the page.
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <div className="grid grid-cols-[1fr_160px_140px] gap-4 border-b px-5 py-2 font-medium text-muted-foreground text-xs max-sm:grid-cols-[1fr_auto]">
              <span>Product</span>
              <span>Visitors, last 7 days</span>
              <span className="max-sm:hidden" />
            </div>
            <ul className="divide-y">
              {projects.data.map((project) => (
                <ProductRow key={project.id} project={project} />
              ))}
            </ul>
          </Card>
        )}
      </PageBody>
      <NewProduct open={open} onOpenChange={setOpen} />
    </div>
  );
}
