import "@fontsource-variable/inter";
import "./styles.css";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/toaster.tsx";
import { isSignedOut } from "@/lib/api.ts";
import type { Status } from "@/lib/queries.ts";
import { initTheme } from "@/lib/theme.ts";
import { router } from "./router.tsx";

initTheme();

/**
 * A 401 from any call means the session ended while a screen was open: the
 * cached status says so, and the root shows the sign-in page (dashboard-05).
 */
function signedOutOn(error: unknown): void {
  if (!isSignedOut(error)) return;
  queryClient.setQueryData<Status>(["status"], (status) =>
    status === undefined ? status : { ...status, signedIn: false, email: null },
  );
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signedOutOn }),
  mutationCache: new MutationCache({ onError: signedOutOn }),
  defaultOptions: {
    queries: {
      // A 401 means the session ended: asking again cannot help.
      retry: (failures, error) => !isSignedOut(error) && failures < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
