const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

export function assertSafeFileName(value: string, label: string): void {
  if (!value || value !== value.trim()) throw new Error(`Invalid ${label}: "${value}".`)

  if (
    value === '.'
    || value === '..'
    || value.endsWith('.')
    || value.endsWith(' ')
    || WINDOWS_INVALID_CHARS.test(value)
    || WINDOWS_RESERVED_NAME.test(value)
  ) {
    throw new Error(`Invalid ${label}: "${value}".`)
  }
}

export function assertSafeTodoRef(ref: string): void {
  if (ref.startsWith('#')) {
    if (!/^#[0-9]+$/.test(ref)) throw new Error(`Invalid todo ref: "${ref}".`)
    return
  }

  assertSafeFileName(ref, 'todo ref')
  if (/^[0-9]+$/.test(ref)) throw new Error(`Invalid todo ref: "${ref}".`)
}
