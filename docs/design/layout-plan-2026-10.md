# Layout plan, October 2026

Status: agreed with the owner on 2026-10-21 (D-24). Nothing here is built yet. A static mockup of the board is in `prototype/board.html`, with a screenshot in `prototype/board.png`. It follows a UX review of 2026-10-21 and takes its parts from cfmail.

## 1. The recommendation

Each product opens on its **board**: a page of tiles that starts with the standard numbers, and that the owner grows by saving their own questions. All navigation lives in one left rail, as in cfmail: the product switcher at the top, then Board, Pages, Recordings and Events, and Settings at the foot. The period and the filters sit at the top of every page and apply to everything on it. A funnel or a retention table is a question saved to the board, so neither needs a page of its own.

## 2. The board

```
+-------------------+-----------------------------------------------------------------+
| [S] example.com  v| Board      [Last 7 days v] [Compare] [Filter]  [+ Add question] |
|-------------------+-----------------------------------------------------------------+
| > Board           | Bots and your own traffic are left out.  Include                |
|   Pages           +-----------------------------------------------------------------+
|   Recordings      | Visitors            Page views            Sessions              |
|   Events          | 1,204  +12%         3,880  +4%            1,610  +9%            |
|                   | [ chart: visitors per day, this period and the one before ]     |
|                   +--------------------------------+--------------------------------+
|                   | Pages               Visitors   | Sources     [Channels | Sites] |
|                   | /                       812    | Search                  402    |
|                   | /pricing                233    | Direct                  380    |
|                   | /demo                   190    | Social                  121    |
|                   +--------------------------------+--------------------------------+
|                   | Countries                      | Devices [Type|Browser|System]  |
|                   +--------------------------------+--------------------------------+
|                   | Demo to waitlist  (saved funnel)                          [...] |
|                   | Page view 1,204  >  Demo 388 (32%)  >  Waitlist 61 (16%)        |
|   Settings        +-----------------------------------------------------------------+
+-------------------+-----------------------------------------------------------------+
```

- **Primary action:** "Add question". It opens the question editor.
- **Standard tiles,** made when a product is created: visitors, page views and sessions with their change on the period before, over a chart, Pages, Sources, Countries and Devices. Each can be removed from its menu; "Restore standard tiles" in the board's menu brings them back.
- **A row is a filter.** Clicking a page, a source or a country narrows the whole board to it, and the filter shows as a chip under the header. "Open page" on a page row goes to that page in Pages.
- **A saved tile's menu:** Open, Rename, Move, Remove.
- **States.** A product with no events yet shows one panel instead of the tiles: "No events yet", the snippet to install with its public token, and a link to the setup guide. While loading, each tile keeps its size and shows a skeleton. A tile that fails says "This tile could not load" with "Try again", and the others carry on.

## 3. The question editor

```
| <- Board   New question                                   [Cancel] [Save to board] |
| [Trend] [Ranked list] [Funnel] [Retention]                                         |
| Steps: 1 [$pageview v]  2 [preview_started v]  3 [waitlist_submitted v]  [+ Step]   |
| Within [1 day v]     Split by [none v]                                             |
| [ live answer, as it will look on the board ]                                      |
```

- **Primary action:** "Save to board". The kinds are tabs, since one question has one kind.
- Event and property names come from what the product has sent (the `properties` query), so nothing is typed blind.
- Saved questions keep the board's period and filters; a question may pin its own period.

## 4. The other places

- **Pages.** Pages ranked by visitors, with their views. A page opens on three tabs: Heatmap (Clicks, Rage clicks, Dead clicks; a screen-width choice), Scroll depth and Recordings of that page. No primary button: the list is the content.
- **Recordings.** A table of sessions, newest first: when, length, active time, person, first page, clicks. Filters by person, page, length and an event in the session. A row opens the player, with the session's events beside it; typed text shows as asterisks.
- **Events.** The latest events, newest first, each opening to its properties. A second tab, Properties, lists every property name the product has sent, with its type and how often it occurs.
- **Settings,** in sections on one page: General (name, time zone, the install snippet), What is collected (recordings with sample rate and shortest length, heatmaps, autocapture, dead clicks), How long it is kept, Daily limits, Your own traffic (the internal rules), Keys (with "New key" and "Revoke"), Privacy ("Erase a person", "Export data"), and Delete product. Each section saves on its own; erasing, revoking and deleting ask first, in a dialog that names what goes.
- **All products,** from the switcher: each product with its visitors over the last 7 days. "New product" is its primary action.

## 5. Look and parts

- **From cfmail** (MIT, copyright Julian Haag; its notice goes into `THIRD_PARTY_NOTICES.md` with the first file taken): Inter Variable, the near-neutral oklch scale for light and dark, the 6 px radius, and the Base UI kit in `apps/web/src/components/ui/` (button, icon button, tabs, dropdown menu, select, dialog, alert dialog, field, input, switch, badge, skeleton, empty, tooltip, sheet, toaster). The rail follows cfmail's `rail.tsx`.
- **Stack, as cfmail's:** React 19, TanStack Router and Query, Tailwind 4, lucide icons.
- **Accent:** cfmail's teal (hue 204), which passes WCAG AA both ways, so the two apps look like one family (the owner, 2026-10-21). It marks the primary action, the current period's line and the chosen number, and nothing else.
- **Charts:** not in cfmail. They follow the dataviz skill's method: neutral grey for the previous period, the accent for this one, and no colour that only decoration uses.
- **Phone:** the rail becomes a drawer, and tiles stack in one column.

## 6. What the plan needs from the Worker

Each is a spec line and its tests before code, as every Worker change is.

1. **Saved tiles.** A D1 table `board_tiles` (project, position, title, spec), each spec checked by `querySpec`, at most 40 a product. It is made with the standard tiles when a product is created, and the purge removes it in the batch that removes the project's rows. Routes under `/api/projects/:id/tiles`.
2. **Traffic channels.** A built-in `channel` dimension from one pure classifier of the referring host and the UTM tags (InsightFlare's channel rules).
3. **A funnel split into groups.** An optional `breakdown` on the funnel spec.
4. **Recording filters.** Person, page, shortest length and an event in the session, on the recording list.
5. **A recording's pages.** Pages lists the recordings of one page, so a recording keeps the paths it visited.

Left for later: a people view and a revenue sum (when payments start).
