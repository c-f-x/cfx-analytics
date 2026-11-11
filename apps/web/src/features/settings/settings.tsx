import {
  type ErasedCounts,
  EXPORT_TABLES,
  type ExportPage,
  type ExportTable,
  type InternalRule,
  type KeyInfo,
  type ProjectInfo,
  type ProjectSettings,
} from "@cfanalytics/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Download, KeyRound, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Snippet } from "@/features/board/install.tsx";
import { api, apiDone } from "@/lib/api.ts";
import { oneOf } from "@/lib/choice.ts";
import { count, moment } from "@/lib/format.ts";
import { useProject, useUpdateSettings } from "@/lib/queries.ts";
import { RULE_VALUE_TYPES, type RuleValueType, ruleValueOf } from "@/lib/rules.ts";
import { timeZoneOptions } from "@/lib/zones.ts";

// A product's settings: what is collected, how long it is kept, the daily
// limits, the owner's own traffic, keys, privacy requests, and deleting the
// product. One "Save changes" saves every setting; the other actions act at once.

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="grid gap-6 p-5 md:grid-cols-[240px_1fr]">
      <div>
        <h2 className="font-semibold text-sm">{title}</h2>
        <p className="mt-1 text-muted-foreground text-[13px]">{description}</p>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </Card>
  );
}

function NumberField({
  id,
  label,
  value,
  unit,
  onChange,
  width = "w-28",
}: {
  id: string;
  label: string;
  value: number;
  unit: string;
  onChange: (value: number) => void;
  width?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={id} className="text-[13px] text-foreground">
        {label}
      </Label>
      <span className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          className={`${width} text-right tabular-nums`}
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="w-16 text-muted-foreground text-[13px]">{unit}</span>
      </span>
    </div>
  );
}

