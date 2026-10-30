/** Only verbatim human text can serve as permanent-memory evidence. */
export function userMessageText(content) {
  return Array.isArray(content)
    ?content.filter(block=>block?.type==='text'&&typeof block.text==='string'&&block.dafeiyuQQEnrichment!==true).map(block=>block.text).join('\n')
    :'';
}
