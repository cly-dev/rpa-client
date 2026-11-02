import { useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & {
  readonly value: number | string | undefined
}

export function emptyNumberFallback(min: number | string | undefined): number {
  const lowerBound = Number(min)
  return Number.isFinite(lowerBound) ? Math.max(1, lowerBound) : 1
}

/** Keep an empty edit local until blur, so controlled numeric fields can actually be cleared. */
export function ClearableNumberInput({ value, min, onChange, onBlur, ...rest }: Props): ReactNode {
  const [draft, setDraft] = useState<string | undefined>()
  const changed = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = event.currentTarget.value
    setDraft(next)
    if (next !== '' && Number.isFinite(Number(next))) onChange?.(event)
  }
  const blurred: NonNullable<Props['onBlur']> = event => {
    if (event.currentTarget.value === '' || !Number.isFinite(Number(event.currentTarget.value))) {
      event.currentTarget.value = String(emptyNumberFallback(min))
      onChange?.(event as unknown as ChangeEvent<HTMLInputElement>)
    }
    setDraft(undefined)
    onBlur?.(event)
  }
  return <input {...rest} type="number" min={min} value={draft ?? value ?? ''} onChange={changed} onBlur={blurred} />
}
