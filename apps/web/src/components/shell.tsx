import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronsUpDown,
  FileText,
  LayoutGrid,
  List,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PlayCircle,
  Plus,
  Settings,
  Sun,
} from "lucide-react";
import type * as React from "react";
import { EmptyState } from "@/components/states.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet.tsx";
import { HttpError } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { useProject, useProjects } from "@/lib/queries.ts";
import { useTheme } from "@/lib/theme.ts";

// The product's frame: one left rail, as in cfmail, with the product switcher,
// the places, and settings at the foot; the screen beside it.

const rowClass =
  "relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring/45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
const activeClass =
  "bg-primary/10 font-semibold text-foreground hover:bg-primary/10 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary [&_svg]:text-primary";

function RailLink({
  to,
  projectId,
  icon: Icon,
  exact = false,
  children,
}: {
  to: string;
  projectId: string;
  icon: React.ComponentType;
  exact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      params={{ projectId }}
      className={rowClass}
      activeProps={{ className: activeClass, "aria-current": "page" }}
      activeOptions={{ exact, includeSearch: false }}
    >
      <Icon />
      <span className="truncate">{children}</span>
    </Link>
  );
}

function ProductSwitcher({ projectId }: { projectId: string }) {
  const projects = useProjects();
  const navigate = useNavigate();
  const current = projects.data?.find((project) => project.id === projectId);
  const name = current?.name ?? "…";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-md p-2 text-left outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring/45"
        aria-label="Switch product"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground text-[13px]">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-sm">{name}</span>
          <span className="block truncate text-muted-foreground text-xs">
            {current?.settings.timezone ?? ""}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {(projects.data ?? []).map((project) => (
          <DropdownMenuItem
            key={project.id}
            onClick={() =>
              void navigate({ to: "/p/$projectId", params: { projectId: project.id } })
            }
          >
            <span className="truncate">{project.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate({ to: "/projects" })}>
          <LayoutGrid />
          All products
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void navigate({ to: "/projects", search: { create: true } })}
        >
          <Plus />
          New product
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeButton() {
  const { theme, setTheme } = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "system" ? "Theme: as the system" : `Theme: ${theme}`;
  return (
    <button
      type="button"
      className={cn(rowClass, "w-auto")}
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
    >
      <Icon />
    </button>
  );
}

async function signOut(): Promise<void> {
  await fetch("/auth/sign-out", { method: "POST", credentials: "same-origin" });
  window.location.assign("/");
}

export function ProductShell() {
  const { projectId } = useParams({ from: "/p/$projectId" });
  const project = useProject(projectId);
  if (project.isError && project.error instanceof HttpError && project.error.status === 404) {
    return (
      <EmptyState icon={BarChart3} title="No such product" className="pt-24">
        It may have been deleted.{" "}
        <Link to="/projects" className="font-medium text-primary hover:underline">
          See all products
        </Link>
      </EmptyState>
    );
  }
  return (
    <div className="grid h-full grid-cols-[232px_1fr] max-md:grid-cols-1 max-md:grid-rows-[auto_1fr]">
      <aside className="flex min-h-0 flex-col border-sidebar-border border-r bg-sidebar max-md:hidden">
        <Rail projectId={projectId} />
      </aside>
      <PhoneBar projectId={projectId} name={project.data?.name ?? ""} />
      <main className="min-h-0 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

/** The rail's contents: the product switcher, the places, and sign-out with the theme. */
function Rail({ projectId }: { projectId: string }) {
  return (
    <>
      <div className="border-sidebar-border border-b p-2">
        <ProductSwitcher projectId={projectId} />
      </div>
      <nav aria-label="Product" className="flex flex-1 flex-col gap-px p-2">
        <RailLink to="/p/$projectId" projectId={projectId} icon={LayoutGrid} exact>
          Board
        </RailLink>
        <RailLink to="/p/$projectId/pages" projectId={projectId} icon={FileText}>
          Pages
        </RailLink>
        <RailLink to="/p/$projectId/recordings" projectId={projectId} icon={PlayCircle}>
          Recordings
        </RailLink>
        <RailLink to="/p/$projectId/events" projectId={projectId} icon={List}>
          Events
        </RailLink>
        <div className="mt-auto">
          <RailLink to="/p/$projectId/settings" projectId={projectId} icon={Settings}>
            Settings
          </RailLink>
        </div>
      </nav>
      <div className="flex items-center gap-1 border-sidebar-border border-t p-2">
        <button type="button" className={cn(rowClass, "flex-1")} onClick={() => void signOut()}>
          <LogOut />
          Sign out
        </button>
        <ThemeButton />
      </div>
    </>
  );
}

/**
 * On a phone the rail is a drawer behind a menu button. The drawer is keyed
 * by the address, so moving to another place closes it.
 */
function PhoneBar({ projectId, name }: { projectId: string; name: string }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <div className="flex h-12 items-center gap-2 border-b px-2 md:hidden">
      <Sheet key={pathname}>
        <SheetTrigger
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label="Menu"
        >
          <Menu />
        </SheetTrigger>
        <SheetContent side="left">
          <div className="flex min-h-0 w-full flex-col">
            <Rail projectId={projectId} />
          </div>
        </SheetContent>
      </Sheet>
      <span className="truncate font-semibold text-sm">{name}</span>
    </div>
  );
}
