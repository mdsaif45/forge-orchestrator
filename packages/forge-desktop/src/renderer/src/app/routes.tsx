import type { ReactNode } from 'react'
import { Icon } from '../ui'

/**
 * The route table — the single source of truth for navigation.
 *
 * The sidebar and the router both derive from this array, so a route cannot
 * exist in one and not the other, and a nav item cannot point at a dead link.
 * `RoutePath` is a union over it, making a typo a compile error.
 *
 * Questions and Decisions are thread-native inside the execution flow (`/workflows`),
 * rather than standalone top-level navigation destinations.
 */
export const ROUTES = [
  {
    path: '/',
    label: 'Overview',
    icon: <Icon name="overview" />,
    empty: {
      title: 'No project open',
      description:
        'Create a project and bind it to a repository to begin. Forge keeps the project state; agents only do the work.',
    },
  },
  {
    path: '/ask',
    label: 'Ask',
    icon: <Icon name="ask" />,
    empty: {
      title: 'No project open',
      description: 'Ask questions to explore repository architecture, workflows, and conventions.',
    },
  },
  {
    path: '/workflows',
    label: 'Workflows',
    icon: <Icon name="workflows" />,
    empty: {
      title: 'No workflows yet',
      description:
        'A workflow moves a change from plan through implementation, verification, and review — and stops if a decision is needed.',
    },
  },
  {
    path: '/changes',
    label: 'Changes',
    icon: <Icon name="changes" />,
    empty: {
      title: 'No changes captured',
      description:
        'Every agent step is diffed against a snapshot taken before it ran, so what changed is measured rather than reported.',
    },
  },
  {
    path: '/agents',
    label: 'Agents',
    icon: <Icon name="agents" />,
    empty: {
      title: 'No agent runtimes configured',
      description:
        'Runtimes are bound to roles per project. Any runtime can hold any role, as long as it declares the capability.',
    },
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: <Icon name="settings" />,
    empty: {
      title: 'Settings',
      description:
        'Rules resolve from global through workspace, project, workflow, agent, and task — most specific wins.',
    },
  },
] as const satisfies readonly RouteDefinition[]

interface RouteDefinition {
  readonly path: string
  readonly label: string
  readonly icon: ReactNode
  readonly empty: {
    readonly title: string
    readonly description: string
  }
}

export type RoutePath = (typeof ROUTES)[number]['path']

export type Route = (typeof ROUTES)[number]
