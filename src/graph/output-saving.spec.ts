import { expect, it } from 'vitest'
import { completeOverwriteOutput } from './output-saving.ts'

it('automatically supplies the internal output key when only a destination is selected', () => {
  expect(completeOverwriteOutput({ name: '', outputMode: 'update', updateVariable: 'customerSolution' }, [])).toMatchObject({ name: 'customerSolution' })
  expect(completeOverwriteOutput({ name: '', outputMode: 'update', updateVariable: 'order.solution' }, ['order_solution'])).toMatchObject({ name: 'order_solution_2' })
})
it('preserves existing keys so saved node bindings and code return fields do not change', () => {
  expect(completeOverwriteOutput({ name: 'effectiveSolution', outputMode: 'update', updateVariable: 'customerSolution' }, [])).toMatchObject({ name: 'effectiveSolution' })
  expect(completeOverwriteOutput({ name: '', outputMode: 'produce' }, [])).toEqual({ name: '', outputMode: 'produce' })
})
