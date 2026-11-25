/** Overwrite mode needs a destination, not a second user-facing variable name.
 * Keep existing output keys so saved bindings and code returns remain compatible. */
export function completeOverwriteOutput<T extends { name: string; outputMode?: string; updateVariable?: string }>(output: T, otherNames: readonly string[]): T {
  if (output.outputMode !== 'update' || !output.updateVariable?.trim() || output.name.trim()) return output
  const clean = output.updateVariable.trim().replace(/[^A-Za-z0-9_]/g, '_')
  const base = /^[A-Za-z_]/.test(clean) ? clean : `updated_${clean}`
  let name = base
  for (let n = 2; otherNames.includes(name); n += 1) name = `${base}_${n}`
  return { ...output, name }
}
