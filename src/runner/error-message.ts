/** Playwright errors can contain credential-bearing request headers. */
export function safeErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '')
  return message
    .replace(/(^[^\S\n]*(?:-\s*)?(?:cookie|set-cookie|authorization|proxy-authorization|x-api-key)\s*:\s*)[^\r\n]*/gim, '$1[已隐藏]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:token|access_token|api_key|signature|password|secret)=)[^\s&#"']+/gi, '$1[已隐藏]')
}
