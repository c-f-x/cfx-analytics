# Design

Where the dashboard's look comes from. Rules the owner has not set are not written here.

## Source of truth

- The owner's design taste applies to every screen:
  - neutrals plus one accent that marks the primary action
  - a fixed type scale with at most two families
  - one spacing scale
  - designed empty, loading and error states
  - visible keyboard focus
  - text that meets WCAG AA in light and dark mode
- The dashboard is a working surface, so it uses familiar app patterns: navigation, tables, filters and charts that are easy to scan.
- Charts follow the dataviz skill's method for colour and marks.

## Visual reference

The layout is `docs/design/layout-plan-2026-10.md`, agreed with the owner on 2026-10-21 (D-24), with a static mockup of the board in `docs/design/prototype/board.html`. The look takes cfmail's tokens and components, with its teal as the one accent. The tokens (colours, type scale, spacing, radii) are defined once, in `apps/web/src/styles.css`, and the components built on them are in `apps/web/src/components/ui/` (cfmail's, under its MIT notice in `THIRD_PARTY_NOTICES.md`).

The teal marks the one primary action of a screen and the one thing to read in a card: the headline's line, a funnel's bars, a scroll depth's bars, a heatmap's clicks. Ranked lists use quiet neutral bars. Every screen is checked in light and dark mode by `pnpm e2e --shots <folder>`, which keeps a picture of each for review.
