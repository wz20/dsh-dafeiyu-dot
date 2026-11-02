import path from 'node:path';

export function resolveAssetPath(root,name,paths=path) {
  const missing=()=>Object.assign(Error('资源不存在。'),{status:404});
  if(typeof name!=='string'||!name||name.includes('\0')||paths.parse(name).root)throw missing();
  const base=paths.resolve(root),target=paths.resolve(base,name),relative=paths.relative(base,target);
  if(!relative||relative==='..'||relative.startsWith('..'+paths.sep)||paths.isAbsolute(relative))throw missing();
  return target;
}
