#!/usr/bin/env python3
"""Local release privacy checks. Reports labels and relative paths only."""
import argparse, collections, hashlib, io, json, os, pathlib, re, struct, sys, tarfile, zipfile

TEXT_SUFFIXES={'.js','.mjs','.cjs','.json','.md','.txt','.yml','.yaml','.toml','.html','.css','.xml','.svg','.py','.sh','.env','.ini','.conf'}
GENERIC_VOICES={'default','alloy','echo','fable','onyx','nova','shimmer','fixture-voice','test-voice','voice-a','voice-b'}
IDENTITY_KEYS={'botId','ownerId','groupId','senderId','sessionId','userId','accountId','uin'}
VOICE_KEYS={'localVoice','voiceId','profileId','speakerId'}
CREDENTIAL=re.compile(rb'(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})')
RUNTIME_NAME=re.compile(r'(^|/)(?:gateway-credentials\.json|qq-group-sessions\.json|qq-monitor\.json|memories\.json|state\.json|config\.json|session\.v\d+\.jsonl(?:\.zstd)?|\.env(?:\.[^/]*)?)$')
FOLDERS={'node_modules','.git','__pycache__'}

def strings(value):
    if isinstance(value,str): yield value
    elif isinstance(value,dict):
        for v in value.values(): yield from strings(v)
    elif isinstance(value,list):
        for v in value: yield from strings(v)

def collect_runtime(value,known):
    if isinstance(value,dict):
        for k,v in value.items():
            if isinstance(v,str) and v:
                if k in IDENTITY_KEYS and len(v)>=5:known.append(('runtime-identity',v.encode()))
                if k in VOICE_KEYS and v not in GENERIC_VOICES and len(v)>=6:known.append(('private-voice-identity',v.encode()))
            collect_runtime(v,known)
    elif isinstance(value,list):
        for v in value:collect_runtime(v,known)

