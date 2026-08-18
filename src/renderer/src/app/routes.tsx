import type { ReactNode } from 'react'
import {
  AgentsIcon,
  ChangesIcon,
  DecisionsIcon,
  OverviewIcon,
  QuestionsIcon,
  SettingsIcon,
  TasksIcon,
  WorkflowsIcon,
} from './icons'

/**
 * The route table — the single source of truth for navigation.
 *
 * The sidebar and the router both derive from this array, so a route cannot
 * exist in one and not the other, and a nav item cannot point at a dead link.
 * `RoutePath` is a union over it, making a typo a compile error.
 */
export const ROUTES = [
  {
    path: '/',
    label: 'Overview',
    icon: <OverviewIcon />,
    empty: {
      title: 'No project open',
      description:
        'Create a project and bind it to a repository to begin. Forge keeps the project state; agents only do the work.',
    },
  },
  {
    path: '/workflows',
    label: 'Workflows',
    icon: <WorkflowsIcon />,
    empty: {
      title: 'No workflows yet',
      description:
        'A workflow moves a change from plan through implementation, verification, and review — and stops if a decision is needed.',
    },
  },
  {
    path: '/tasks',
    label: 'Tasks',
    icon: <TasksIcon />,
    empty: {
      title: 'No tasks yet',
      description:
        'Tasks carry an objective, its constraints, and the completion criteria Forge will check against the repository.',
    },
  },
  {
    path: '/decisions',
    label: 'Decisions',
    icon: <DecisionsIcon />,
    empty: {
      title: 'No decisions recorded',
      description:
        'Decisions you approve become locked. An agent cannot change a locked decision without asking you first.',
    },
  },
  {
    path: '/changes',
    label: 'Changes',
    icon: <ChangesIcon />,
    empty: {
      title: 'No changes captured',
      description:
        'Every agent step is diffed against a snapshot taken before it ran, so what changed is measured rather than reported.',
    },
  },
  {
    path: '/questions',
    label: 'Questions',
    icon: <QuestionsIcon />,
    empty: {
      title: 'No open questions',
      description:
        'When an agent cannot resolve something from the repository, it asks here with its evidence — and the workflow waits.',
    },
  },
  {
    path: '/agents',
    label: 'Agents',
    icon: <AgentsIcon />,
    empty: {
      title: 'No agent runtimes configured',
      description:
        'Runtimes are bound to roles per project. Any runtime can hold any role, as long as it declares the capability.',
    },
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: <SettingsIcon />,
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
