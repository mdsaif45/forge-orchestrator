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
      className="shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function OverviewIcon(): React.JSX.Element {
  return (
    <Icon>
      <rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.25" />
      <rect x="9" y="2.25" width="4.75" height="4.75" rx="1.25" />
      <rect x="2.25" y="9" width="4.75" height="4.75" rx="1.25" />
      <rect x="9" y="9" width="4.75" height="4.75" rx="1.25" />
    </Icon>
  )
}

export function WorkflowsIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="3.5" cy="4" r="1.75" />
      <circle cx="12.5" cy="8" r="1.75" />
      <circle cx="3.5" cy="12" r="1.75" />
      <path d="M5.25 4h3.5a2 2 0 0 1 2 2v2M5.25 12h3.5a2 2 0 0 0 2-2V8" />
    </Icon>
  )
}

export function TasksIcon(): React.JSX.Element {
  return (
    <Icon>
      <path d="M2.5 4.5 4 6 7 3" />
      <path d="M2.5 11.5 4 13 7 10" />
      <path d="M9 4.5h4.5M9 11.5h4.5" />
    </Icon>
  )
}

export function DecisionsIcon(): React.JSX.Element {
  return (
    <Icon>
      <rect x="3" y="6.5" width="10" height="7.5" rx="1.5" />
      <path d="M5.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" />
      <circle cx="8" cy="10" r="0.75" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function ChangesIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="4" cy="4" r="1.75" />
      <circle cx="4" cy="12" r="1.75" />
      <circle cx="12" cy="6" r="1.75" />
      <path d="M4 5.75v4.5" />
      <path d="M4 8.5a4 4 0 0 0 4-4h2.25" />
    </Icon>
  )
}

export function QuestionsIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 6.2a1.75 1.75 0 0 1 3 1.2c0 .8-.8 1.2-1.3 1.6-.3.25-.4.5-.4.8" />
      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function AgentsIcon(): React.JSX.Element {
  return (
    <Icon>
      <rect x="2.5" y="4.5" width="11" height="9" rx="2" />
      <path d="M8 2v2.5M1.5 9h1M13.5 9h1" />
      <circle cx="5.5" cy="8.5" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="8.5" r="0.75" fill="currentColor" stroke="none" />
      <path d="M5.5 11h5" />
    </Icon>
  )
}

export function SettingsIcon(): React.JSX.Element {
  return (
    <Icon>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M6.9 1.5h2.2l.3 1.3a5 5 0 0 1 1.2.7l1.3-.5 1.5 1.5-.5 1.3a5 5 0 0 1 .7 1.2l1.3.3v2.2l-1.3.3a5 5 0 0 1-.7 1.2l.5 1.3-1.5 1.5-1.3-.5a5 5 0 0 1-1.2.7l-.3 1.3H6.9l-.3-1.3a5 5 0 0 1-1.2-.7l-1.3.5-1.5-1.5.5-1.3a5 5 0 0 1-.7-1.2l-1.3-.3V7.9l1.3-.3a5 5 0 0 1 .7-1.2l-.5-1.3 1.5-1.5 1.3.5a5 5 0 0 1 1.2-.7l.3-1.3z" />
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

export function AskIcon(): React.JSX.Element {
  return (
    <Icon>
      <path d="M2.5 12.5V3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-6.5L2.5 14.5v-2z" />
      <path d="M6 6.5h4M6 9h2.5" />
    </Icon>
  )
}

export function CloseIcon(): React.JSX.Element {
  return (
    <Icon>
      <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
    </Icon>
  )
}
