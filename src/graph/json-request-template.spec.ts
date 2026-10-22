import { describe, expect, it } from 'vitest'
import { formatJsonRequestBodyTemplate, jsonRequestBodyTemplateError } from './json-request-template.ts'

describe('JSON request body templates', () => {
  it('formats typed variables without adding quotes around them', () => {
    const source = '{"id":"{{inputs.wordOrderId}}","shopId":{{inputs.workOrderDetail.shopId}},"items":{{inputs.workOrderDetail.items}},"title":"{{inputs.workOrderDetail.title}}"}'
    const formatted = formatJsonRequestBodyTemplate(source)
    expect(formatted).toContain('"shopId": {{inputs.workOrderDetail.shopId}}')
    expect(formatted).toContain('"items": {{inputs.workOrderDetail.items}}')
    expect(formatted).toContain('"title": "{{inputs.workOrderDetail.title}}"')
    expect(jsonRequestBodyTemplateError(formatted)).toBeUndefined()
  })

  it('pinpoints a trailing extra brace before execution', () => {
    const source = '{\n  "id": "{{inputs.wordOrderId}}"\n}\n}'
    expect(jsonRequestBodyTemplateError(source)).toContain('第 4 行')
    expect(() => formatJsonRequestBodyTemplate(source)).toThrow('请求体 JSON 格式错误')
  })

  it('does not misclassify a raw GraphQL request as JSON', () => {
    expect(jsonRequestBodyTemplateError('{ user { id } }')).toBeUndefined()
  })
})
