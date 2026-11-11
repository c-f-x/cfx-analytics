import { BarChart3 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

// The way in (D-27): the owner's own Cloudflare account. A greeting surface, so it
// leans on type and space rather than chrome.

export function SignInScreen({ ready }: { ready: boolean }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-6 py-16">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BarChart3 className="size-5" />
          </span>
          <span className="font-semibold text-lg tracking-tight">cfanalytics</span>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="font-semibold text-3xl leading-tight tracking-tight">
            How your products are doing, and why.
          </h1>
          <p className="text-muted-foreground text-sm">
            Sign in with the Cloudflare account that runs them.
          </p>
        </div>
        {ready ? (
          <a
            href="/auth/sign-in"
            className={cn(buttonVariants({ variant: "primary", size: "lg" }), "w-full")}
          >
            Sign in with Cloudflare
          </a>
        ) : (
          <div className="rounded-lg border bg-card p-4 text-[13px]">
            <p className="font-semibold">Sign-in is not set up yet</p>
            <p className="mt-1 text-muted-foreground">
              This deployment has no Cloudflare OAuth client. Its secrets{" "}
              <code className="font-mono text-xs">CLOUDFLARE_CLIENT_ID</code> and{" "}
              <code className="font-mono text-xs">CLOUDFLARE_CLIENT_SECRET</code> are set with{" "}
              <code className="font-mono text-xs">wrangler secret put</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
