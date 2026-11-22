const el=id=>document.getElementById(id);
const L=globalThis.MoodBoxLibrary;
const params=new URLSearchParams(location.search);
const token=params.get("token")||"";
const loadingMode=params.get("loading")==="1";
const startupError=params.get("error")||"";
const requestedMode=params.get("mode")||"";
let payload={items:[],tabId:0,pageUrl:"",pageTitle:""};
let selected=new Set();
let visibleGroups=[];
let allGroups=[];
let drawerPinned=false,drawerCloseTimer=0,messageTimer=0,hoverTimer=0,hoverGroupId="";
let typeValue="any",layoutValue="any",sizeMin=0,sizeMax=4000,sizeLimit=4000;
const chosenVariant=new Map();
const fontPreviewCache=new Map();
const verifiedTtfCache=new Map();
const objectUrls=new Set();
const pendingSaves=new Map();
const persistedFingerprints=new Set();
const savedFolderFingerprints=new Set();
const visualFingerprints=new Map();
const visualHashPromises=new Map();
let visualScanStarted=false,visualScanComplete=false;
let fontkitModulePromise=null;

const IMAGE_TYPES=new Set(["avif","bmp","gif","ico","jfif","jpg","jpeg","png","svg","svgz","tif","tiff","webp"]);
const FONT_TYPES=new Set(["woff","woff2","ttf","otf","eot"]);
const VIDEO_TYPES=new Set(["mp4","webm","mov","m4v","ogv","avi","mkv"]);
const AUDIO_TYPES=new Set(["mp3","wav","ogg","oga","m4a","aac","flac","opus"]);
const DOCUMENT_TYPES=new Set(["pdf"]);
const ANIMATION_TYPES=new Set(["json"]);
const CAPTION_TYPES=new Set(["vtt","srt"]);
const FORMAT_PRIORITY={png:100,jpg:90,jpeg:90,webp:80,avif:75,svg:70,tiff:60,tif:60,gif:50,bmp:40,ico:20,ttf:100,otf:95,woff2:90,woff:80,eot:60,mp4:100,webm:90,mov:80,m4v:75,mp3:100,wav:95,flac:90,ogg:85,m4a:80,pdf:100,json:100,vtt:100,srt:95};
const LAYOUT_LABELS={any:"Any layout",square:"Square",wide:"Wide",tall:"Tall",unknown:"Unknown"};

