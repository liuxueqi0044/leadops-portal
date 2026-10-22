# LeadOps design system

## Product and scope

LeadOps is an English-language agency operations workspace. The interface supports lead qualification, human decisions, workflow execution, incident recovery, reporting, and client administration. Preserve the Next.js/React architecture, real API contracts, tenant boundaries, role visibility, and existing query-string deep links.

The redesign uses the `frontend-design-explore` workflow. Three lightweight alternatives were compared at desktop and mobile widths: a calm sidebar workspace, a top-navigation task workbench, and a dark lifecycle board. The sidebar workspace was selected by the implementing agent under the user's instruction to redesign the frontend. It accommodates all eight sections and makes client context persistent. The top-navigation option compresses navigation at smaller widths; the dark board gives lifecycle stages too much space for a product with substantial lists and detail views.

## Visual language

Use warm, quiet surfaces, forest-green actions, sage accents, readable operational text, and restrained borders. Reserve serif typography for page-level headings; navigation, controls, data, and supporting text use the native sans-serif stack. The product should feel deliberate and calm without hiding operational exceptions.

| Token              | Value     | Purpose                                         |
| ------------------ | --------- | ----------------------------------------------- |
| `--canvas`         | `#F8F9F6` | Workspace background                            |
| `--surface`        | `#FFFFFF` | Tables, panels, dialogs                         |
| `--surface-subtle` | `#F1F4EE` | Quiet secondary surfaces                        |
| `--ink`            | `#1C3029` | Main text                                       |
| `--ink-soft`       | `#52625A` | Secondary text                                  |
| `--ink-faint`      | `#67756E` | Metadata on light backgrounds                   |
| `--brand`          | `#245B46` | Primary controls, links, visualization emphasis |
| `--brand-dark`     | `#173E30` | Strong emphasis and brand mark                  |
| `--brand-soft`     | `#E9F1E9` | Selected navigation and quiet brand surfaces    |
| `--accent`         | `#D5EB9E` | Small identity accents                          |
| `--border`         | `#E0E6DF` | Dividers and surface boundaries                 |
| `--radius-card`    | `12px`    | Content surfaces                                |
| `--radius-control` | `8px`     | Inputs and buttons                              |

Status colors retain separate semantic roles. Always include readable status labels; color alone must not carry approval, failure, or incident state.

## Typography and density

- Page headings: Georgia/Times serif, regular weight, approximately 30–38px.
- Body and controls: Segoe UI/native sans-serif, normally 13–15px with comfortable line height.
- Metadata: 12px by default. Small navigation badges and compact mobile labels may use 10–11px, with context available in accessible names.
- Panel headings: approximately 16px, semibold. Numbers use tabular numerals where comparison matters.
- Dense lists use alignment, whitespace, and subtle row dividers. Do not recover density by shrinking business text to the former 8–10px scale.
- Fonts remain system-provided; no external requests or CSP changes are required.

## Structure and responsive behavior

The desktop shell uses a 232px sidebar, a compact top bar with current section and client selection, and a main content area with approximately 36px horizontal padding. At intermediate widths the sidebar narrows. At 720px and below it becomes bottom navigation plus a full navigation dialog. All permitted pages remain accessible on mobile; agency-only pages remain role-restricted.

Overview uses a contiguous metric strip, followed by pipeline/outcome totals and an actionable queue. The mobile metric strip is two columns and the queue precedes the totals. Lead status counts, approval records, and appointment events are different populations: display their counts without claiming a unique-lead conversion funnel. Use the backend's qualification and completed-decision rates with explicit labels. Scale comparison bars to the largest displayed count. Recent leads and automation results remain linked to their real detail/section destinations. Do not invent time-series data, growth percentages, or reporting periods that the backend does not provide.

Lead tables convert to readable mobile cards. Other wide tables may scroll inside their container, without horizontal overflow of the whole page. Long IDs and text must wrap where appropriate. Dialog bodies scroll independently and keep their actions accessible.

## Interaction rules

- Search is available by a visible control and Ctrl/Cmd+K, including on mobile.
- Search, mobile navigation, and approval drawers support keyboard focus containment, Escape, scroll locking, and focus return. Stacked dialogs give focus handling to the topmost dialog.
- Navigation preserves the selected client. Switching client clears lead/approval/incident selections belonging to the previous workspace.
- Notification indicators use the actual open-incident count.
- Preserve loading, empty, error, disabled, pending, completed, and conflict states. API payloads and optimistic-concurrency fields remain unchanged.
- Demo data remains visibly identified. Demo interactions are local simulations; production authentication and demo restrictions remain intact.
- Motion is limited to subtle transitions and respects reduced-motion preferences.

## Decisions to preserve

The user requested a frontend redesign and delegated skill selection and implementation. The agent selected the calm sidebar direction and kept the existing English product language and green brand family. These are implementation choices, not separately user-approved visual preferences. Future feedback can revise them without discarding the business workflows.

Do not reintroduce repeated full-width informational banners above every operational view, invent data to decorate charts, replace the existing stack solely for styling, or hide secondary sections on mobile.

## Validation

Use actual development-mode synthetic data for screenshots. Check desktop, tablet, and narrow mobile widths; include lead and incident details, approval drawer, report snapshot, search, navigation, login, and public approval. Check keyboard behavior and demo interactions in addition to static rendering. Repository lint, type checking, unit tests, and production build are separate from visual validation.

Validation performed for this implementation is recorded in `docs/frontend-redesign.md`.
