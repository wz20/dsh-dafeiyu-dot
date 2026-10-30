import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Every update is serialized and published only after its atomic disk commit.
export class JsonStore {
  constructor(path, initial) {
    this.path = path;
    mkdirSync(dirname(path), {recursive:true,mode:0o700});
    try { this.value = JSON.parse(readFileSync(path,'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.value = initial; }
    this.pending = Promise.resolve();
  }
  get() { return structuredClone(this.value); }
  mutate(change) {
    const operation = this.pending.then(async () => {
      const draft = this.get();
      const value = await change(draft) ?? draft;
      const temp = this.path+'.'+randomUUID()+'.tmp';
      try { await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,this.path); }
      catch (error) { await unlink(temp).catch(()=>{});throw error; }
      this.value = value;
      return this.get();
    });
    this.pending = operation.catch(()=>{});
    return operation;
  }
}
