/**
 * Navigation icons.
 *
 * Hand-drawn on a 16px grid rather than pulled from an icon package: the set is
 * small, and an offline-only app should not ship a dependency for eight glyphs.
 * All are `aria-hidden` — every icon here sits beside a text label or inside an
 * `IconButton`, which carries the accessible name.
 */

function Icon({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function OverviewIcon(): React.JSX.Element {
  return (
    <Icon>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </Icon>
  )
}

export function WorkflowsIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="8" r="2" />
      <circle cx="4" cy="12" r="2" />
      <path d="M6 4.8 10 7.2M10 8.8 6 11.2" />
    </Icon>
  )
}

export function TasksIcon(): React.JSX.Element {
  return (
    <Icon>
      <path d="M2 4.5 3.5 6 6 3" />
      <path d="M2 11.5 3.5 13 6 10" />
      <path d="M8.5 4.5h5.5M8.5 11.5h5.5" />
    </Icon>
  )
}

export function DecisionsIcon(): React.JSX.Element {
  return (
    <Icon>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Icon>
  )
}

export function ChangesIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="4" cy="4" r="1.75" />
      <circle cx="4" cy="12" r="1.75" />
      <circle cx="12" cy="8" r="1.75" />
      <path d="M4 5.75v4.5M5.75 4h2.75a1.75 1.75 0 0 1 1.75 1.75v.5" />
    </Icon>
  )
}

export function QuestionsIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.25 6.25a1.75 1.75 0 1 1 2.6 1.5c-.55.35-.85.7-.85 1.25" />
      <path d="M8 11.5h.01" />
    </Icon>
  )
}

export function AgentsIcon(): React.JSX.Element {
  return (
    <Icon>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2v3" />
      <path d="M6 8.5h.01M10 8.5h.01" />
    </Icon>
  )
}

export function SettingsIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.75M8 12.75v1.75M2.9 2.9l1.25 1.25M11.85 11.85l1.25 1.25M1.5 8h1.75M12.75 8h1.75M2.9 13.1l1.25-1.25M11.85 4.15 13.1 2.9" />
    </Icon>
  )
}

export function CollapseIcon(): React.JSX.Element {
  return (
    <Icon>
      <path d="M10 4 6 8l4 4" />
    </Icon>
  )
}

export function ExpandIcon(): React.JSX.Element {
  return (
    <Icon>
      <path d="M6 4l4 4-4 4" />
    </Icon>
  )
}