function SwitchField({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor={id} className="text-[13px] text-foreground">
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const BROWSER_ZONES = Intl.supportedValuesOf("timeZone");
const RULE_KINDS: readonly InternalRule["kind"][] = ["person_property", "event_property"];

export function SettingsScreen() {
  const { projectId } = useParams({ from: "/p/$projectId/settings" });
  const project = useProject(projectId);
  if (project.isError)
    return (
      <ErrorState error={project.error} onRetry={() => void project.refetch()} className="pt-24" />
    );
  if (project.data === undefined)
    return <SkeletonRows rows={8} className="mx-auto max-w-3xl pt-20" />;
  return <SettingsForm key={project.data.id} project={project.data} />;
}

function SettingsForm({ project }: { project: ProjectInfo }) {
  const [draft, setDraft] = useState<ProjectSettings>(project.settings);
  const save = useUpdateSettings(project.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.settings);
  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  return (
    <>
      <PageHeader title="Settings">
        <Button disabled={!dirty || save.isPending} onClick={() => setDraft(project.settings)}>
          Discard
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || save.isPending}
          onClick={() =>
            void save.mutateAsync(draft).then(
              () => toast("Settings saved"),
              (error: unknown) =>
                toast.error(
                  error instanceof Error ? error.message : "The settings could not be saved.",
                ),
            )
          }
        >
          Save changes
        </Button>
      </PageHeader>
      <PageBody>
        <Section
          title="General"
          description="The product's name, and the time zone that decides where each day starts in every number."
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px]">Name</span>
            <span className="font-medium text-[13px]">{project.name}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="timezone" className="text-[13px] text-foreground">
              Time zone
            </Label>
            <select
              id="timezone"
              className="h-8 w-64 rounded-md border bg-card px-2 text-[13px]"
              value={draft.timezone}
              onChange={(event) => set("timezone", event.target.value)}
            >
              {timeZoneOptions(project.settings.timezone, BROWSER_ZONES).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px]">Install</span>
            <Snippet token={project.token} />
          </div>
        </Section>
        <Section
          title="What is collected"
          description="Recordings and heatmaps need the visitor's consent on the site; these switches only decide whether this product accepts them."
        >
          <SwitchField
            id="recording"
            label="Session recording"
            hint="Typed text is always stored as asterisks."
            checked={draft.recording_enabled}
            onChange={(value) => set("recording_enabled", value)}
          />
          {draft.recording_enabled ? (
            <>
              <NumberField
                id="sample"
                label="Sessions recorded"
                unit="%"
                value={Math.round(draft.recording_sample_rate * 100)}
                onChange={(value) => set("recording_sample_rate", value / 100)}
              />
              <NumberField
                id="minimum"
                label="Shortest recording kept"
                unit="seconds"
                value={draft.recording_min_duration_ms / 1000}
                onChange={(value) => set("recording_min_duration_ms", Math.round(value * 1000))}
              />
            </>
          ) : null}
          <SwitchField
            id="heatmaps"
            label="Heatmaps"
            hint="Clicks, rage clicks and dead clicks per page and screen width."
            checked={draft.heatmaps_enabled}
            onChange={(value) => set("heatmaps_enabled", value)}
          />
          <SwitchField
            id="autocapture"
            label="Autocapture"
            hint="Clicks and form changes, without code on the site."
            checked={draft.autocapture_enabled}
            onChange={(value) => set("autocapture_enabled", value)}
          />
          <SwitchField
            id="deadclicks"
            label="Dead clicks"
            hint="Clicks that changed nothing on the page."
            checked={draft.dead_clicks_enabled}
            onChange={(value) => set("dead_clicks_enabled", value)}
          />
        </Section>
        <Section
          title="How long it is kept"
          description="Older data is deleted every night. Lowering a number deletes the newly expired data at the next sweep."
        >
          <NumberField
            id="events-days"
            label="Events"
            unit="days"
            value={draft.events_retention_days}
            onChange={(value) => set("events_retention_days", value)}
          />
          <NumberField
            id="recordings-days"
            label="Recordings"
            unit="days"
            value={draft.recordings_retention_days}
            onChange={(value) => set("recordings_retention_days", value)}
          />
          <NumberField
            id="heatmaps-days"
            label="Heatmap points"
            unit="days"
            value={draft.heatmaps_retention_days}
            onChange={(value) => set("heatmaps_retention_days", value)}
          />
        </Section>
        <Section
          title="Daily limits"
          description="What the product may store in a day. Past the limit, the SDKs are told to pause until midnight in the product's time zone."
        >
          <NumberField
            id="event-cap"
            label="Events"
            unit="a day"
            width="w-32"
            value={draft.daily_event_cap}
            onChange={(value) => set("daily_event_cap", value)}
          />
          <NumberField
            id="byte-cap"
            label="Recordings"
            unit="MB a day"
            width="w-32"
            value={Math.round(draft.daily_recording_bytes_cap / 1_000_000)}
            onChange={(value) => set("daily_recording_bytes_cap", value * 1_000_000)}
          />
        </Section>
        <Section
          title="Your own traffic"
          description="Events matching a rule are left out of every number unless a screen asks to include them."
        >
          <Rules rules={draft.internal_rules} onChange={(rules) => set("internal_rules", rules)} />
        </Section>
        <Keys projectId={project.id} />
        <Privacy projectId={project.id} />
        <DeleteProduct project={project} />
      </PageBody>
    </>
  );
}

