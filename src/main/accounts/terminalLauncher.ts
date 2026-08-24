import { spawn } from 'node:child_process'

/**
 * Opens the user's own terminal, running one command with a given environment.
 *
 * Used for provider sign-in, which is interactive by nature: `claude auth login` opens
 * a browser and waits. Forge cannot complete it and should not try — a terminal the
 * user owns keeps the credential exchange between them and the vendor, with Forge
 * never positioned to observe what is typed.
 *
 * Detached and unreferenced, because the login outlives the call: Forge hands the
 * window over and learns the outcome by probing auth state afterwards, not by watching
 * the process.
 */
export function openTerminal(request: {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}): void {
  const { command, args, env, cwd } = request

  const child =
    process.platform === 'win32'
      ? spawn(
          'cmd.exe',
          // `start ""` opens a new console window; the empty string is the window
          // title, and omitting it makes `start` treat a quoted command as the title
          // and silently open an empty shell instead.
          ['/c', 'start', '""', 'cmd.exe', '/k', command, ...args],
          {
            env: { ...process.env, ...env },
            detached: true,
            stdio: 'ignore',
            ...(cwd === undefined ? {} : { cwd }),
          },
        )
      : spawn(command, [...args], {
          env: { ...process.env, ...env },
          detached: true,
          stdio: 'ignore',
          ...(cwd === undefined ? {} : { cwd }),
        })

  // Nothing waits on this: the sign-in takes as long as it takes, and Forge learns the
  // result by asking `auth status` rather than by watching an exit code.
  child.unref()
}
