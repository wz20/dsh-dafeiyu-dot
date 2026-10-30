export const SINGING_TOOL = 'dafeiyu_sing';
const songIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only accept a successful result linked to this turn's actual singing tool call. */
export function observeSongResult(event, calls) {
  if (event.type === 'tool/call' && event.data?.name === SINGING_TOOL) calls.add(event.data.callId);
  if (event.type === 'tool/ptc-dispatch-start' && event.data?.name === SINGING_TOOL) calls.add(event.data.subCallId);
  const message=event.type==='tool/result'?event.data?.message:event.type==='tool/ptc-dispatch'&&event.data?.name===SINGING_TOOL?{...event.data,toolCallId:event.data.subCallId}:null;
  if (!message || !calls.delete(message.toolCallId) || message.isError) return null;
  const blocks = message.content;
  if (!Array.isArray(blocks)) return null;
  try {
    const value = JSON.parse(blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    return value?.status === 'ready' && songIdPattern.test(value.songId) ? {songId:value.songId, title:typeof value.title === 'string' ? value.title.slice(0,100) : '清唱'} : null;
  } catch { return null; }
}