function Rules({
  rules,
  onChange,
}: {
  rules: InternalRule[];
  onChange: (rules: InternalRule[]) => void;
}) {
  const [property, setProperty] = useState("");
  const [valueType, setValueType] = useState<RuleValueType>("yes/no");
  const [value, setValue] = useState("true");
  const [kind, setKind] = useState<InternalRule["kind"]>("person_property");
  const parsed = ruleValueOf(valueType, value);
  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No rules yet.</p>
      ) : null}
      {rules.map((rule, index) => (
        <div
          key={`${rule.property}=${String(rule.value)}`}
          className="flex items-center gap-2 text-[13px]"
        >
          <span className="text-muted-foreground">
            {rule.kind === "person_property" ? "Person's" : "Event's"}
          </span>
          <code className="font-mono text-[12px]">{rule.property}</code>
          <span className="text-muted-foreground">is</span>
          {/* JSON shows the type: "42" is text, 42 a number, true a yes. */}
          <code className="font-mono text-[12px]">{JSON.stringify(rule.value)}</code>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            aria-label="Remove this rule"
            onClick={() => onChange(rules.filter((_rule, at) => at !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Whose property"
          className="h-8 rounded-md border bg-card px-2 text-[13px]"
          value={kind}
          onChange={(event) => {
            const picked = oneOf(RULE_KINDS, event.target.value);
            if (picked !== undefined) setKind(picked);
          }}
        >
          <option value="person_property">Person's</option>
          <option value="event_property">Event's</option>
        </select>
        <Input
          aria-label="Property"
          placeholder="is_internal"
          className="w-36"
          value={property}
          onChange={(event) => setProperty(event.target.value)}
        />
        <span className="text-muted-foreground text-[13px]">is</span>
        <select
          aria-label="Value type"
          className="h-8 rounded-md border bg-card px-2 text-[13px]"
          value={valueType}
          onChange={(event) => {
            const picked = oneOf(RULE_VALUE_TYPES, event.target.value);
            if (picked === undefined) return;
            setValueType(picked);
            setValue(picked === "yes/no" ? "true" : "");
          }}
        >
          {RULE_VALUE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        {valueType === "yes/no" ? (
          <select
            aria-label="Value"
            className="h-8 rounded-md border bg-card px-2 text-[13px]"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="true">yes (true)</option>
            <option value="false">no (false)</option>
          </select>
        ) : (
          <Input
            aria-label="Value"
            inputMode={valueType === "number" ? "decimal" : "text"}
            placeholder={valueType === "number" ? "42" : "localhost"}
            className="w-28"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <Button
          size="sm"
          disabled={property.trim() === "" || parsed === null}
          onClick={() => {
            if (parsed === null) return;
            onChange([...rules, { kind, property: property.trim(), value: parsed }]);
            setProperty("");
            setValue(valueType === "yes/no" ? "true" : "");
          }}
        >
          <Plus />
          Add rule
        </Button>
      </div>
    </div>
  );
}

const failed = (error: unknown) =>
  toast.error(error instanceof Error ? error.message : "The key could not be changed.");

function Keys({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const keys = useQuery({
    queryKey: ["keys", projectId],
    queryFn: async () => (await api<{ keys: KeyInfo[] }>(`/api/projects/${projectId}/keys`)).keys,
  });
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<KeyInfo | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ["keys", projectId] });
  return (
    <Section
      title="Keys"
      description="A secret key lets one of your own systems read this product's numbers through the query API. It is shown once."
    >
      {keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data === undefined ? (
        <SkeletonRows rows={2} className="p-0" />
      ) : keys.data.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No keys.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {keys.data.map((key) => (
            <li key={key.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <KeyRound className="size-4 text-muted-foreground" />
              <span className="font-medium">{key.label}</span>
              <span className="text-muted-foreground text-xs">
                made {moment(key.createdAt)}
                {key.lastUsedDay === null ? ", never used" : `, last used ${key.lastUsedDay}`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setRevoking(key)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void api<{ key: string }>(`/api/projects/${projectId}/keys`, {
            method: "POST",
            body: { label: label.trim() },
          }).then((made) => {
            setShown(made.key);
            setLabel("");
            refresh();
          }, failed);
        }}
      >
        <Input
          aria-label="Key label"
          placeholder="Owner panel"
          className="w-56"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" disabled={label.trim() === ""}>
          <Plus />
          New key
        </Button>
      </form>
      <Dialog open={shown !== null} onOpenChange={(open) => (open ? null : setShown(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy the key now</DialogTitle>
            <DialogDescription>
              It is shown this once. Only its fingerprint is stored.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded bg-muted p-3 font-mono text-[12px]">
            {shown}
          </code>
          <DialogFooter>
            <Button
              variant="primary"
              onClick={() => {
                // The key is shown once, so the dialog stays open until it is copied.
                void navigator.clipboard.writeText(shown ?? "").then(
                  () => {
                    setShown(null);
                    toast("Copied the key");
                  },
                  () => toast.error("The browser refused to copy. Select the key and copy it."),
                );
              }}
            >
              Copy and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={revoking !== null} onOpenChange={(open) => (open ? null : setRevoking(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.label}?</DialogTitle>
            <DialogDescription>
              Any system that reads with this key is refused from now on. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const key = revoking;
                if (key === null) return;
                void apiDone(`/api/projects/${projectId}/keys/${key.id}`, {
                  method: "DELETE",
                }).then(() => {
                  setRevoking(null);
                  refresh();
                }, failed);
              }}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

async function exportTable(projectId: string, table: ExportTable): Promise<void> {
  const lines: string[] = [];
  let after = 0;
  for (;;) {
    const page = await api<ExportPage>(
      `/api/projects/${projectId}/export/${table}?after=${String(after)}`,
    );
    lines.push(...page.lines);
    if (page.next === null) break;
    after = page.next;
  }
  const url = URL.createObjectURL(
    new Blob([lines.map((line) => `${line}\n`).join("")], { type: "application/x-ndjson" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${table}.ndjson`;
  link.click();
  URL.revokeObjectURL(url);
}

function Privacy({ projectId }: { projectId: string }) {
  const [distinctId, setDistinctId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [table, setTable] = useState<ExportTable>("events");
  return (
    <Section
      title="Privacy"
      description="Answer a person's request: erase everything stored about them, or hand over a table of the product's data."
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="Person's id"
          placeholder="The person's id"
          className="w-64"
          value={distinctId}
          onChange={(event) => setDistinctId(event.target.value)}
        />
        <Button disabled={distinctId.trim() === ""} onClick={() => setConfirming(true)}>
          Erase a person
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <select
          aria-label="Table"
          className="h-8 w-64 rounded-md border bg-card px-2 text-[13px]"
          value={table}
          onChange={(event) => {
            const picked = oneOf(EXPORT_TABLES, event.target.value);
            if (picked !== undefined) setTable(picked);
          }}
        >
          {EXPORT_TABLES.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
        <Button
          onClick={() =>
            void exportTable(projectId, table).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : "The export failed."),
            )
          }
        >
          <Download />
          Export data
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Erase {distinctId.trim()}?</DialogTitle>
            <DialogDescription>
              Their events, profile, ids, recordings and heatmap points are deleted. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() =>
                void api<{ counts: ErasedCounts }>(`/api/projects/${projectId}/persons/erase`, {
                  method: "POST",
                  body: { distinctId: distinctId.trim() },
                }).then(
                  (answer) => {
                    setConfirming(false);
                    setDistinctId("");
                    toast(
                      `Erased: ${count(answer.counts.events)} events, ${count(answer.counts.recordings)} recordings`,
                    );
                  },
                  (error: unknown) =>
                    toast.error(error instanceof Error ? error.message : "The erase failed."),
                )
              }
            >
              Erase
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function DeleteProduct({ project }: { project: ProjectInfo }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const navigate = useNavigate();
  const client = useQueryClient();

  /**
   * Marks the product deleted, then asks for its purge. Once the mark holds,
   * the product leaves every cached list before the page changes, so nothing
   * asks for its numbers again. A failed purge request only delays the purge
   * to the store's next nightly pass (privacy-20), and the toast says so.
   */
  const deleteProduct = async () => {
    try {
      await apiDone(`/api/projects/${project.id}`, { method: "DELETE", body: { confirm: typed } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The product could not be deleted.");
      return;
    }
    client.setQueryData<ProjectInfo[]>(["projects"], (list) =>
      list?.filter((each) => each.id !== project.id),
    );
    client.removeQueries({ predicate: (query) => query.queryKey.includes(project.id) });
    const purged = await apiDone(`/api/projects/${project.id}/purge`, { method: "POST" }).then(
      () => true,
      () => false,
    );
    toast(
      purged
        ? `${project.name} is deleted`
        : `${project.name} is deleted; its data goes at the store's next nightly pass`,
    );
    void navigate({ to: "/projects" });
  };
  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <div>
        <h2 className="font-semibold text-sm">Delete this product</h2>
        <p className="mt-1 text-muted-foreground text-[13px]">
          Its token stops working at once, and every piece of its data is deleted a minute later.
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label="More"
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
            <Trash2 />
            Delete product
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>
              Type its name to confirm. Nothing restores the recordings once they are gone.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="The product's name"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={typed !== project.name}
              onClick={() => void deleteProduct()}
            >
              Delete product
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
