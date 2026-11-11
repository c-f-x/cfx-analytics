import type {
  Answer,
  ProjectInfo,
  ProjectSettings,
  QuerySpec,
  Tile,
  TileSpec,
} from "@cfanalytics/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiDone } from "./api.ts";

// Every read and write the dashboard makes, as TanStack Query hooks. Keys name
// the project, so one product's answers never stand in for another's.

export interface Status {
  signInReady: boolean;
  signedIn: boolean;
  email: string | null;
}

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: () => api<Status>("/auth/status"), staleTime: 60_000 });

export const useProjects = () =>
  useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api<{ projects: ProjectInfo[] }>("/api/projects")).projects,
  });

export const useProject = (projectId: string) =>
  useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<ProjectInfo>(`/api/projects/${projectId}`),
  });

export const useTiles = (projectId: string) =>
  useQuery({
    queryKey: ["tiles", projectId],
    queryFn: async () => (await api<{ tiles: Tile[] }>(`/api/projects/${projectId}/tiles`)).tiles,
  });

/**
 * One query's answer. The last answer stays on screen while a new period or
 * filter loads, but only for the same product and the same kind: another
 * kind's answer has another shape, and another product's is not this one's.
 */
export function useAnswer<T>(projectId: string, spec: QuerySpec | null) {
  return useQuery({
    queryKey: ["answer", projectId, spec],
    queryFn: () =>
      api<Answer<T>>(`/api/projects/${projectId}/query`, { method: "POST", body: spec }),
    enabled: spec !== null,
    placeholderData: (previous, previousQuery) => {
      const [, project, before] = previousQuery?.queryKey ?? [];
      const sameKind =
        typeof before === "object" &&
        before !== null &&
        "kind" in before &&
        before.kind === spec?.kind;
      return project === projectId && sameKind ? previous : undefined;
    },
    staleTime: 30_000,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return (key: unknown[]) => client.invalidateQueries({ queryKey: key });
}

export function useAddTile(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (tile: { title: string; spec: TileSpec }) =>
      api<{ tile: Tile }>(`/api/projects/${projectId}/tiles`, { method: "POST", body: tile }),
    onSuccess: () => invalidate(["tiles", projectId]),
  });
}

export function useUpdateTile(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...change
    }: {
      id: string;
      title?: string;
      position?: number;
      spec?: TileSpec;
    }) =>
      api<{ tile: Tile }>(`/api/projects/${projectId}/tiles/${id}`, {
        method: "PATCH",
        body: change,
      }),
    onSuccess: () => invalidate(["tiles", projectId]),
  });
}

export function useRemoveTile(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      apiDone(`/api/projects/${projectId}/tiles/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(["tiles", projectId]),
  });
}

export function useRestoreTiles(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () =>
      api<{ tiles: Tile[] }>(`/api/projects/${projectId}/tiles/restore`, { method: "POST" }),
    onSuccess: () => invalidate(["tiles", projectId]),
  });
}

export function useCreateProject() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { name: string; settings?: Partial<ProjectSettings> }) =>
      api<ProjectInfo>("/api/projects", { method: "POST", body }),
    onSuccess: () => invalidate(["projects"]),
  });
}

export function useUpdateSettings(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (settings: Partial<ProjectSettings>) =>
      api<ProjectInfo>(`/api/projects/${projectId}`, { method: "PATCH", body: settings }),
    onSuccess: () => {
      void invalidate(["project", projectId]);
      void invalidate(["projects"]);
    },
  });
}