def metadata_types(data):
    kinds=[]
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        pos=8
        while pos+12<=len(data):
            n=int.from_bytes(data[pos:pos+4],'big');tag=data[pos+4:pos+8]
            if tag in {b'tEXt',b'zTXt',b'iTXt',b'eXIf'}:kinds.append(tag.decode())
            pos+=n+12
    elif data.startswith(b'\xff\xd8'):
        if b'Exif\x00\x00' in data:kinds.append('EXIF')
        if b'http://ns.adobe.com/xap/1.0/' in data:kinds.append('XMP')
    elif data[:6] in {b'GIF87a',b'GIF89a'} and len(data)>=13:
        pos=13+(3*(2**((data[10]&7)+1)) if data[10]&128 else 0)
        def subblocks(start):
            while start<len(data):
                size=data[start];start+=1
                if not size:return start
                start+=size
            return len(data)
        while pos<len(data):
            marker=data[pos];pos+=1
            if marker==0x3b:break
            if marker==0x21 and pos<len(data):
                extension=data[pos];pos+=1
                if extension==0xfe:kinds.append('GIF-comment')
                pos=subblocks(pos)
            elif marker==0x2c and pos+9<=len(data):
                packed=data[pos+8];pos+=9
                if packed&128:pos+=3*(2**((packed&7)+1))
                pos+=1
                pos=subblocks(pos)
            else:break
    elif data.startswith(b'ID3'):
        kinds.append('MP3-ID3')
    elif data.startswith(b'RIFF') and data[8:12]==b'WAVE':
        pos=12
        while pos+8<=len(data):
            n=int.from_bytes(data[pos+4:pos+8],'little');tag=data[pos:pos+4]
            if tag in {b'LIST',b'bext',b'ID3 ',b'iXML'}:kinds.append(tag.decode().strip())
            pos+=8+n+(n%2)
    return kinds


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('public_root',type=pathlib.Path)
    ap.add_argument('--runtime-dir',type=pathlib.Path)
    ap.add_argument('--credentials-file',action='append',default=[],type=pathlib.Path)
    ap.add_argument('--private-manifest',type=pathlib.Path)
    ap.add_argument('--user-home',default=str(pathlib.Path.home()))
    ap.add_argument('--report',type=pathlib.Path)
    ap.add_argument('--fail-on-risk',action='store_true')
    args=ap.parse_args();root=args.public_root.resolve();known=[];private_hashes=set()
    if args.user_home:
        known += [('personal-home-path',args.user_home.encode()),('personal-home-name',pathlib.Path(args.user_home).name.encode())]
    if args.runtime_dir:
        for name in ['config.json','qq-group-sessions.json']:
            p=args.runtime_dir/name
            if p.exists():collect_runtime(json.loads(p.read_text()),known)
    for p in args.credentials_file:
        for value in strings(json.loads(p.read_text())):
            if len(value)>=8:known.append(('exact-credential',value.encode()))
    if args.private_manifest:
        manifest=json.loads(args.private_manifest.read_text())
        for row in manifest.get('terms',[]):
            if isinstance(row,str):known.append(('personal-term',row.encode()))
            else:known.append((row.get('category','personal-term'),row['value'].encode()))
        private_hashes.update(manifest.get('privateMediaSha256',[]))
    known=list(set(known));findings=[];seen=set();counts=collections.Counter();scanned=0;archives=0
    def add(path,category,severity='risk',**extra):
        key=(path,category)
        if key not in seen:
            seen.add(key)
            safe_path=path
            for _label,value in sorted(known,key=lambda row:len(row[1]),reverse=True):
                try:term=value.decode('utf-8')
                except UnicodeError:continue
                if term:safe_path=safe_path.replace(term,'[private]')
            findings.append({'path':safe_path,'category':category,'severity':severity,**extra});counts[severity]+=1
    def inspect(path,data,depth=0):
        nonlocal scanned,archives
        scanned+=1
        if hashlib.sha256(data).hexdigest() in private_hashes:add(path,'private-media-content')
        if RUNTIME_NAME.search(path) and pathlib.PurePosixPath(path).name not in {'.env.example'}:add(path,'runtime-data-filename')
        for category,value in known:
            if value and value in data:add(path,category)
        # Synthetic credential values belong only in clearly identified tests/examples.
        if CREDENTIAL.search(data):
            fixture=any(x in pathlib.PurePosixPath(path).parts for x in ('tests','fixtures','examples'))
            if not fixture:add(path,'credential-shaped-text')
            else:add(path,'synthetic-credential-review','review')
        for kind in metadata_types(data):add(path,'embedded-metadata:'+kind,'review')
        low=path.lower()
        if low.endswith(('.tgz','.tar.gz','.tar','.zip')):
            if depth>=2:add(path,'nested-archive-depth');return
            archives+=1
            try:
                if low.endswith('.zip'):
                    with zipfile.ZipFile(io.BytesIO(data)) as z:
                        for entry in z.infolist():
                            if entry.is_dir():continue
                            if entry.file_size>128*1024*1024:add(path+'!'+entry.filename,'oversized-archive-member');continue
                            inspect(path+'!'+entry.filename,z.read(entry),depth+1)
                else:
                    with tarfile.open(fileobj=io.BytesIO(data),mode='r:*') as t:
                        for entry in t:
                            if entry.issym() or entry.islnk():add(path+'!'+entry.name,'archive-link');continue
                            if not entry.isfile():continue
                            if entry.size>128*1024*1024:add(path+'!'+entry.name,'oversized-archive-member');continue
                            inspect(path+'!'+entry.name,t.extractfile(entry).read(),depth+1)
            except (tarfile.TarError,zipfile.BadZipFile,OSError):add(path,'unreadable-archive')
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root)
        if any(part in FOLDERS for part in rel.parts):continue
        if p.is_symlink():add(str(rel),'source-symlink','review');continue
        if p.is_file():inspect(str(rel),p.read_bytes())
    output={'schemaVersion':1,'scannedFilesAndArchiveMembers':scanned,'archivesScanned':archives,'riskCount':counts['risk'],'reviewCount':counts['review'],'findings':findings,'limits':['Image pixels and spoken audio require provenance review; metadata scanning alone cannot establish content privacy.','Known-value checks depend on the supplied local configuration, credentials and private manifest.','Synthetic credential review findings are not classified as leaked real credentials.']}
    encoded=json.dumps(output,ensure_ascii=False,indent=2)+'\n'
    if args.report:args.report.write_text(encoded)
    print(encoded,end='')
    return 1 if args.fail_on_risk and counts['risk'] else 0

if __name__=='__main__':sys.exit(main())
