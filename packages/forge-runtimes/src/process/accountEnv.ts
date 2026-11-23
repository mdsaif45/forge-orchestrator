/**
 * Environment for a child process that must act as one specific account.
 *
 * Both variables are set because Windows resolves a home through `USERPROFILE` while
 * the CLI's own logic reads `HOME`. Setting only one leaves the other pointing at the
 * real user, and the process would silently authenticate as the wrong account — the
 * failure mode #111 exists to prevent, reintroduced by an incomplete environment.
 */
export function accountEnv(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home }
}
