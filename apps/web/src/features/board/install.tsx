import { POSTHOG_JS_VERSION, type ProjectInfo } from "@cfanalytics/shared";
import { Link } from "@tanstack/react-router";
import { Copy, Radio } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/page.tsx";
import { Button } from "@/components/ui/button.tsx";

// How a product starts sending: install the posthog-js version the Worker
// serves (D-15), then start it with the product's token and this
// deployment's address (dashboard-12, D-35). The board shows it until the
// first event, and Settings and a new product's dialog show it too.

function CodeBlock({ label, code, copied }: { label: string; code: string; copied: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/50">
      <div className="flex items-center justify-between border-b px-4 py-1.5">
        <span className="text-muted-foreground text-xs">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(
              () => toast(copied),
              () => toast.error("The browser refused to copy. Select the text and copy it."),
            );
          }}
        >
          <Copy />
          Copy
        </Button>
      </div>
      <pre className="whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-5">
        {code}
      </pre>
    </div>
  );
}

/** The install line and the snippet for `token`, each with a copy button. */
export function Snippet({ token }: { token: string }) {
  const snippet = `posthog.init("${token}", {
  api_host: "${window.location.origin}",
  person_profiles: "identified_only",
});`;
  return (
    <div className="flex flex-col gap-3">
      <CodeBlock
        label="1. Install posthog-js"
        code={`npm install --save-exact posthog-js@${POSTHOG_JS_VERSION}`}
        copied="Copied the install line"
      />
      <CodeBlock label="2. Start it on every page" code={snippet} copied="Copied the snippet" />
    </div>
  );
}

/** That a new product records events only, with the way to Settings. */
export function RecordingNote({ projectId }: { projectId: string }) {
  return (
    <p className="text-muted-foreground text-xs">
      Session recording and heatmaps are off.{" "}
      <Link
        to="/p/$projectId/settings"
        params={{ projectId }}
        className="text-foreground underline underline-offset-2"
      >
        Turn them on in Settings
      </Link>
      .
    </p>
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
              {project.name} has not sent anything. Install posthog-js on the site and start it with
              this snippet, and the board fills as events arrive.
            </p>
          </div>
        </div>
        <Snippet token={project.token} />
        <RecordingNote projectId={project.id} />
        <p className="text-muted-foreground text-xs">
          The token is public by design: it names the product, and the daily caps in Settings bound
          what it can send.
        </p>
      </div>
    </Card>
  );
}
