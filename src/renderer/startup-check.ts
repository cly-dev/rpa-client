import { RPA_SERVICE_URL } from '@graph/service-llms.ts'

export type ServiceReadiness =
  | { readonly kind: 'ready'; readonly message: string }
  | { readonly kind: 'unavailable' | 'incompatible'; readonly message: string }

const SUPPORTED_API_VERSION = 1

export async function checkServiceReadiness(fetcher: typeof fetch = fetch): Promise<ServiceReadiness> {
  let response: Response
  try {
    response = await fetcher(`${RPA_SERVICE_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3500),
    })
  } catch {
    return { kind: 'unavailable', message: '无法连接服务端，请确认服务已启动并检查网络后重试' }
  }
  if (response.status === 404) return { kind: 'incompatible', message: '服务端版本过旧，缺少启动检查接口，请先更新服务端' }
  if (!response.ok) return { kind: 'unavailable', message: '服务端暂不可用，请稍后重试或联系管理员检查服务与数据库' }
  try {
    const body = await response.json() as { code?: number; data?: { status?: string; apiVersion?: number } }
    if (body.code !== 0 || body.data?.status !== 'ready') {
      return { kind: 'unavailable', message: '服务端尚未就绪，请稍后重试' }
    }
    if (body.data.apiVersion !== SUPPORTED_API_VERSION) {
      return { kind: 'incompatible', message: '客户端与服务端版本不兼容，请联系管理员更新软件' }
    }
    return { kind: 'ready', message: '服务端已就绪' }
  } catch {
    return { kind: 'incompatible', message: '服务端返回格式不正确，请联系管理员检查部署版本' }
  }
}
