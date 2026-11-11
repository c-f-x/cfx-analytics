import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  type SearchSchemaInput,
  stripSearchParams,
} from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import { ProductShell } from "@/components/shell.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { BoardScreen } from "@/features/board/board.tsx";
import { EditorScreen } from "@/features/editor/editor.tsx";
import { EventsScreen } from "@/features/events/events.tsx";
import { PageScreen } from "@/features/pages/page.tsx";
import { PagesScreen } from "@/features/pages/pages.tsx";
import { ProjectsScreen } from "@/features/projects/projects.tsx";
import { PlayerScreen } from "@/features/recordings/player.tsx";
import { RecordingsScreen } from "@/features/recordings/recordings.tsx";
import { SettingsScreen } from "@/features/settings/settings.tsx";
import { SignInScreen } from "@/features/sign-in/sign-in.tsx";
import { type BoardSearch, type BoardState, boardFrom, DEFAULT_BOARD } from "@/lib/board.ts";
import { useProjects, useStatus } from "@/lib/queries.ts";

// Every screen, by address. The page holds no data: each screen asks the API,
// which checks the session on every call (D-27).

function Root() {
  const status = useStatus();
  if (status.isPending) return <SkeletonRows rows={3} className="mx-auto max-w-md pt-24" />;
  if (status.isError)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data.signedIn) return <SignInScreen ready={status.data.signInReady} />;
  return <Outlet />;
}

/** The first product's board, or All products when there is none. */
function Home() {
  const projects = useProjects();
  if (projects.isPending) return <SkeletonRows rows={3} className="mx-auto max-w-md pt-24" />;
  if (projects.isError)
    return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  const [first] = projects.data;
  if (first === undefined) return <Navigate to="/projects" />;
  return <Navigate to="/p/$projectId" params={{ projectId: first.id }} />;
}

function NotFound() {
  return (
    <EmptyState icon={BarChart3} title="Nothing here" className="pt-24">
      This address names no screen of the dashboard.
    </EmptyState>
  );
}

/**
 * Every board-like screen reads the board's state from the address; a link
 * may leave any of it out, and a value equal to the default is left out of
 * the address, so a plain board has a plain address.
 */
const boardSearch = {
  validateSearch: (search: BoardSearch & SearchSchemaInput) => boardFrom(search),
  search: { middlewares: [stripSearchParams<BoardState>(DEFAULT_BOARD)] },
};

/** The recordings list's filters, each left out when empty. */
interface RecordingsSearch {
  person?: string;
  page?: string;
  event?: string;
  minDuration?: string;
}

function recordingsSearch(search: Record<string, unknown> & SearchSchemaInput): RecordingsSearch {
  const found: RecordingsSearch = {};
  for (const key of ["person", "page", "event", "minDuration"] as const) {
    const value = search[key];
    if (typeof value === "string" && value !== "") found[key] = value;
  }
  return found;
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  validateSearch: (search: Record<string, unknown>): { create?: boolean } =>
    search.create === true || search.create === "true" ? { create: true } : {},
  component: ProjectsScreen,
});
const productRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  component: ProductShell,
});
export const boardRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/",
  ...boardSearch,
  component: BoardScreen,
});
export const newQuestionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/questions/new",
  ...boardSearch,
  component: EditorScreen,
});
export const questionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/questions/$tileId",
  ...boardSearch,
  component: EditorScreen,
});
export const pagesRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/pages",
  ...boardSearch,
  component: PagesScreen,
});
export const pageRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/pages/$page",
  ...boardSearch,
  component: PageScreen,
});
export const recordingsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/recordings",
  validateSearch: recordingsSearch,
  component: RecordingsScreen,
});
export const playerRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/recordings/$sessionId",
  component: PlayerScreen,
});
export const eventsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/events",
  ...boardSearch,
  component: EventsScreen,
});
export const settingsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/settings",
  component: SettingsScreen,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  projectsRoute,
  productRoute.addChildren([
    boardRoute,
    newQuestionRoute,
    questionRoute,
    pagesRoute,
    pageRoute,
    recordingsRoute,
    playerRoute,
    eventsRoute,
    settingsRoute,
  ]),
]);

/** A screen that threw while drawing: what broke, and a way to draw it again. */
function ScreenFailed({ error, reset }: { error: unknown; reset: () => void }) {
  return <ErrorState error={error} onRetry={reset} className="pt-24" />;
}

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultErrorComponent: ScreenFailed,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
