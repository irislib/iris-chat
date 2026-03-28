export const spaDocumentPath = '/__iris_chat_app'

/**
 * @param {Request} request
 * @param {URL} url
 * @returns {Request}
 */
export function buildSpaDocumentRequest(request, url) {
  return new Request(new URL(spaDocumentPath, url), request)
}
