import { join } from 'node:path';
import { getConfigStore, dataRoot } from './lib/config.js';
import { MemoryStore } from './lib/memory.js';
import { installMemory } from './lib/memory-tools.js';
import { installMemoryLifecycle } from './lib/memory-lifecycle.js';
import { installMemoryRecall } from './lib/memory-recall.js';
import { installMemoryCompaction } from './lib/memory-compaction.js';
import { createSpeech } from './lib/speech.js';
import { registerRoutes } from './lib/routes.js';
import { installWidget } from './lib/widget.js';
import { installQQ } from './lib/qq.js';
import { createNapcatLogin } from './lib/napcat-login.js';
import { createSinging } from './lib/singing.js';
import { installSinging } from './lib/singing-tools.js';
import { createGroupConversations } from './lib/group-conversations.js';
import { createQQStickers } from './lib/qq-stickers.js';
import { installQQStickerTools, QQ_STICKER_TOOLS } from './lib/qq-sticker-tools.js';
import { currentPreset, isRoot } from './lib/session.js';
export const name='dsh-dafeiyu-dot';
export function apply(ctx,options={}) {
  const root=options.dataRoot??dataRoot();
  const config=getConfigStore(join(root,'config.json'));
  installWidget(ctx,{getConfig:()=>config.get(),assetBase:'/dsh-dafeiyu-dot/assets'});
  ctx.inject(['agents','agentPresets','tools','credentials','webServer','connection','sessionController','llm'],host=>{
    const memory=new MemoryStore(join(root,'memories.json'),{palaceRoot:options.memoryPalaceRoot??join(root,'memory-palace')});
    let reconcileTools=()=>{};
    const groupConversations=createGroupConversations(host,{config,root,palaceRoot:memory.palaceRoot,onReady:()=>reconcileTools()});
    const speech=createSpeech(host,()=>config.get());
    const singing=createSinging(host,{root,getConfig:()=>config.get()});
    const stickers=createQQStickers({localAssetRoot:join(root,'assets','stickers')});
    const qq=installQQ(host,{config,speech,singing,stickers,groupConversations,root});
    const napcatLogin=createNapcatLogin(host,config);
    installQQStickerTools(host,qq);
    reconcileTools=installMemory(host,memory,()=>config.get(),{resolveStore:agent=>groupConversations.resolveStore(agent,memory),additionalGroupTools:QQ_STICKER_TOOLS});
    const lifecycle=installMemoryLifecycle(host,memory,()=>config.get(),{acceptAgent:agent=>currentPreset(agent.session)==='whale'&&!groupConversations.isGroupSession(agent.id)});
    const recall=installMemoryRecall(host,{getConfig:()=>config.get(),resolveStore:agent=>groupConversations.resolveStore(agent,memory)});
    installMemoryCompaction(host,{checkpoint:async(agent,settings)=>{
      if(!isRoot(agent)||config.get().memory.enabled===false||!['whale','whale-group'].includes(currentPreset(agent.session)))return {enabled:false};
      return groupConversations.isGroupSession(agent.id)?groupConversations.checkpoint(agent,settings):lifecycle.checkpoint(agent,settings);
    }});
    const reconcile=async()=>{reconcileTools();recall.reconcile();await lifecycle.reconcile();await groupConversations.reconcile();};
    installSinging(host,singing,{sourceSignal:agent=>qq.signalForTurn(agent)});
    const reconcileAll=async()=>{await reconcile();await qq.reconcile();};
    registerRoutes(host,{config,memory,speech,singing,reconcile:reconcileAll,lifecycle:{...lifecycle,snapshot:()=>({...lifecycle.snapshot(),recall:recall.snapshot()})},qq,napcatLogin,cwd:options.cwd,localAssetRoot:join(root,'assets')});
    if(options.legacyMemoryRoot)host.effect(()=>{let active=true;memory.importLegacy(options.legacyMemoryRoot).catch(()=>{if(active)console.warn('dsh-dafeiyu-dot: existing memory import could not finish; source remains available.');});return ()=>{active=false;};});
  });
}
