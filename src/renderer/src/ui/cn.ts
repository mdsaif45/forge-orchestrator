import clsx, { type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merges class names, letting a later utility win over an earlier one.
 *
 * `clsx` resolves conditionals; `twMerge` resolves Tailwind conflicts, so a
 * caller passing `className="px-6"` overrides a variant's `px-3` instead of both
 * landing in the class list and the outcome depending on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
