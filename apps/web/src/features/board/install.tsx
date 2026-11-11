import type { ProjectInfo } from "@cfanalytics/shared";
import { Copy, Radio } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/page.tsx";
import { Button } from "@/components/ui/button.tsx";

// How a product starts sending: the PostHog snippet with its own token and
// this deployment's address. The board shows it until the first event, and
// Settings and a new product's dialog show it too.

/** The snippet for `token`, with a copy button. */
export function Snippet({ token }: { token: string }) {
  const snippet = `posthog.init("${token}", {
  api_host: "${window.location.origin}",
  person_profiles: "identified_only",
});`;
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/50">
      <div className="flex items-center justify-between border-b px-4 py-1.5">
        <span className="text-muted-foreground text-xs">PostHog snippet</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(snippet).then(
              () => toast("Copied the snippet"),
              () => toast.error("The browser refused to copy. Select the snippet and copy it."),
            );
          }}
        >
          <Copy />
          Copy
        </Button>
      </div>
      <pre className="whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-5">
        {snippet}
      </pre>
    </div>
  );
}

export function InstallPanel({ project }: { project: ProjectInfo }) {
  return (
    <Card className="p-6">
      <div className="flex max-w-2xl flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Radio className="size-4" />
          </span>
          <div>
            <h2 className="font-semibold text-base">No events yet</h2>
            <p className="text-muted-foreground text-[13px]">
              {project.name} has not sent anything. Point a PostHog SDK at this address, and the
              board fills as events arrive.
            </p>
          </div>
        </div>
        <Snippet token={project.token} />
        <p className="text-muted-foreground text-xs">
          The token is public by design: it names the product, and the daily caps in Settings bound
          what it can send.
        </p>
      </div>
    </Card>
  );
}