function safeText(v){return String(v||"").replace(/\s+/g," ").trim()}
function cleanFilename(v,fallback="asset"){return(String(v||"").split(/[\\/]/).pop().replace(/[<>:"/\\|?*\x00-\x1f]+/g,"-").replace(/[. ]+$/g,"").trim()||fallback).slice(0,180)}
function extensionFor(item){
  const named=cleanFilename(item?.filename,"").match(/\.([a-z0-9]{2,7})$/i)?.[1];
  if(named)return named.toLowerCase().replace("jpeg","jpg");
  try{const x=new URL(String(item?.url||"")).pathname.match(/\.([a-z0-9]{2,7})$/i)?.[1];if(x)return x.toLowerCase().replace("jpeg","jpg")}catch{}
  const t=String(item?.type||"").toLowerCase().replace("jpeg","jpg").replace(/[^a-z0-9]/g,"");return t||"asset";
}
function kindOf(item){const t=extensionFor(item),declared=String(item?.kind||"");if(FONT_TYPES.has(t)||declared==="font")return"font";if(t==="svg"||t==="svgz"||declared==="vector")return"vector";if(IMAGE_TYPES.has(t)||declared==="image")return"image";if(VIDEO_TYPES.has(t)||declared==="video")return"video";if(AUDIO_TYPES.has(t)||declared==="audio")return"audio";if(DOCUMENT_TYPES.has(t)||declared==="document")return"document";if(ANIMATION_TYPES.has(t)||declared==="animation")return"animation";if(CAPTION_TYPES.has(t)||declared==="caption")return"caption";return"other"}
function longestEdge(item){return Math.max(Number(item.width||0),Number(item.height||0))}
function areaOf(item){return Number(item.width||0)*Number(item.height||0)}
function layoutOf(item){const w=Number(item.width||0),h=Number(item.height||0);if(!w||!h)return"unknown";if(Math.abs(w-h)/Math.max(w,h)<.12)return"square";return w>h?"wide":"tall"}
function formatBytes(v){const b=Number(v||0);if(!b)return"";if(b<1024)return`${b} B`;if(b<1048576)return`${(b/1024).toFixed(b<10240?1:0)} KB`;return`${(b/1048576).toFixed(b<10485760?1:0)} MB`}
function setMessage(text="",error=false,hold=false){clearTimeout(messageTimer);el("message").textContent=text;el("message").className=`toolbar-message${error?" error":""}`;if(text&&!hold)messageTimer=setTimeout(()=>setMessage(""),2400)}
function pageSummary(){let host="Current page";try{host=new URL(payload.pageUrl).hostname.replace(/^www\./,"")||host}catch{}const title=safeText(payload.pageTitle);return title?`${host} · ${title}`:host}
function normalizeItem(item,index){const type=extensionFor(item);return{...item,id:String(item.id||`${index}:${item.url||item.filename||"asset"}`),type,kind:kindOf({...item,type}),order:Number.isFinite(Number(item.order))?Number(item.order):index,width:Number(item.width||0),height:Number(item.height||0),bytes:Number(item.bytes||0)}}

async function loadPayload(){
  if(startupError)throw new Error(startupError);
  if(loadingMode&&!token){const fonts=requestedMode==="fonts";setMessage(fonts?"Grabbing page fonts…":"Scanning page assets…",false,true);el("gallery").innerHTML=`<div class="empty">${fonts?"Reading font-face rules and linked stylesheets without scanning page images…":"Scanning the current page and preserving its asset order…"}</div>`;return}
  if(!token)throw new Error("Asset session is missing.");
  const key=`moodboxDownloadBatch:${token}`;
  const session=await chrome.storage.session.get(key).catch(()=>({}));
  let value=session[key];if(!value){const local=await chrome.storage.local.get(key);value=local[key]}
  if(!value)throw new Error("This asset session expired. Open MoodBox again from the source page.");
  payload=value;payload.items=(Array.isArray(payload.items)?payload.items:[]).map(normalizeItem).filter(item=>item.type!=="css"&&item.kind!=="stylesheet"&&item.kind!=="video"&&!VIDEO_TYPES.has(item.type));
  document.title=payload.assetMode==="fonts"?`MoodBox Fonts · ${safeText(payload.pageTitle)||"Current page"}`:`MoodBox · ${safeText(payload.pageTitle)||"Asset Board"}`;
  if(payload.assetMode==="fonts") el("search").placeholder="Search font family, style, weight or filename…";
  configureSizeRange();
  await L.requestPersistence().catch(()=>({}));
  const libraryItems=await L.getItems(null).catch(()=>[]);
  const tray=libraryItems.filter(item=>item.folderId===L.TRAY_ID);
  persistedFingerprints.clear();for(const item of tray)persistedFingerprints.add(item.fingerprint);
  savedFolderFingerprints.clear();for(const item of libraryItems)if(item.folderId!==L.TRAY_ID)savedFolderFingerprints.add(item.fingerprint);
  const initialGroups=buildGroups();for(const group of initialGroups)if(persistedFingerprints.has(group.id))selected.add(group.id);
  render();
  const scheduleVisualScan=()=>startVisualDuplicateScan().catch(()=>{});
  if("requestIdleCallback"in window)requestIdleCallback(scheduleVisualScan,{timeout:2200});else setTimeout(scheduleVisualScan,900);
}

function configureSizeRange(){const known=payload.items.map(longestEdge).filter(Boolean);const max=known.length?Math.max(...known):4000;sizeLimit=Math.max(1000,Math.ceil(max/250)*250);sizeMin=0;sizeMax=sizeLimit;for(const id of["sizeMin","sizeMax"]){el(id).max=String(sizeLimit);el(id).step=sizeLimit>10000?"250":sizeLimit>5000?"100":"50"}el("sizeMin").value="0";el("sizeMax").value=String(sizeLimit);updateRangeUi()}
function updateRangeUi(){const start=sizeLimit?sizeMin/sizeLimit*100:0,end=sizeLimit?sizeMax/sizeLimit*100:100;el("rangeTrack").style.setProperty("--start",`${start}%`);el("rangeTrack").style.setProperty("--end",`${end}%`);el("sizeReadout").textContent=sizeMin===0&&sizeMax===sizeLimit?"Full range":`${sizeMin.toLocaleString()}–${sizeMax.toLocaleString()} px`;el("sizeKnown").textContent=`0–${sizeLimit.toLocaleString()} px detected`}

function canonicalUrl(item){
  let raw=String(item.url||"");
  try{
    const u=new URL(raw);u.hash="";
    for(const key of[...u.searchParams.keys()])if(/^(?:w|h|width|height|size|sz|q|quality|fm|format|fit|crop|dpr|scale|auto|rect)$/i.test(key))u.searchParams.delete(key);
    u.pathname=u.pathname
      .replace(/\/(?:\d{2,5}x\d{0,5}|\d{2,5}w|w_\d{2,5}|h_\d{2,5}|small|medium|large|thumb|thumbnail|originals|max_\d+|source)\//gi,"/{variant}/")
      .replace(/(?:^|\/)(?:\d{2,4}_)?F_(?=\d+_)/i,"/{size}_F_")
      .replace(/[-_]\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i,"")
      .replace(/\.(?:avif|bmp|gif|ico|jpe?g|png|svgz?|tiff?|webp|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|pdf|css|json|vtt|srt)$/i,"");
    raw=`${u.hostname.toLowerCase()}${u.pathname.toLowerCase()}`;
  }catch{}
  return raw.toLowerCase();
}
function normalizedStem(item){return cleanFilename(item.filename,"").toLowerCase().replace(/\.(?:avif|bmp|gif|ico|jpe?g|png|svgz?|tiff?|webp|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|pdf|css|json|vtt|srt)$/i,"").replace(/^(?:\d{2,4}_)?f_(?=\d+_)/i,"").replace(/[-_]\d{2,5}x\d{2,5}$/i,"").replace(/[-_](?:small|medium|large|thumb|thumbnail|original)$/i,"").replace(/[-_][a-f0-9]{16,}$/i,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}
function stockAssetKey(item){const text=`${item.filename||""} ${item.url||""}`;const adobe=text.match(/(?:^|[\/_-])(?:\d{2,4}_)?F_(\d{6,})_/i)?.[1];if(adobe)return`adobe:${adobe}`;const shutter=text.match(/(?:-|\/)(\d{7,})(?:[-_.\/?#]|$)/)?.[1];if(/shutterstock/i.test(text)&&shutter)return`shutterstock:${shutter}`;return""}
function groupKey(item,groupFormats){
  const stockKey=stockAssetKey(item);if(stockKey)return`${item.kind}:${stockKey}${groupFormats?"":`:${item.type}`}`;
  if(item.familyKey)return`${item.kind}:${String(item.familyKey).toLowerCase()}${groupFormats?"":`:${item.type}`}`;
  if(item.kind==="font")return`font:${safeText(item.fontFamily||normalizedStem(item)||canonicalUrl(item)).toLowerCase()}:${safeText(item.fontStyle||"normal").toLowerCase()}:${safeText(item.fontWeight||"400").toLowerCase()}${groupFormats?"":`:${item.type}`}`;
  const urlKey=canonicalUrl(item),stem=normalizedStem(item);let host="";try{host=new URL(item.url).hostname}catch{}
  const key=urlKey||`${host}:${stem||item.id}`;return`${item.kind}:${key}${groupFormats?"":`:${item.type}`}`;
}
function bestVariant(variants){return[...variants].sort((a,b)=>{
  const aa=areaOf(a),ba=areaOf(b);if(aa!==ba)return ba-aa;
  const af=FORMAT_PRIORITY[a.type]||0,bf=FORMAT_PRIORITY[b.type]||0;if(af!==bf)return bf-af;
  if(a.bytes!==b.bytes)return b.bytes-a.bytes;return a.order-b.order;
})[0]}
function compactVariants(variants){
  const formats=new Map();
  for(const variant of variants){
    const key=String(variant.type||"asset").toLowerCase();
    const current=formats.get(key);
    if(!current||bestVariant([current,variant])===variant)formats.set(key,variant);
  }
  return[...formats.values()].sort((a,b)=>areaOf(b)-areaOf(a)||(FORMAT_PRIORITY[b.type]||0)-(FORMAT_PRIORITY[a.type]||0)||Number(b.bytes||0)-Number(a.bytes||0)||a.order-b.order);
}
function buildUrlGroups(){
  const consolidate=el("groupDuplicates").checked,groupFormats=el("groupFormats").checked;
  if(!consolidate)return payload.items.map(item=>({id:`single:${item.id}`,variants:[item],order:item.order}));
  const map=new Map();
  for(const item of payload.items){const key=groupKey(item,groupFormats);const group=map.get(key)||{id:key,variants:[],order:item.order};if(!group.variants.some(v=>v.url===item.url&&v.type===item.type))group.variants.push(item);group.order=Math.min(group.order,item.order);map.set(key,group)}
  for(const group of map.values())group.variants=compactVariants(group.variants);
  return[...map.values()];
}
function hashDistance(a,b){if(!a||!b)return 64;let value=BigInt(`0x${a}`)^BigInt(`0x${b}`),count=0;while(value){count+=Number(value&1n);value>>=1n}return count}
function visualMatch(a,b){
  if(!a||!b)return false;
  if(Math.abs(a.aspect-b.aspect)>.045)return false;
  if(Math.abs(a.average-b.average)>18||Math.abs(a.variance-b.variance)>32)return false;
  const distance=hashDistance(a.hash,b.hash);
  if(Math.min(a.variance,b.variance)<9)return distance===0&&Math.abs(a.average-b.average)<5;
  return distance<=5;
}
function visualFingerprintForGroup(group){for(const item of group.variants){const fp=visualFingerprints.get(item.id);if(fp)return fp}return null}
function mergeVisualGroups(groups){
  const output=[],visual=[];
  for(const group of groups){
    const representative=bestVariant(group.variants),fp=visualFingerprintForGroup(group);
    if(!fp||!(representative.kind==="image"||representative.kind==="vector")){output.push(group);continue}
    let target=null;
    for(const candidate of visual){if(visualMatch(fp,candidate.fp)){target=candidate.group;break}}
    if(!target){output.push(group);visual.push({group,fp});continue}
    if(selected.has(group.id))selected.add(target.id);
    if(savedFolderFingerprints.has(group.id)||savedFolderFingerprints.has(target.id))savedFolderFingerprints.add(target.id);
    target.order=Math.min(target.order,group.order);
    target.variants=compactVariants([...target.variants,...group.variants]);
  }
  return output;
}
function buildGroups(){
  let groups=buildUrlGroups();
  if(el("visualDuplicates")?.checked&&visualScanComplete&&el("groupDuplicates").checked)groups=mergeVisualGroups(groups);
  return groups;
}
async function bitmapFromBlob(blob){
  try{return await createImageBitmap(blob)}catch{}
  const objectUrl=URL.createObjectURL(blob);objectUrls.add(objectUrl);
  const image=new Image();image.decoding="async";image.src=objectUrl;
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error("Preview could not be decoded."))});
  return image;
}
async function fetchVisualBlob(item){
  const sourceItem={...item,url:item.previewUrl||item.url},source=await resolveDownloadUrl(sourceItem);let response=null;
  for(const credentials of["include","omit"]){try{response=await fetch(source,{cache:"force-cache",credentials});if(response.ok)break}catch{}}
  if(!response?.ok)throw new Error("Visual preview is unavailable.");const blob=await response.blob();if(!blob.size||blob.size>16*1024*1024)throw new Error("Visual preview is too large.");return blob
}
async function computeVisualFingerprint(item){
  if(visualFingerprints.has(item.id))return visualFingerprints.get(item.id);
  const key=`${item.previewUrl||item.url}|${item.width||0}x${item.height||0}`;
  if(visualHashPromises.has(key))return visualHashPromises.get(key);
  const promise=(async()=>{
    const blob=await fetchVisualBlob(item),drawable=await bitmapFromBlob(blob);
    const width=drawable.width||drawable.naturalWidth,height=drawable.height||drawable.naturalHeight;if(!width||!height)throw new Error("No visual dimensions");
    const canvas=document.createElement("canvas");canvas.width=9;canvas.height=8;const context=canvas.getContext("2d",{willReadFrequently:true});context.drawImage(drawable,0,0,9,8);drawable.close?.();
    const data=context.getImageData(0,0,9,8).data,gray=[];for(let i=0;i<data.length;i+=4)gray.push(.299*data[i]+.587*data[i+1]+.114*data[i+2]);
    let bits="";for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits+=gray[y*9+x]>gray[y*9+x+1]?"1":"0";
    let hash="";for(let i=0;i<bits.length;i+=4)hash+=Number.parseInt(bits.slice(i,i+4),2).toString(16);
    const average=gray.reduce((a,b)=>a+b,0)/gray.length,variance=Math.sqrt(gray.reduce((sum,value)=>sum+(value-average)**2,0)/gray.length);
    return{hash,average,variance,aspect:width/height};
  })().finally(()=>visualHashPromises.delete(key));
  visualHashPromises.set(key,promise);const fp=await promise;visualFingerprints.set(item.id,fp);return fp;
}
async function startVisualDuplicateScan(){
  if(visualScanStarted||!el("visualDuplicates")?.checked||!payload.items.length)return;
  visualScanStarted=true;const label=el("visualDuplicates").closest("label");label?.classList.add("hashing");
  const groups=buildUrlGroups().filter(group=>{const item=bestVariant(group.variants);return item.kind==="image"||item.kind==="vector"}).slice(0,600);
  let cursor=0,completed=0;const workers=Array.from({length:Math.min(2,groups.length)},async()=>{while(cursor<groups.length){const group=groups[cursor++],item=bestVariant(group.variants);try{await computeVisualFingerprint(item);completed++}catch{}}});
  await Promise.all(workers);visualScanComplete=true;label?.classList.remove("hashing");render();
}
function isLikelyUiAsset(item){
  const edge=longestEdge(item),text=`${item.filename||""} ${item.alt||""} ${item.source||""} ${item.url||""}`.toLowerCase();
  if(item.kind!=="image"&&item.kind!=="vector")return false;if(edge&&edge<=48)return true;
  if(/(?:favicon|apple-touch|sprite|spinner|chevron|hamburger|bullet|control|badge|avatar|emoji|loader|tracking|pixel|logo|icon)/i.test(text)&&(!edge||edge<520))return true;
  if(/(?:adobe-stock|shutterstock).*(?:logo|avatar)/i.test(text))return true;return false;
}
function isNoise(item){const edge=longestEdge(item),text=`${item.filename||""} ${item.source||""}`.toLowerCase();if(item.kind!=="image"&&item.kind!=="vector")return false;if(item.width>0&&item.height>0&&item.width<=2&&item.height<=2)return true;if(edge&&edge<28)return true;if(/(?:tracking|pixel|spacer|blank|favicon|bullet|spinner)/i.test(text)&&(!edge||edge<96))return true;return false}
function smartScore(group,item){
  const base={image:3200,vector:2700,font:2300,video:2200,audio:2050,document:1900,animation:1850,caption:1500,other:1000};
  let score=base[item.kind]||1000;
  const area=areaOf(item);if(area)score+=Math.log2(area+1)*95;else if(item.kind==="image"||item.kind==="vector")score-=260;
  if(item.width>=800&&item.height>=500)score+=500;if(item.width>=1600||item.height>=1600)score+=350;
  if(item.type==="png")score+=55;else if(item.type==="jpg")score+=45;
  if(/(?:img-current|img-src|picture-source|srcset|background-image|video-poster)/i.test(item.source||""))score+=80;
  if(/(?:page-data|network|stylesheet|page-metadata)/i.test(item.source||""))score-=35;
  if(el("deprioritizeUi").checked&&isLikelyUiAsset(item))score-=5000;
  score-=Math.min(group.order,10000)*.025;return score;
}
function pageOrderCompare(a,b){
  if(el("deprioritizeUi").checked){const au=isLikelyUiAsset(a.representative)?1:0,bu=isLikelyUiAsset(b.representative)?1:0;if(au!==bu)return au-bu}
  return Number(a.order)-Number(b.order);
}

function baseGroups(){allGroups=buildGroups();return allGroups}
function variantsForFilters(group){
  let vars=group.variants.filter(item=>{
    if(typeValue!=="any"&&item.type!==typeValue)return false;
    if(layoutValue!=="any"&&layoutOf(item)!==layoutValue)return false;
    if(el("hideNoise").checked&&isNoise(item))return false;
    const edge=longestEdge(item);if((sizeMin>0||sizeMax<sizeLimit)){if(!edge||edge<sizeMin||edge>sizeMax)return false}
    const q=safeText(el("search").value).toLowerCase();if(q&&!`${item.filename||""} ${item.url||""} ${item.alt||""} ${item.source||""} ${item.fontFamily||""}`.toLowerCase().includes(q))return false;
    return true;
  });
  return vars;
}
function filteredGroups(){
  const rows=[];
  for(const group of baseGroups()){
    const variants=variantsForFilters(group);if(!variants.length)continue;
    const chosenId=chosenVariant.get(group.id);let representative=variants.find(v=>v.id===chosenId)||bestVariant(variants);chosenVariant.set(group.id,representative.id);
    rows.push({...group,variants,representative});
  }
  const sort=el("sortSelect").value;
  rows.sort((a,b)=>sort==="largest"?areaOf(b.representative)-areaOf(a.representative)||pageOrderCompare(a,b)
    :sort==="page"?pageOrderCompare(a,b)
    :sort==="name"?String(a.representative.filename||"").localeCompare(String(b.representative.filename||""))
    :sort==="type"?String(a.representative.type).localeCompare(String(b.representative.type))||pageOrderCompare(a,b)
    :smartScore(b,b.representative)-smartScore(a,a.representative)||pageOrderCompare(a,b));
  return rows;
}

function typeCounts(groups){const counts={any:0};for(const g of groups){for(const v of g.variants){counts.any+=1;counts[v.type]=(counts[v.type]||0)+1}}return counts}
function layoutCounts(groups){const counts={any:0,square:0,wide:0,tall:0,unknown:0};for(const g of groups){for(const v of g.variants){const x=layoutOf(v);counts.any+=1;counts[x]=(counts[x]||0)+1}}return counts}
function buildMenu(kind,counts){
  const isType=kind==="type",menu=el(isType?"typeMenu":"layoutMenu"),button=el(isType?"typeButton":"layoutButton");menu.replaceChildren();
  const values=isType?["any",...Object.keys(counts).filter(x=>x!=="any").sort()]:["any","square","wide","tall","unknown"];
  const current=isType?typeValue:layoutValue;
  for(const value of values){if(typeof counts[value]==="undefined")continue;const row=document.createElement("button");row.type="button";row.dataset.value=value;row.classList.toggle("active",value===current);const label=document.createElement("span");label.textContent=isType?(value==="any"?"Any type":value.toUpperCase()):LAYOUT_LABELS[value];const count=document.createElement("small");count.textContent=String(counts[value]);row.append(label,count);row.onclick=()=>{if(isType)typeValue=value;else layoutValue=value;closeMenus();render()};menu.append(row)}
  const label=isType?(current==="any"?"Any type":current.toUpperCase()):LAYOUT_LABELS[current];button.querySelector("b").textContent=label;button.querySelector("small").textContent=String(counts[current]||0);
}
function toggleMenu(kind){const menu=el(kind==="type"?"typeMenu":"layoutMenu"),button=el(kind==="type"?"typeButton":"layoutButton");const opening=menu.hidden;closeMenus();menu.hidden=!opening;button.setAttribute("aria-expanded",opening?"true":"false")}
function closeMenus(){for(const kind of["type","layout"]){el(`${kind}Menu`).hidden=true;el(`${kind}Button`).setAttribute("aria-expanded","false")}}

function updateSelectionControls(){
  const count=selected.size;
  el("downloadSelected").disabled=count===0;el("saveSelected").disabled=count===0;el("clearSelectedTop").disabled=count===0;
  el("selectedCount").textContent=`${count} selected`;
  const allVisible=visibleGroups.length>0&&visibleGroups.every(g=>selected.has(g.id));el("selectAll").textContent=allVisible?"Clear visible":`Select all${visibleGroups.length?` (${visibleGroups.length})`:""}`;
  const format=el("downloadFormat")?.value||"original",formatLabel=format==="original"?"original":format.toUpperCase();el("downloadSelected").title=count?`Download ${count} selected asset${count===1?"":"s"} as ${formatLabel}`:`Download selected as ${formatLabel}`;
  el("saveSelected").title="Save to Moodbox Library";el("saveSelected").setAttribute("aria-label","Save to Moodbox Library");
}
function paintCardSelection(node,state){node.classList.toggle("selected",state);node.setAttribute("aria-pressed",state?"true":"false")}
async function fetchAssetBlob(item){
  const source=await resolveDownloadUrl(item);let response=null;
  for(const credentials of["include","omit"]){try{response=await fetch(source,{cache:"no-store",credentials});if(response.ok)break}catch{}}
  if(!response?.ok)throw new Error("This website blocked local saving for the selected asset.");
  const blob=await response.blob();if(!blob.size)throw new Error("The selected asset is empty.");if(blob.size>128*1024*1024)throw new Error("Assets larger than 128 MB are not saved to the local library.");return blob;
}
async function persistGroupToTray(group,node=null){
  if(persistedFingerprints.has(group.id))return L.getItemByFolderFingerprint(L.TRAY_ID,group.id);
  if(pendingSaves.has(group.id))return pendingSaves.get(group.id);
  const promise=(async()=>{node?.classList.add("persisting");const chosenId=chosenVariant.get(group.id);const item=group.variants.find(v=>v.id===chosenId)||bestVariant(group.variants);const blob=await fetchAssetBlob(item);let filename=cleanFilename(item.filename||item.fontFamily||`asset.${item.type}`);if(!/\.[a-z0-9]{2,7}$/i.test(filename)&&item.type&&item.type!=="asset")filename+=`.${item.type}`;const saved=await L.saveItem({fingerprint:group.id,filename,type:item.type,kind:item.kind,width:item.width,height:item.height,bytes:blob.size,blob,mime:blob.type||"application/octet-stream",sourceUrl:item.url,pageUrl:payload.pageUrl,pageTitle:payload.pageTitle,alt:item.alt,fontFamily:item.fontFamily,fontStyle:item.fontStyle,fontWeight:item.fontWeight,order:group.order},L.TRAY_ID);persistedFingerprints.add(group.id);return saved})().finally(()=>{pendingSaves.delete(group.id);node?.classList.remove("persisting")});
  pendingSaves.set(group.id,promise);return promise;
}
async function setCardSelected(node,group,state){
  if(state){selected.add(group.id);paintCardSelection(node,true);updateSelectionControls();try{await persistGroupToTray(group,node);setMessage("Selection saved locally") }catch(error){selected.delete(group.id);paintCardSelection(node,false);setMessage(error.message||"Could not save this selection.",true);updateSelectionControls()}}
  else{selected.delete(group.id);paintCardSelection(node,false);persistedFingerprints.delete(group.id);await L.deleteTrayFingerprints([group.id]).catch(()=>{});updateSelectionControls()}
}
function variantLabel(item){const dims=item.width&&item.height?` ${Math.round(item.width)}×${Math.round(item.height)}`:"";return`${item.type.toUpperCase()}${dims}`}
function kindLabel(item){return({image:"Image",vector:"Vector",font:"Web font",video:"Video",audio:"Audio",document:"Document",animation:"Animation",caption:"Caption",other:"Web asset"})[item.kind]||"Web asset"}
function safeFormatClass(type){return`format-${String(type||"asset").toLowerCase().replace(/[^a-z0-9_-]/g,"")}`}
function hasVisualPreview(item){
  if(item.kind==="image"||item.kind==="vector")return true;
  if(item.kind!=="video")return false;
  const preview=String(item.previewUrl||"");
  if(!preview||preview===String(item.url||""))return false;
  return /^data:image\//i.test(preview)||/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(preview);
}
const videoFrameObserver="IntersectionObserver"in window?new IntersectionObserver(entries=>{
  for(const entry of entries){
    if(!entry.isIntersecting)continue;
    videoFrameObserver.unobserve(entry.target);
    entry.target.__moodboxDownloadLoadVideo?.();
  }
},{rootMargin:"260px 0px"}):null;

function setVideoFallback(wrap,video,item){
  wrap.classList.remove("video-live-preview","video-ready","failed","video-playing");
  wrap.classList.add("file-mode","video-fallback","video-preview");
  try{video.pause();video.removeAttribute("src");video.load()}catch{}
  const filePreview=wrap.querySelector(".file-preview");
  filePreview.querySelector("strong").textContent="▶";
  filePreview.querySelector("span").textContent=`VIDEO · ${String(item.type||"video").toUpperCase()}`;
}

function attachVideoFramePreview(wrap,video,item,{keepImage=false}={}){
  let started=false,settled=false,hoverRequested=false;
  const play=async()=>{
    hoverRequested=true;
    await start();
    video.muted=true;video.playsInline=true;video.loop=true;
    try{await video.play();wrap.classList.add("video-playing")}catch{}
  };
  const pause=()=>{
    hoverRequested=false;
    try{video.pause()}catch{}
    wrap.classList.remove("video-playing");
  };
  const markReady=()=>{
    if(!settled){
      settled=true;
      wrap.classList.remove("file-mode","video-fallback","failed");
      wrap.classList.add("video-live-preview","video-ready","video-preview");
    }
    if(hoverRequested)play();else pause();
  };
  const fail=()=>{
    if(keepImage&&wrap.querySelector("img")?.getAttribute("src")){
      wrap.classList.remove("video-live-preview","video-ready","file-mode","video-fallback","failed","video-playing");
      try{video.pause();video.removeAttribute("src");video.load()}catch{}
      return;
    }
    setVideoFallback(wrap,video,item);
  };
  const start=async()=>{
    if(started)return;started=true;
    try{
      const source=await resolveDownloadUrl(item);
      video.muted=true;video.playsInline=true;video.loop=true;video.preload="metadata";
      video.onerror=fail;
      video.onloadedmetadata=()=>{
        if(!item.width&&video.videoWidth)item.width=video.videoWidth;
        if(!item.height&&video.videoHeight)item.height=video.videoHeight;
        const duration=Number(video.duration||0);
        const target=Number.isFinite(duration)&&duration>0?Math.min(1.5,Math.max(.18,duration*.08)):.18;
        try{video.currentTime=target}catch{}
      };
      video.onloadeddata=markReady;
      video.oncanplay=markReady;
      video.onseeked=markReady;
      video.src=source;
      video.load();
    }catch{fail()}
  };
  wrap.__moodboxDownloadLoadVideo=start;
  wrap.__moodboxDownloadPlayVideo=play;
  wrap.__moodboxDownloadPauseVideo=pause;
  if(videoFrameObserver)videoFrameObserver.observe(wrap);else start();
}
async function openAssetInTab(item){
  try{
    const source=await resolveDownloadUrl(item);
    if(/^https?:/i.test(source)){await chrome.tabs.create({url:source});return}
    const response=await fetch(source);
    if(!response.ok)throw new Error("Could not open this asset.");
    const objectUrl=URL.createObjectURL(await response.blob());objectUrls.add(objectUrl);
    try{await chrome.tabs.create({url:objectUrl})}catch{window.open(objectUrl,"_blank","noopener")}
  }catch(error){setMessage(error.message||"Could not open this asset.",true)}
}

function fitFontCardPreview(target){
  const preview=target?.classList?.contains("font-preview")?target:target?.querySelector?.(".font-preview");
  const label=preview?.querySelector?.("strong");
  if(!preview||!label)return;
  label.textContent="AaBb";
  label.style.fontSize="40px";
  label.style.transform="none";
  const fit=()=>{
    const available=Math.max(72,(preview.clientWidth||target?.clientWidth||220)-24);
    label.style.fontSize="40px";
    label.style.transform="none";
    const measured=Math.max(1,label.getBoundingClientRect().width);
    const size=Math.max(22,Math.min(40,Math.floor(40*available/measured)));
    label.style.fontSize=`${size}px`;
    requestAnimationFrame(()=>{
      const finalWidth=Math.max(1,label.getBoundingClientRect().width);
      label.style.transform=finalWidth>available?`scaleX(${available/finalWidth})`:"none";
    });
  };
  requestAnimationFrame(fit);
}

async function loadFontFace(item,target,hover=false){
  const url=String(item.previewUrl||item.url||"");if(!url)return;
  let promise=fontPreviewCache.get(url);
  if(!promise){promise=(async()=>{const response=await fetch(url,{cache:"force-cache",credentials:"include"});if(!response.ok)throw new Error("Font preview blocked");const blob=await response.blob();const objectUrl=URL.createObjectURL(blob);objectUrls.add(objectUrl);const family=`MoodBoxPreview-${Math.random().toString(36).slice(2)}`;const face=new FontFace(family,`url(${objectUrl})`,{style:item.fontStyle||"normal",weight:String(item.fontWeight||"400")});await face.load();document.fonts.add(face);return family})();fontPreviewCache.set(url,promise)}
  try{const family=await promise;if(hover)target.style.fontFamily=`"${family}",sans-serif`;else{target.querySelector(".font-preview").style.fontFamily=`"${family}",sans-serif`;fitFontCardPreview(target)}}catch{if(!hover)fitFontCardPreview(target)}
}
function renderCard(group){
  const item=group.representative,node=el("cardTemplate").content.firstElementChild.cloneNode(true);node.dataset.groupId=group.id;paintCardSelection(node,selected.has(group.id));
  const savedToFolder=savedFolderFingerprints.has(group.id);node.classList.toggle("saved-to-folder",savedToFolder);if(savedToFolder)node.title="Already saved to a MoodBox folder";
  const wrap=node.querySelector(".preview-wrap"),image=node.querySelector("img"),video=node.querySelector(".video-frame"),visual=hasVisualPreview(item);
  if(item.kind==="font"){
    wrap.classList.add("font-mode");image.removeAttribute("src");fitFontCardPreview(wrap);loadFontFace(item,wrap);
  }else if(item.kind==="video"){
    wrap.classList.add("video-preview");
    if(visual){
      image.src=item.previewUrl;image.alt=item.alt||item.filename||"Video";
      image.onload=()=>wrap.classList.remove("failed","file-mode","video-fallback");
      image.onerror=()=>{image.removeAttribute("src");setVideoFallback(wrap,video,item)};
      attachVideoFramePreview(wrap,video,item,{keepImage:true});
    }else{
      image.removeAttribute("src");
      setVideoFallback(wrap,video,item);
      attachVideoFramePreview(wrap,video,item);
    }
  }else if(visual){
    image.src=item.previewUrl||item.url;image.alt=item.alt||item.filename||"Asset";
    image.onload=()=>{if((item.kind==="image"||item.kind==="vector")&&(!item.width||!item.height)){item.width=image.naturalWidth;item.height=image.naturalHeight;node.querySelector(".dimensions").textContent=`${item.width}×${item.height}`}};
    image.onerror=()=>wrap.classList.add("failed");
  }else{
    wrap.classList.add("file-mode");image.removeAttribute("src");const filePreview=wrap.querySelector(".file-preview");filePreview.querySelector("strong").textContent=item.type.toUpperCase();filePreview.querySelector("span").textContent=kindLabel(item);
  }
  const filename=node.querySelector(".filename");filename.textContent=item.fontFamily||item.filename||"asset";filename.title=item.filename||item.url||"asset";
  const dimensions=node.querySelector(".dimensions");dimensions.textContent=item.kind==="font"?[safeText(item.fontStyle),safeText(item.fontWeight)].filter(Boolean).join(" ")||"Web font":item.width&&item.height?`${Math.round(item.width)}×${Math.round(item.height)}`:kindLabel(item);
  const file=node.querySelector(".filesize"),bytes=formatBytes(item.bytes);file.textContent=bytes;file.hidden=!bytes;
  const row=node.querySelector(".variant-row");
  for(const variant of compactVariants(group.variants)){
    const chip=document.createElement("button");chip.type="button";chip.className=`variant-chip ${safeFormatClass(variant.type)}${variant.id===item.id?" active":""}`;chip.textContent=variantLabel(variant);chip.title=variant.url;chip.onclick=async event=>{event.preventDefault();event.stopPropagation();chosenVariant.set(group.id,variant.id);if(selected.has(group.id)){persistedFingerprints.delete(group.id);await L.deleteTrayFingerprints([group.id]).catch(()=>{});try{await persistGroupToTray(group)}catch(error){setMessage(error.message||"Could not update the saved format.",true)}}render()};row.append(chip);
  }
  if(item.kind==="font"){
    const ttfButton=document.createElement("button");ttfButton.type="button";ttfButton.className="variant-chip font-ttf-download";ttfButton.textContent="TTF ↓";ttfButton.title="Validate, convert and download this font as TTF";ttfButton.onclick=event=>{event.preventDefault();event.stopPropagation();downloadFontGroupAsTtf(group,ttfButton)};row.append(ttfButton);
  }
  const frameButton=node.querySelector(".frame-capture");
  if(item.kind==="video")frameButton.onclick=async event=>{event.preventDefault();event.stopPropagation();node.classList.add("frame-busy");frameButton.disabled=true;try{const selectedFormat=el("downloadFormat").value,format=selectedFormat==="jpg"?"jpg":"png",blob=await captureVideoFrameBlob(item,format);await startBlobDownload(blob,filenameWithFormat(item,0,format,"-frame"));setMessage(`Video frame saved as ${format.toUpperCase()}`)}catch(error){setMessage(error.message||"Could not capture this video frame.",true)}finally{node.classList.remove("frame-busy");frameButton.disabled=false}};else frameButton.remove();
  let clickTimer=0;
  node.onclick=event=>{if(event.target.closest(".variant-chip,.frame-capture")||event.detail>1)return;clearTimeout(clickTimer);clickTimer=setTimeout(()=>setCardSelected(node,group,!selected.has(group.id)),300)};
  node.ondblclick=event=>{if(event.target.closest(".variant-chip,.frame-capture"))return;event.preventDefault();event.stopPropagation();clearTimeout(clickTimer);openAssetInTab(group.representative)};
  node.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setCardSelected(node,group,!selected.has(group.id))}};
  node.onpointerenter=()=>{if(item.kind==="video")wrap.__moodboxDownloadPlayVideo?.();else showHover(group,node)};
  node.onpointerleave=()=>{if(item.kind==="video")wrap.__moodboxDownloadPauseVideo?.();hideHover()};return node;
}

function render(){
  if(videoFrameObserver)for(const node of document.querySelectorAll(".preview-wrap"))videoFrameObserver.unobserve(node);
  hideHover();closeMenus();const rawGroups=buildGroups();buildMenu("type",typeCounts(rawGroups));buildMenu("layout",layoutCounts(rawGroups));visibleGroups=filteredGroups();
  const validIds=new Set(allGroups.map(g=>g.id));for(const id of[...selected])if(!validIds.has(id))selected.delete(id);
  const gallery=el("gallery");gallery.replaceChildren();if(!visibleGroups.length){const empty=document.createElement("div");empty.className="empty";empty.textContent="No assets match these filters.";gallery.append(empty);updateSelectionControls();return}
  const frag=document.createDocumentFragment();for(const group of visibleGroups)frag.append(renderCard(group));gallery.append(frag);updateSelectionControls();
}

function hideHover(){clearTimeout(hoverTimer);hoverGroupId="";const panel=el("hoverPreview");panel.hidden=true;panel.classList.remove("failed","font-mode","file-mode");el("hoverImage").removeAttribute("src");el("hoverFont").style.removeProperty("font-family")}
function placeHover(card){const panel=el("hoverPreview"),r=card.getBoundingClientRect(),p=panel.getBoundingClientRect(),m=14;let left=r.right+m;if(left+p.width>innerWidth-m)left=r.left-p.width-m;if(left<m)left=Math.max(m,(innerWidth-p.width)/2);let top=Math.min(Math.max(m+Number(getComputedStyle(document.documentElement).getPropertyValue("--toolbar").replace("px","")||52),r.top),innerHeight-p.height-m);panel.style.left=`${Math.round(left)}px`;panel.style.top=`${Math.round(Math.max(m,top))}px`}
function showHover(group,card){if(group?.representative?.kind==="video")return;clearTimeout(hoverTimer);hoverGroupId=group.id;hoverTimer=setTimeout(()=>{if(hoverGroupId!==group.id||!card.matches(":hover"))return;const item=group.representative,panel=el("hoverPreview");panel.hidden=false;el("hoverTitle").textContent=item.fontFamily||item.filename||"asset";el("hoverFacts").textContent=[item.type.toUpperCase(),item.kind==="font"?[item.fontStyle,item.fontWeight].filter(Boolean).join(" "):item.width&&item.height?`${item.width} × ${item.height}`:kindLabel(item),formatBytes(item.bytes)].filter(Boolean).join(" · ");if(item.kind==="font"){panel.classList.add("font-mode");loadFontFace(item,el("hoverFont"),true);requestAnimationFrame(()=>placeHover(card))}else if(hasVisualPreview(item)){const image=el("hoverImage");image.onload=()=>requestAnimationFrame(()=>placeHover(card));image.onerror=()=>{panel.classList.add("file-mode");el("hoverFile").querySelector("strong").textContent=item.kind==="video"?"▶":item.type.toUpperCase();el("hoverFile").querySelector("span").textContent=item.kind==="video"?`VIDEO · ${item.type.toUpperCase()}`:kindLabel(item)};image.src=item.previewUrl||item.url;requestAnimationFrame(()=>placeHover(card))}else{panel.classList.add("file-mode");el("hoverFile").querySelector("strong").textContent=item.kind==="video"?"▶":item.type.toUpperCase();el("hoverFile").querySelector("span").textContent=item.kind==="video"?`VIDEO · ${item.type.toUpperCase()}`:kindLabel(item);requestAnimationFrame(()=>placeHover(card))}},240)}

function setDrawer(open,{pin=drawerPinned}={}){drawerPinned=Boolean(pin);clearTimeout(drawerCloseTimer);el("filterDrawer").classList.toggle("open",Boolean(open));el("filterDrawer").setAttribute("aria-hidden",open?"false":"true");el("filterToggle").setAttribute("aria-expanded",open?"true":"false");el("drawerScrim").hidden=!open||!drawerPinned}
function scheduleDrawerClose(){clearTimeout(drawerCloseTimer);if(drawerPinned)return;drawerCloseTimer=setTimeout(()=>setDrawer(false,{pin:false}),180)}

async function resolveDownloadUrl(item){const url=String(item.url||"");if(!url.startsWith("blob:"))return url;const r=await chrome.runtime.sendMessage({action:"moodboxDownload-resolve-batch-url",tabId:payload.tabId,frameId:Number(item.frameId||0),url});if(!r?.ok||!r.url)throw new Error(r?.error||"Could not read this page asset.");return r.url}

function canvasToBlob(canvas,type,quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Conversion failed.")),type,quality))}
async function convertImageBlob(item,format){
  const blob=await fetchAssetBlob(item),drawable=await bitmapFromBlob(blob);const width=drawable.width||drawable.naturalWidth,height=drawable.height||drawable.naturalHeight;if(!width||!height)throw new Error("Image dimensions are unavailable.");
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const context=canvas.getContext("2d",{alpha:format!=="jpg"});if(format==="jpg"){context.fillStyle="#fff";context.fillRect(0,0,width,height)}context.drawImage(drawable,0,0,width,height);drawable.close?.();return canvasToBlob(canvas,format==="jpg"?"image/jpeg":"image/png",.94)
}
async function captureVideoFrameBlob(item,format="png"){
  const blob=await fetchAssetBlob(item),objectUrl=URL.createObjectURL(blob);objectUrls.add(objectUrl);const video=document.createElement("video");video.muted=true;video.playsInline=true;video.preload="auto";video.src=objectUrl;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Video frame timed out.")),20000);video.onloadedmetadata=()=>{const duration=Number(video.duration||0),target=Number.isFinite(duration)&&duration>0?Math.min(2,Math.max(.2,duration*.1)):.2;try{video.currentTime=target}catch{}if(video.readyState>=2){clearTimeout(timer);resolve()}};video.onseeked=()=>{clearTimeout(timer);resolve()};video.onloadeddata=()=>{if(!Number.isFinite(video.duration)||video.duration<=0){clearTimeout(timer);resolve()}};video.onerror=()=>{clearTimeout(timer);reject(new Error("Video frame could not be decoded."))};video.load()});
  const width=video.videoWidth||item.width,height=video.videoHeight||item.height;if(!width||!height)throw new Error("Video dimensions are unavailable.");const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const context=canvas.getContext("2d",{alpha:format!=="jpg"});if(format==="jpg"){context.fillStyle="#000";context.fillRect(0,0,width,height)}context.drawImage(video,0,0,width,height);video.pause();return canvasToBlob(canvas,format==="jpg"?"image/jpeg":"image/png",.94)
}
function sfntTag(view,offset){return String.fromCharCode(view.getUint8(offset),view.getUint8(offset+1),view.getUint8(offset+2),view.getUint8(offset+3))}
function parseSfntTables(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint16(4),tables=new Map();for(let i=0;i<count;i++){const p=12+i*16,tag=sfntTag(view,p),offset=view.getUint32(p+8),length=view.getUint32(p+12);if(offset+length<=bytes.length)tables.set(tag,bytes.slice(offset,offset+length))}return tables}
function tableChecksum(bytes){let sum=0;for(let i=0;i<bytes.length;i+=4){const word=((bytes[i]||0)<<24)|((bytes[i+1]||0)<<16)|((bytes[i+2]||0)<<8)|(bytes[i+3]||0);sum=(sum+(word>>>0))>>>0}return sum>>>0}
function buildSfnt(tables){
  const rows=[...tables.entries()].filter(([,data])=>data?.length).sort((a,b)=>a[0].localeCompare(b[0]));const num=rows.length,maxPow=2**Math.floor(Math.log2(Math.max(1,num))),searchRange=maxPow*16,entrySelector=Math.log2(maxPow),rangeShift=num*16-searchRange;let offset=12+num*16;const records=[];for(const [tag,input] of rows){const data=new Uint8Array(input);if(tag==="head"&&data.length>=12)new DataView(data.buffer,data.byteOffset,data.byteLength).setUint32(8,0);const aligned=(data.length+3)&~3;records.push({tag,data,offset,length:data.length,checksum:tableChecksum(data)});offset+=aligned}
  const out=new Uint8Array(offset),view=new DataView(out.buffer);view.setUint32(0,0x00010000);view.setUint16(4,num);view.setUint16(6,searchRange);view.setUint16(8,entrySelector);view.setUint16(10,rangeShift);records.forEach((row,index)=>{const p=12+index*16;for(let i=0;i<4;i++)view.setUint8(p+i,row.tag.charCodeAt(i)||32);view.setUint32(p+4,row.checksum);view.setUint32(p+8,row.offset);view.setUint32(p+12,row.length);out.set(row.data,row.offset)});const head=records.find(row=>row.tag==="head");if(head){const adjustment=(0xB1B0AFBA-tableChecksum(out))>>>0;view.setUint32(head.offset+8,adjustment)}return out
}
async function loadFontkit(){if(!fontkitModulePromise)fontkitModulePromise=import(chrome.runtime.getURL("fontkit-browser.mjs"));return fontkitModulePromise}
function fontSignature(bytes){if(!bytes||bytes.length<4)return"";return String.fromCharCode(bytes[0],bytes[1],bytes[2],bytes[3])}
function isTrueTypeSfnt(bytes){return Boolean(bytes&&bytes.length>=4&&((bytes[0]===0&&bytes[1]===1&&bytes[2]===0&&bytes[3]===0)||fontSignature(bytes)==="true"))}
function fontCacheKey(item){return`${item?.type||"font"}|${item?.url||item?.previewUrl||item?.filename||item?.id||""}`}
async function exactWoff1ToTtf(sourceBlob){
  const bytes=new Uint8Array(await sourceBlob.arrayBuffer()),fontkit=await loadFontkit(),font=fontkit.create(bytes);
  if(font.type!=="WOFF")throw new Error("This font is not a WOFF file.");
  if(!font.directory?.tables?.glyf||font.directory?.tables?.["CFF "]||font.directory?.tables?.CFF2)throw new Error("This font uses CFF outlines, so an exact TTF conversion is unavailable.");
  const tables=new Map();
  for(const [tag,entry] of Object.entries(font.directory.tables||{})){
    if(!entry||Number(entry.length||0)<=0)continue;
    try{const stream=font._getTableStream(tag);if(!stream)continue;const raw=new Uint8Array(stream.readBuffer(entry.length));if(raw.length===entry.length)tables.set(tag,raw)}catch{}
  }
  if(!tables.has("glyf")||!tables.has("loca"))throw new Error("The WOFF file does not contain complete TrueType outlines.");
  return new Blob([buildSfnt(tables)],{type:"font/ttf"});
}
async function validateTtfBlob(blob,sourceBlob=null){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  if(!isTrueTypeSfnt(bytes))throw new Error("The converted file is not a valid TrueType font.");
  let tables;try{tables=parseSfntTables(bytes)}catch{throw new Error("The converted TTF table directory is invalid.")}
  for(const tag of["head","hhea","maxp","hmtx","cmap","name","glyf","loca"])if(!tables.has(tag))throw new Error(`The converted TTF is missing its ${tag} table.`);
  const fontkit=await loadFontkit();let output;
  try{output=fontkit.create(bytes)}catch{throw new Error("The converted TTF could not be parsed after conversion.")}
  if(!output.directory?.tables?.glyf||Number(output.numGlyphs||0)<1)throw new Error("The converted TTF has no usable glyph outlines.");
  if(sourceBlob){
    try{
      const source=fontkit.create(new Uint8Array(await sourceBlob.arrayBuffer()));
      if(Number(source.numGlyphs||0)!==Number(output.numGlyphs||0))throw new Error("Glyph count changed during conversion.");
      const sourceChars=Array.isArray(source.characterSet)?source.characterSet:[];
      const outputChars=Array.isArray(output.characterSet)?output.characterSet:[];
      if(sourceChars.length&&outputChars.length&&sourceChars.length!==outputChars.length)throw new Error("Character coverage changed during conversion.");
      const sourceFamily=String(source.familyName||"").trim().toLowerCase(),outputFamily=String(output.familyName||"").trim().toLowerCase();
      if(sourceFamily&&outputFamily&&sourceFamily!==outputFamily)throw new Error("Font family metadata changed during conversion.");
    }catch(error){if(/changed during conversion/i.test(String(error?.message||"")))throw error}
  }
  return blob;
}
async function convertFontBlobToTtf(item){
  const sourceBlob=await fetchAssetBlob(item),sourceBytes=new Uint8Array(await sourceBlob.slice(0,4).arrayBuffer()),signature=fontSignature(sourceBytes);
  if(isTrueTypeSfnt(sourceBytes))return validateTtfBlob(sourceBlob);
  if(signature==="OTTO")throw new Error("This is an OpenType/CFF font; changing only the extension would not create a genuine TTF.");
  if(signature==="wOFF")return validateTtfBlob(await exactWoff1ToTtf(sourceBlob),sourceBlob);
  const fontkit=await loadFontkit(),fullBytes=new Uint8Array(await sourceBlob.arrayBuffer()),font=fontkit.create(fullBytes);
  if(!font.directory?.tables?.glyf)throw new Error("This webfont uses CFF/CFF2 outlines; genuine TTF conversion is unavailable.");
  if(font.directory?.tables?.fvar||font.directory?.tables?.gvar||font.directory?.tables?.CFF2)throw new Error("This is a variable webfont. A 100% faithful variable TTF cannot be rebuilt safely; keep its original WOFF2 file.");
  const subset=font.createSubset();subset._addGlyph=function(gid){
    const glyph=this.font.getGlyph(gid);let path;try{path=glyph.path}catch{path={commands:[],bbox:{minX:0,minY:0,maxX:0,maxY:0}}}
    let encoded;try{encoded=this.glyphEncoder.encodeSimple(path,[])}catch{encoded=this.glyphEncoder.encodeSimple({commands:[],bbox:{minX:0,minY:0,maxX:0,maxY:0}},[])}
    const metrics=this.font.hmtx.metrics,bearings=this.font.hmtx.bearings,last=metrics.get(metrics.length-1);let advance=last.advance,bearing=0;if(gid<metrics.length){const row=metrics.get(gid);advance=row.advance;bearing=row.bearing}else if(gid-metrics.length<bearings.length){bearing=bearings.get(gid-metrics.length)}
    this.glyf.push(encoded);this.loca.offsets.push(this.offset);this.hmtx.metrics.push({advance,bearing});this.offset+=encoded.length;return this.glyf.length-1
  };for(let i=0;i<font.numGlyphs;i++)subset.includeGlyph(i);
  let core;try{core=new Uint8Array(subset.encode())}catch(error){throw new Error(`TTF outline conversion failed: ${error.message||"unknown error"}`)}if(!isTrueTypeSfnt(core))throw new Error("The converted TTF structure is invalid.");
  const tables=parseSfntTables(core);font._decompress?.();for(const tag of["cmap","name","OS/2","post","gasp","kern","GDEF","GPOS","GSUB","BASE","JSTF","MATH","COLR","CPAL","SVG "]){const entry=font.directory.tables[tag];if(!entry||entry.transformed||entry.length<=0)continue;try{const stream=font._getTableStream(tag),pos=stream.pos,raw=new Uint8Array(stream.readBuffer(entry.length));stream.pos=pos;tables.set(tag,raw)}catch{}}
  return validateTtfBlob(new Blob([buildSfnt(tables)],{type:"font/ttf"}),sourceBlob)
}
async function verifiedTtfForItem(item){
  const key=fontCacheKey(item);let promise=verifiedTtfCache.get(key);
  if(!promise){promise=(async()=>{const blob=await convertFontBlobToTtf(item);return{blob,sourceType:String(item.type||"font").toUpperCase()}})().catch(error=>{verifiedTtfCache.delete(key);throw error});verifiedTtfCache.set(key,promise)}
  return promise
}
async function downloadFontGroupAsTtf(group,button){
  const item=chosenItemForGroup(group,"ttf"),family=safeText(item.fontFamily||item.filename||"Font");
  const originalText=button.textContent;button.disabled=true;button.classList.add("busy");button.textContent="Checking…";
  try{const{blob}=await verifiedTtfForItem(item);button.textContent="TTF ✓";await startBlobDownload(blob,filenameWithFormat(item,0,"ttf"));setMessage(`${family} downloaded as a verified TTF`);setTimeout(()=>{if(button.isConnected){button.textContent="TTF ↓";button.disabled=false;button.classList.remove("busy")}},1400)}
  catch(error){button.textContent="Original only";button.classList.remove("busy");button.classList.add("unavailable");button.title=error.message||"Verified TTF conversion is unavailable for this font.";setMessage(button.title,true)}
}
function filenameWithFormat(item,index,format,suffix=""){const original=cleanFilename(item.filename||item.fontFamily,`asset-${index+1}.${item.type}`),match=original.match(/\.([a-z0-9]{2,7})$/i),stem=match?original.slice(0,-(match[1].length+1)):original;return`MoodBox Downloads/${cleanFilename(`${stem}${suffix}`,`asset-${index+1}`)}.${format}`}
async function startBlobDownload(blob,filename){const url=URL.createObjectURL(blob);objectUrls.add(url);const reservation=await reserveFilename(filename);try{const id=await chrome.downloads.download({url,filename,saveAs:false,conflictAction:"uniquify"});if(!Number.isInteger(id))throw new Error("Download did not start.");setTimeout(()=>{URL.revokeObjectURL(url);objectUrls.delete(url)},30000)}catch(error){await cancelReserve(reservation);throw error}}
function chosenItemForGroup(group,format){const chosen=group.variants.find(v=>v.id===chosenVariant.get(group.id));if(format==="ttf")return group.variants.find(v=>v.type==="ttf")||group.variants.find(v=>v.type==="woff2")||group.variants.find(v=>v.type==="woff")||chosen||bestVariant(group.variants);return chosen||bestVariant(group.variants)}
async function downloadGroupAs(group,index,format){const item=chosenItemForGroup(group,format);if(format==="original"){await startFileDownload(item,index);return"started"}if(format==="jpg"||format==="png"){if(item.kind==="video"){const blob=await captureVideoFrameBlob(item,format);await startBlobDownload(blob,filenameWithFormat(item,index,format,"-frame"));return"started"}if(item.kind!=="image"&&item.kind!=="vector")return"skipped";const blob=await convertImageBlob(item,format);await startBlobDownload(blob,filenameWithFormat(item,index,format));return"started"}if(format==="ttf"){if(item.kind!=="font")return"skipped";const{blob}=await verifiedTtfForItem(item);await startBlobDownload(blob,filenameWithFormat(item,index,"ttf"));return"started"}return"skipped"}
function outputFilename(item,index){return filenameWithFormat(item,index,item.type||"asset")}
async function reserveFilename(filename){const r=await chrome.runtime.sendMessage({action:"moodboxDownload-reserve-filename",filename});return r?.token||""}
async function cancelReserve(token){if(token)await chrome.runtime.sendMessage({action:"moodboxDownload-cancel-reserved-filename",token}).catch(()=>{})}
async function startFileDownload(item,index){const url=await resolveDownloadUrl(item),filename=outputFilename(item,index),reservation=await reserveFilename(filename);try{const id=await chrome.downloads.download({url,filename,saveAs:false,conflictAction:"uniquify"});if(!Number.isInteger(id))throw new Error("Download did not start.")}catch(error){await cancelReserve(reservation);throw error}}
async function downloadGroup(group,index){const chosenId=chosenVariant.get(group.id);const item=group.variants.find(v=>v.id===chosenId)||bestVariant(group.variants);await startFileDownload(item,index)}

el("typeButton").onclick=()=>toggleMenu("type");el("layoutButton").onclick=()=>toggleMenu("layout");document.addEventListener("click",event=>{if(!event.target.closest(".menu-select"))closeMenus()});
el("search").oninput=render;el("sortSelect").onchange=render;for(const id of["groupDuplicates","groupFormats","hideNoise","deprioritizeUi"])el(id).onchange=render;el("visualDuplicates").onchange=()=>{if(el("visualDuplicates").checked&&!visualScanComplete){visualScanStarted=false;startVisualDuplicateScan()}render()};el("downloadFormat").onchange=updateSelectionControls;
function onRange(){let a=Number(el("sizeMin").value),b=Number(el("sizeMax").value);if(a>b){if(this===el("sizeMin"))a=b;else b=a}sizeMin=a;sizeMax=b;el("sizeMin").value=String(a);el("sizeMax").value=String(b);updateRangeUi();render()}
el("sizeMin").oninput=onRange;el("sizeMax").oninput=onRange;
el("selectAll").onclick=async()=>{const all=visibleGroups.length&&visibleGroups.every(g=>selected.has(g.id));if(all){const ids=visibleGroups.map(g=>g.id);for(const id of ids){selected.delete(id);persistedFingerprints.delete(id)}await L.deleteTrayFingerprints(ids).catch(()=>{});render();return}for(const group of visibleGroups)selected.add(group.id);render();setMessage(`Saving ${visibleGroups.length} visible assets locally…`,false,true);for(const group of visibleGroups){if(persistedFingerprints.has(group.id))continue;try{await persistGroupToTray(group)}catch(error){selected.delete(group.id);setMessage(error.message||"Some assets could not be saved.",true,true)}}render();setMessage(`${selected.size} asset${selected.size===1?"":"s"} selected and saved safely`)};
async function clearCurrentSelection(){selected.clear();persistedFingerprints.clear();await L.clearFolder(L.TRAY_ID).catch(()=>{});render();setMessage("Selection cleared")}
el("clearSelection").onclick=clearCurrentSelection;el("clearSelectedTop").onclick=clearCurrentSelection;
el("resetFilters").onclick=()=>{el("search").value="";typeValue="any";layoutValue="any";el("sortSelect").value="page";el("groupDuplicates").checked=true;el("visualDuplicates").checked=true;el("groupFormats").checked=true;el("hideNoise").checked=true;el("deprioritizeUi").checked=true;sizeMin=0;sizeMax=sizeLimit;el("sizeMin").value="0";el("sizeMax").value=String(sizeLimit);chosenVariant.clear();updateRangeUi();render()};
el("filterToggle").onclick=()=>setDrawer(!el("filterDrawer").classList.contains("open"),{pin:!drawerPinned});el("drawerClose").onclick=()=>setDrawer(false,{pin:false});el("drawerScrim").onclick=()=>setDrawer(false,{pin:false});el("drawerHotspot").onpointerenter=()=>setDrawer(true,{pin:false});el("filterDrawer").onpointerenter=()=>clearTimeout(drawerCloseTimer);el("filterDrawer").onpointerleave=scheduleDrawerClose;
window.addEventListener("keydown",e=>{if(e.key==="/"&&!/^(?:INPUT|TEXTAREA|SELECT)$/i.test(document.activeElement?.tagName||"")){e.preventDefault();el("search").focus()}if(e.key==="Escape"){closeMenus();if(el("filterDrawer").classList.contains("open"))setDrawer(false,{pin:false})}});window.addEventListener("blur",hideHover);window.addEventListener("scroll",hideHover,{passive:true});

async function runDownloadPool(groups,format,limit=4){let cursor=0,started=0,skipped=0,failed=0;const workers=Array.from({length:Math.max(1,Math.min(limit,groups.length))},async()=>{while(cursor<groups.length){const index=cursor++;try{const status=await downloadGroupAs(groups[index],index,format);if(status==="started")started++;else skipped++}catch(error){failed++;console.warn("MoodBox conversion failed",error)}setMessage(`${started} started${skipped?` · ${skipped} incompatible`:""}${failed?` · ${failed} failed`:""} · ${Math.max(0,groups.length-started-skipped-failed)} remaining`,Boolean(failed),true)}});await Promise.all(workers);return{started,skipped,failed}}

el("downloadSelected").onclick=async()=>{const groups=allGroups.filter(g=>selected.has(g.id)).sort((a,b)=>Number(a.order)-Number(b.order));if(!groups.length)return;const format=el("downloadFormat").value,label=format==="original"?"original files":format.toUpperCase();el("downloadSelected").disabled=true;setMessage(`Preparing ${groups.length} selected asset${groups.length===1?"":"s"} as ${label}…`,false,true);const{started,skipped,failed}=await runDownloadPool(groups,format,4);const parts=[`${started} downloaded`];if(skipped)parts.push(`${skipped} incompatible`);if(failed)parts.push(`${failed} failed`);setMessage(parts.join(" · "),Boolean(failed));updateSelectionControls()};

async function openFolderDialog(){
  const folders=await L.getFolders();const summary=await L.summary();const box=el("folderChoices");box.replaceChildren();box.hidden=false;
  const noFolder=document.createElement("button");noFolder.type="button";const noName=document.createElement("span");noName.textContent="No Folder";const noCount=document.createElement("small");noCount.textContent=String(summary.counts.get(L.NO_FOLDER_ID)||0);noFolder.append(noName,noCount);noFolder.onclick=()=>saveSelectionToFolder(L.NO_FOLDER_ID);box.append(noFolder);
  for(const folder of folders){const button=document.createElement("button");button.type="button";const name=document.createElement("span");name.textContent=folder.name;const count=document.createElement("small");count.textContent=String(summary.counts.get(folder.id)||0);button.append(name,count);button.onclick=()=>saveSelectionToFolder(folder.id);box.append(button)}
  el("folderDialogStatus").textContent=`${selected.size} selected`;el("newFolderName").value="";el("folderDialog").showModal();
}
async function ensureSelectedSaved(){for(const group of allGroups.filter(g=>selected.has(g.id))){if(pendingSaves.has(group.id))await pendingSaves.get(group.id);else if(!persistedFingerprints.has(group.id))await persistGroupToTray(group)}}
async function saveSelectionToFolder(folderId){
  if(!selected.size)return;const fingerprints=[...selected];el("folderDialogStatus").textContent="Saving local files…";
  try{await ensureSelectedSaved();const result=await L.moveTrayFingerprintsToFolder(fingerprints,folderId);for(const id of fingerprints){persistedFingerprints.delete(id);savedFolderFingerprints.add(id)}selected.clear();el("folderDialog").close();render();const folder=await L.getFolder(folderId);const destination=folder?.name || (String(folderId)===L.NO_FOLDER_ID ? "No Folder" : "folder");setMessage(`${result.moved+result.merged} asset${result.moved+result.merged===1?"":"s"} saved to ${destination}`)}catch(error){el("folderDialogStatus").textContent=error.message||"Could not save this folder."}
}
el("saveSelected").title="Save to Moodbox Library";el("saveSelected").setAttribute("aria-label","Save to Moodbox Library");el("saveSelected").onclick=()=>openFolderDialog().catch(error=>setMessage(error.message||"Could not open folders.",true));
el("openLibrary").onclick=()=>chrome.runtime.openOptionsPage().catch(()=>{});
el("createAndSave").onclick=async()=>{try{const folder=await L.createFolder(el("newFolderName").value);await saveSelectionToFolder(folder.id)}catch(error){el("folderDialogStatus").textContent=error.message||"Could not create folder."}};
el("newFolderName").onkeydown=event=>{if(event.key==="Enter"){event.preventDefault();el("createAndSave").click()}};
el("folderForm").onsubmit=event=>{event.preventDefault();if(event.submitter?.value==="cancel")el("folderDialog").close()};


let fontPreviewResizeTimer=0;
window.addEventListener("resize",()=>{clearTimeout(fontPreviewResizeTimer);fontPreviewResizeTimer=setTimeout(()=>document.querySelectorAll(".preview-wrap.font-mode").forEach(fitFontCardPreview),100)});

loadPayload().catch(error=>{setMessage(error.message||"Could not load this asset session.",true,true);el("gallery").innerHTML='<div class="empty">Open MoodBox again from a normal website tab.</div>'});
window.addEventListener("unload",()=>{for(const url of objectUrls)URL.revokeObjectURL(url)});
