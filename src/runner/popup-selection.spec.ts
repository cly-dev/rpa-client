import type { Locator, Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { resolveReadablePopupTextLocator } from './playwright-driver.ts'

const parent = 'html > body:nth-of-type(1) > div.arco-tree-select-popup > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(13)'
const tail = 'div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(13)'
function fixture(globalIds: string[], tailIds: string[], originalIds: string[] = []) {
  const elements = new Map<string, object>()
  for (const id of globalIds) {
    const element = { closest: () => element, contains: (other: unknown) => element === other }
    elements.set(id, element)
  }
  const lists = new Map<Locator, string[]>()
  const make = (ids: string[]): Locator => {
    const value = {
      getByText: () => value, visible: () => value,
      first: () => make(ids.slice(0, 1)), nth: (index: number) => make(ids.slice(index, index + 1)),
      waitFor: async () => { if (!ids.length) throw new Error('not found') },
      evaluateAll: async (fn: (elements: object[]) => unknown) => fn(ids.map(id => elements.get(id)!)),
      and: (other: Locator) => make(ids.filter(id => lists.get(other)?.includes(id))),
    } as unknown as Locator
    lists.set(value, ids)
    return value
  }
  const locator = vi.fn((selector: string) => selector === tail ? make(tailIds) : selector === parent ? make(originalIds) : make(globalIds))
  return { page: { locator } as unknown as Pick<Page, 'locator'>, locator, ids: (result: Locator) => lists.get(result) }
}

it('uses unique exact text directly without consulting the stale picked path', async () => {
  const f = fixture(['only'], [])
  expect(f.ids(await resolveReadablePopupTextLocator(f.page, { text: '买错', parentPath: parent }, 100))).toEqual(['only'])
  expect(f.locator).toHaveBeenCalledTimes(1)
})
it('narrows duplicate exact text using the picked leaf ordinal', async () => {
  const f = fixture(['wrong', 'wanted'], ['wanted'])
  expect(f.ids(await resolveReadablePopupTextLocator(f.page, { text: '买错', parentPath: parent }, 100))).toEqual(['wanted'])
  expect(f.locator).toHaveBeenCalledWith(tail)
})
it('does not choose a position whose text differs from the requested text', async () => {
  const f = fixture(['first', 'second'], ['differentText'])
  await expect(resolveReadablePopupTextLocator(f.page, { text: '买错', parentPath: parent }, 100)).rejects.toThrow('未匹配到相同文本')
})
it('keeps failing when text and tail still identify two independent options', async () => {
  const f = fixture(['first', 'second'], ['first', 'second'])
  await expect(resolveReadablePopupTextLocator(f.page, { text: '买错', parentPath: parent }, 100)).rejects.toThrow('仍有 2 个独立选项')
})
it('uses the original scope only if duplicate ordinals remain in separate popups', async () => {
  const f = fixture(['first', 'second'], ['first', 'second'], ['second'])
  expect(f.ids(await resolveReadablePopupTextLocator(f.page, { text: '买错', parentPath: parent }, 100))).toEqual(['second'])
})

it('does not reapply a global same-text index after narrowing to a unique leaf', async () => {
  const f = fixture(['first', 'second'], ['second'])
  expect(f.ids(await resolveReadablePopupTextLocator(f.page, { text: '买错', textIndex: 1, parentPath: parent }, 100))).toEqual(['second'])
})
