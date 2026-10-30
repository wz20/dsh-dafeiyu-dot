export function json(res,status,body) {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
}
export async function readJson(req,maxBytes=5_700_000) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(Error('请求内容过大。'),{status:413});chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
  catch{throw Object.assign(Error('请求格式不正确。'),{status:400});}
}
export function authorize(req,connection) {
  const h=req.headers??{};
  if(h['sec-fetch-site']&&!['same-origin','none'].includes(h['sec-fetch-site']))return 403;
  if(h.origin){try{if(new URL(h.origin).host!==h.host)return 403;}catch{return 403;}}
  if(connection?.requestRejection){const result=connection.requestRejection(req);return result==null||result===false?undefined:typeof result==='number'?result:401;}
  const address=req.socket?.remoteAddress?.replace(/^::ffff:/,'');
  return address==='::1'||address?.startsWith('127.')?undefined:401;
}
