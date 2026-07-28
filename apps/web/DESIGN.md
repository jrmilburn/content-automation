---
name: Studio Parallel Internal Workspace
description: A restrained production ledger for evidence, attention and safe action.
colors:
  navigation-ink: "#191816"
  ink: "#1c1b19"
  muted-ink: "#625d54"
  canvas-paper: "#f3f0e9"
  raised-paper: "#fffdf8"
  rule: "#d8d2c7"
  focus-blue: "#2457d6"
  success-green: "#256b4a"
  warning-ochre: "#8b5a00"
  danger-red: "#a63a32"
  information-blue: "#365f8d"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.5rem)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.1em"
rounded:
  compact: "4px"
  control: "8px"
  pill: "999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.navigation-ink}"
    textColor: "{colors.raised-paper}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    typography: "{typography.title}"
  button-secondary:
    backgroundColor: "{colors.raised-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    typography: "{typography.title}"
  status-badge:
    backgroundColor: "{colors.raised-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
    typography: "{typography.label}"
---

# Design System: Studio Parallel Internal Workspace

## Overview

**Creative North Star: "The Studio Work Ledger"**

The incumbent warm paper, dark ink and workhorse sans-serif become a disciplined production ledger:
quiet enough for long operating sessions, but precise enough that location, state and the next action
never blur together. Navigation is a dark fixed frame; evidence and work states live on a flat paper
canvas divided by rules, typographic weight and restrained tonal fields.

This is an operating tool rather than a decorative analytics dashboard. Density is earned, status is
literal, and graphic character comes from rigorous alignment, crisp rules and occasional full-width
bands—not gradients, floating glass or a grid of interchangeable cards.

**Key Characteristics:**

- A dark navigation frame around a warm, highly legible work canvas.
- Flat tonal hierarchy with crisp rules and very limited shadow.
- Compact labels, decisive headings and sentence-case operational copy.
- One visually dominant action per state, with status always carried by text and symbol.

## Colors

The palette is restrained ink-on-paper with semantic colors reserved for focus and named status.

### Primary

- **Navigation Ink:** Holds the global frame and primary actions so they read as stable controls.
- **Focus Blue:** Appears only in focus rings and selected-control details; its rarity makes keyboard
  location unmistakable.

### Secondary

- **Success Green, Warning Ochre, Danger Red and Information Blue:** Support status icons, borders and
  small tonal fields. Every use is paired with text or an icon.

### Neutral

- **Canvas Paper:** The default application background.
- **Raised Paper:** The readable surface for dialogs, menus and bounded states.
- **Ink and Muted Ink:** Primary and supporting copy.
- **Rule:** Separates regions and rows without simulated depth.

**The Status Speaks Rule.** Semantic color never carries meaning without a symbol and explicit label.

## Typography

**Display Font:** Inter with the system sans-serif fallback
**Body Font:** Inter with the system sans-serif fallback

**Character:** A workhorse grotesk keeps dense operational language neutral and fast. Character comes
from controlled scale, tight heading tracking and compact metadata labels rather than a second display
face.

### Hierarchy

- **Headline:** Used once for the current page and kept compact enough to leave room for a blocking
  alert or primary action.
- **Title:** Names navigation groups, state panels and controls.
- **Body:** Uses generous line height and a maximum readable measure for explanations.
- **Label:** Uppercase only for short structural metadata such as workspace or state category.

**The One Page Heading Rule.** Every route exposes one unambiguous `h1`; component headings descend in
order and never imitate it with styling alone.

## Layout

Desktop uses a persistent global rail and a flexible content canvas. The page header aligns current
location and one primary action on the same baseline; bounded states occupy the content column rather
than floating in a card grid. At narrow widths the rail becomes a modal navigation sheet, the page
header stacks, and controls retain a minimum 44px target. The 390px composition has no horizontal page
overflow; only explicitly labelled dense tables may scroll within their own region.

The spacing rhythm uses compact increments for controls and rows, then larger section breaks so dense
and quiet passages alternate deliberately.

## Elevation & Depth

The system is flat by default. Background changes, borders and placement establish hierarchy. Shadow
is reserved for the mobile navigation sheet and native modal dialog where physical separation is
necessary; content panels do not float.

**The Structural Depth Rule.** If a border or tonal field can explain the hierarchy, do not add a
shadow.

## Shapes

Controls use gently squared corners; informational panels retain compact corners or crisp edges. Pills
belong only to short status labels. Large rounded containers and nested rounded cards are not part of
the incumbent language.

## Components

### Buttons

- **Shape:** Gently squared controls with a 44px minimum target.
- **Primary:** Dark ink field, raised-paper text and strong title weight.
- **Hover / Focus:** A small tonal shift on hover and a high-contrast offset blue focus ring.
- **Secondary:** Raised-paper field, ink text and a visible rule border.

### Status Badges

- **Style:** Compact pill carrying a symbol, explicit status text and a semantic border/tint.
- **State:** Semantic variants share the same geometry so color is never the only differentiator.

### Cards / Containers

- **Corner Style:** Compact rather than soft.
- **Background:** Raised paper only when a state needs a bounded reading surface.
- **Shadow Strategy:** Flat at rest.
- **Border:** One-pixel rule.
- **Internal Padding:** Responsive medium-to-large spacing.

### Navigation

Primary destinations occupy the stable dark frame with large touch targets and a solid active-route
marker. Secondary destinations are grouped separately but remain visible. Mobile navigation uses a
modal sheet with a labelled close control, Escape support and focus returned to the opener.

## Do's and Don'ts

### Do:

- **Do** lead each route with current location, blocking context and one safe next action.
- **Do** pair every semantic color with explicit status language and a symbol.
- **Do** use rules, spacing and typography to make dense information scannable.
- **Do** preserve visible focus and native control semantics before adding motion.

### Don't:

- **Don't** turn the shell into a marketing surface or ornamental dashboard.
- **Don't** create a grid of generic rounded cards when a list, region or state panel is clearer.
- **Don't** hide primary actions, navigation or essential status at 390px.
- **Don't** animate layout or status in a way that survives `prefers-reduced-motion`.
