export interface BulkArchiveResult {
  readonly archivedIds: readonly string[]
  readonly failures: readonly { id: string; message: string }[]
}

/** Archive one at a time so failures are reported without hiding partial success. */
export async function bulkArchiveWorkflows(
  ids: readonly string[],
  archive: (id: string) => Promise<unknown>,
): Promise<BulkArchiveResult> {
  const archivedIds: string[] = []
  const failures: { id: string; message: string }[] = []
  for (const id of new Set(ids)) {
    try {
      await archive(id)
      archivedIds.push(id)
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { archivedIds, failures }
}
