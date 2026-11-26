import clsx, { type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merges class names, letting a later utility win over an earlier one.
 *
 * `clsx` resolves conditionals; `twMerge` resolves Tailwind conflicts so caller
 * utilities predictably override base primitive variants.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
