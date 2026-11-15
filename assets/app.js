

// ── Splash dismiss ──
setTimeout(()=>{let s=document.getElementById('splash');if(s){s.style.opacity='0';setTimeout(()=>s.remove(),400);}},1100);
// ── Data ──
let female=true,selectMode=false,arrangeMode=false,arrangeItems=[],_findMode=false,_bookmarkFilter=false;let selected=new Set();let searchTerm='';let saveTimer=null;
let _rangeAnchor=null,_rangeSelect=false,_rangeShown=null;
let _deleteStack=[];
let bookmarked;try{bookmarked=new Set(JSON.parse(localStorage.getItem('phuc_bm')||'[]').map(function(x){return String(x);}));}catch(e){bookmarked=new Set();}
let data=[];
try{data=JSON.parse(localStorage.getItem('twv10')||'[]');}catch(e){data=[];}
// Default vocab if empty
if(data.length===0){
  if(typeof DEFAULT_DATA!=='undefined'){
    data=DEFAULT_DATA.map(function(item,i){
      return {id:Date.now()+i,h:item.h,p:item.p,m:item.m,bm:0,cor:0,wro:0};
    });
  }else{
    data=[{id:Date.now(),h:'你好',p:'nǐ hǎo',m:'xin chào',bm:0,cor:0,wro:0}];
  }
  save();
}
// ── IndexedDB Offline Cache + Sync Map ──
let _idb=null;
let _idbCache=new Map(); // sync cache cho audio blobs
function _openIDB(){
  return new Promise((resolve,reject)=>{
    if(_idb){resolve(_idb);return;}
    let req=indexedDB.open('phucVocabDB',1);
    req.onupgradeneeded=e=>{
      let db=e.target.result;
      if(!db.objectStoreNames.contains('vocab'))db.createObjectStore('vocab',{keyPath:'id',autoIncrement:true});
      if(!db.objectStoreNames.contains('audio'))db.createObjectStore('audio');
    };
    req.onsuccess=e=>{_idb=e.target.result;resolve(_idb);};
    req.onerror=e=>reject(e.target.error);
  });
}
function _syncToIDB(){
  _openIDB().then(db=>{
    let tx=db.transaction(['vocab'],'readwrite');
    let store=tx.objectStore('vocab');
    store.clear();
    data.forEach(r=>store.put(r));
  }).catch(e=>console.warn('IDB sync fail:',e));
}
function _loadFromIDB(){
  return _openIDB().then(db=>{
    return new Promise((resolve,reject)=>{
      let tx=db.transaction(['vocab'],'readonly');
      let req=tx.objectStore('vocab').getAll();
      req.onsuccess=()=>resolve(req.result||[]);
      req.onerror=()=>reject(req.error);
    });
  });
}
// Try IDB first if localStorage empty
(function(){
  if(data.length===0){
    _loadFromIDB().then(rows=>{
      if(rows.length>0){
        data=rows;
        localStorage.setItem('twv10',JSON.stringify(data));
        render();
        toast('Đã khôi phục '+rows.length+' từ từ cache');
      }
    }).catch(e=>{
      console.warn('IDB load fail:',e);
      if(localStorage.getItem('twv10')){
        try{
          data=JSON.parse(localStorage.getItem('twv10')||'[]');
          if(data.length>0){render();toast('⚠ Dữ liệu từ localStorage (IDB lỗi)');}
        }catch(e2){console.error('Both IDB and localStorage failed',e2);}
      }
    });
  }
})();
// Dọn dẹp corrupt blob trong IDB audio cache
function _purgeCorruptAudioIDB(){
  _openIDB().then(db=>{
    try {
      const tx=db.transaction(['audio'],'readwrite');
      const store=tx.objectStore('audio');
      const req=store.openCursor();
      req.onsuccess=e=>{
        const cursor=e.target.result;
        if(cursor){
          const val=cursor.value;
          if(!val || val.size < 500){
            cursor.delete();
          }
          cursor.continue();
        }
      };
    } catch(e){}
  }).catch(()=>{});
}
setTimeout(_purgeCorruptAudioIDB, 2000);
// Ensure unique IDs — fix duplicates from imports
var _seen={},_ts=Date.now();
data.forEach(function(r,i){
  if(!r.id||_seen[r.id]){r.id=_ts+i+Math.random();}
  _seen[r.id]=true;
});

// ── Helpers ──
const $=id=>document.getElementById(id);
function norm(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();}
function _selKey(id,idx){return idx!==undefined?id+'|'+idx:String(id);}
function _selBaseId(key){var p=String(key).indexOf('|');return p!==-1?key.substring(0,p):String(key);}
function _selUniqueIds(){var ids=new Set();selected.forEach(function(k){ids.add(_selBaseId(k));});return ids;}
function _selHasBase(id){var ids=_selUniqueIds();return ids.has(String(id));}
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);}
// ── TTS: Web Speech first (non-iOS), Edge Audio primary (iOS) ──
let _voiceMale=false,_lastWord='',_lastRow=null,_edgeCache={},_speakEl=null,_wsTimeout=null;
let _isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent);
let _blobURLs=new Set(); // Track blob URLs for cleanup
let _fetchControllers=new Map(); // Track fetch abort controllers
// ── Offline indicator ──
window.addEventListener('online',()=>{document.body.classList.remove('offline');toast('✓ Đã có mạng');});
window.addEventListener('offline',()=>{document.body.classList.add('offline');toast('⚠️ Mất mạng - TTS không khả dụng');});
function _preloadEdge(t,rate,trackProgress){
  // ── Auto-slow 4+ Hanzi ──
  if(!rate){
    var _hz=(t.match(/[\u4e00-\u9fff]/g)||[]).length;
    if(_hz>=4)rate='-25%';
    else if(_hz===3)rate='-15%';
  }
  let variants=t.split('/').map(s=>s.trim()).filter(Boolean);
  variants.forEach(variant=>{
    if(!variant)return;
    let r=rate||'';
    ['f','m'].forEach(v=>{
      let k=variant+v+r;
      
      // Đã có trong cache → skip
      if(_edgeCache[k] && _edgeCache[k]._cached){
        return;
      }
      // Check IDB sync trước
      if(_idbCache.has(k)){
        return;
      }
      
      // Check IDB async
      _openIDB().then(db=>{
        const tx=db.transaction(['audio'],'readonly');
        const req=tx.objectStore('audio').get(k);
        req.onsuccess=()=>{
          if(req.result && req.result.size >= 500){
            _idbCache.set(k,req.result);
          }else{
            if(req.result){
              _idbCache.delete(k);
              try {
                const txdel=db.transaction(['audio'],'readwrite');
                txdel.objectStore('audio').delete(k);
              }catch(e){}
            }
            // Fetch mới với timeout
            const controller=new AbortController();
            const timeoutId=setTimeout(()=>controller.abort(),10000);
            fetch('/tts?text='+encodeURIComponent(variant)+'&voice='+v+(r?'&rate='+encodeURIComponent(r):''),{signal:controller.signal})
              .then(res=>{
                if(!res.ok) throw new Error('HTTP '+res.status);
                return res.blob();
              })
              .then(blob=>{
                clearTimeout(timeoutId);
                if(!blob||blob.size<500)return; // Skip empty/corrupt audio
                _idbCache.set(k,blob);
                // Tạo Audio trong _edgeCache để fast path
                const url=URL.createObjectURL(blob);
                const a=new Audio();
                a.onended=()=>{if(a._blobURL){URL.revokeObjectURL(a._blobURL);_blobURLs.delete(a._blobURL);a._blobURL=null;}};
                a.src=url;
                a._blobURL=url;_blobURLs.add(url);
                a._cached=true;
                a._lastUsed=Date.now();
                _edgeCache[k]=a;
                _trackCacheSize();
                const txw=db.transaction(['audio'],'readwrite');
                txw.objectStore('audio').put(blob,k);
              })
              .catch(e=>{
                clearTimeout(timeoutId);
                if(e.name!=='AbortError')console.warn('Preload fail:',k,e);
              });
          }
        };
        req.onerror=()=>console.warn('IDB read fail:',k);
      }).catch(e=>console.warn('IDB preload fail:',e));
    });
  });
}
function speak(t,el,forceVoice,rate){
  // ── Auto-slow 4+ Hanzi ──
  if(!rate){
    var _hz=(t.match(/[\u4e00-\u9fff]/g)||[]).length;
    if(_hz>=4)rate='-25%';
    else if(_hz===3)rate='-15%';
  }
  // ── Voice ──
  if(forceVoice==='m'||forceVoice==='f'){
    _voiceMale=forceVoice==='m';_lastWord=t;_lastRow=el;
  }else{
    // Dòng khác hoặc từ khác → reset về nữ
    if(el!==_lastRow || t!==_lastWord){
      _voiceMale=false;_lastWord=t;_lastRow=el;
    }
    // Cùng dòng + cùng từ → đảo giọng
    else{_voiceMale=!_voiceMale;}
  }
  // Chỉ lấy biến thể đầu nếu có dấu /
  t=t.split('/')[0].trim();
  let v=_voiceMale?'m':'f', k=t+v+(rate||'');
  
  // ── Cleanup ──
  if(!_isIOS)speechSynthesis.cancel();
  if(_speakEl)_speakEl.classList.remove('speaking');
  _speakEl=el||null;
  if(_speakEl)_speakEl.classList.add('speaking');
  clearTimeout(_wsTimeout);

  // ── Check Edge cache ──
  let a=_edgeCache[k];
  
  // Nếu Edge đã sẵn sàng → phát ngay, không dùng Web Speech
  if(a && a.readyState>=2 && a._cached){
    a._lastUsed=Date.now();
    a.currentTime=0;
    a.play().catch(()=>{}).finally(()=>{
      if(_speakEl)_speakEl.classList.remove('speaking');
    });
    return;
  }

  // ── Edge chưa sẵn sàng → đợi 600ms rồi fallback Web Speech ──
  let edgePlayed=false, _wsStarted=false;
  
  // Timeout 600ms cho Web Speech fallback
  _wsTimeout=setTimeout(()=>{
    if(!edgePlayed){_wsStarted=true;_wsSpeak(t,rate);}
  },600);
  
  // Bắt đầu tải Edge TTS
  if(!a){
    // Tạo Audio mới
    a=new Audio();
    a.onended=()=>{
      if(_speakEl)_speakEl.classList.remove('speaking');
      if(a._blobURL){URL.revokeObjectURL(a._blobURL);_blobURLs.delete(a._blobURL);a._blobURL=null;}
    };
    _edgeCache[k]=a;
    _trackCacheSize();
    
    // Khi Edge sẵn sàng → phát, trừ khi Web Speech đã chạy
    const playEdge=()=>{
      if(edgePlayed)return;
      edgePlayed=true;
      clearTimeout(_wsTimeout);
      // Nếu Web Speech đã chạy → để phát hết, Edge để dành lượt sau
      if(_wsStarted)return;
      if(!_isIOS)speechSynthesis.cancel();
      a.currentTime=0;
      a.play().catch(()=>{}).finally(()=>{
        if(_speakEl)_speakEl.classList.remove('speaking');
      });
    };
    
    // Check IDB trước
    if(_idbCache.has(k)){
      const blob=_idbCache.get(k);
      if(blob&&blob.size>0){
        a._cached=true; // Set trước khi gán src
        a._lastUsed=Date.now();
        const url=URL.createObjectURL(blob);
        a._blobURL=url;_blobURLs.add(url);
        a.oncanplaythrough=playEdge;
        a.src=url;
        // Check instant ready sau 1 tick
        setTimeout(()=>{if(a.readyState>=2)playEdge();},0);
      }else{
        _idbCache.delete(k); // Corrupt empty blob → fall through
      }
    }
    if(!a._cached){
      // Check IDB async
      _openIDB().then(db=>{
        const tx=db.transaction(['audio'],'readonly');
        const req=tx.objectStore('audio').get(k);
        req.onsuccess=()=>{
          if(req.result&&req.result.size>=500){
            const blob=req.result;
            _idbCache.set(k,blob);
            a._cached=true; // Set trước khi gán src
            a._lastUsed=Date.now();
            const url=URL.createObjectURL(blob);
            a._blobURL=url;_blobURLs.add(url);
            a.oncanplaythrough=playEdge;
            a.src=url;
            // Check instant ready sau 1 tick
            setTimeout(()=>{if(a.readyState>=2)playEdge();},0);
          }else{
            // Corrupt/empty → fetch mới và dọn IDB
            if(req.result){
              _idbCache.delete(k);
              try {
                const txdel=db.transaction(['audio'],'readwrite');
                txdel.objectStore('audio').delete(k);
              }catch(e){}
            }
            a.oncanplaythrough=()=>{
              a._cached=true;
              a._lastUsed=Date.now();
              playEdge();
            };
            a.src='/tts?text='+encodeURIComponent(t)+'&voice='+v+(rate?'&rate='+encodeURIComponent(rate):'');
            // Lưu IDB ngầm với timeout
            const controller=new AbortController();
            const timeoutId=setTimeout(()=>controller.abort(),10000);
            fetch('/tts?text='+encodeURIComponent(t)+'&voice='+v+(rate?'&rate='+encodeURIComponent(rate):''),{signal:controller.signal})
              .then(r=>{
                if(!r.ok) throw new Error('HTTP '+r.status);
                return r.blob();
              })
              .then(blob=>{
                clearTimeout(timeoutId);
                if(!blob||blob.size<500)return;
                _idbCache.set(k,blob);
                const txw=db.transaction(['audio'],'readwrite');
                txw.objectStore('audio').put(blob,k);
              })
              .catch(e=>{
                clearTimeout(timeoutId);
                if(e.name!=='AbortError')console.warn('Audio IDB save:',e);
              });
          }
        };
      }).catch(e=>{
        console.warn('IDB fail:',e);
        a.oncanplaythrough=()=>{
          a._cached=true;
          a._lastUsed=Date.now();
          playEdge();
        };
        a.src='/tts?text='+encodeURIComponent(t)+'&voice='+v+(rate?'&rate='+encodeURIComponent(rate):'');
      });
    }
  }else{
    // Edge đang tải → chờ sẵn sàng
    const playEdge=()=>{
      if(edgePlayed)return;
      edgePlayed=true;
      clearTimeout(_wsTimeout);
      if(!_isIOS)speechSynthesis.cancel();
      a.currentTime=0;
      a.play().catch(()=>{}).finally(()=>{
        if(_speakEl)_speakEl.classList.remove('speaking');
      });
    };
    a.oncanplaythrough=()=>{
      a._cached=true;
      a._lastUsed=Date.now();
      playEdge();
    };
  }
}
function _wsSpeak(t,rate){
  let r=.62;
  if(typeof rate==='string'){
    let m=rate.match(/([+-]?\d+)%/);
    if(m)r=Math.max(.1,Math.min(2,(1+parseInt(m[1])/100)*.62));
  }else if(typeof rate==='number'){r=rate;}
  let u=new SpeechSynthesisUtterance(t);u.volume=1.5;u.lang='zh-TW';u.rate=r;
  u.onend=u.onerror=()=>{if(_speakEl)_speakEl.classList.remove('speaking');};
  speechSynthesis.speak(u);
}
// ── Viewport + Background Preload ──
let _preloading=false;
let _bulkPreloadRunning=false;

// Preload viewport + 15 buffer
function _preloadViewport(){
  if(_preloading)return;
  _preloading=true;
  
  const rows=document.querySelectorAll('#tb tr');
  const vpHeight=window.innerHeight;
  const toPreload=[];
  
  rows.forEach((row,i)=>{
    const rect=row.getBoundingClientRect();
    if(rect.top<vpHeight+300){ // viewport + 300px buffer
      const r=data[i];
      if(r?.h)toPreload.push(r.h);
    }
  });
  
  // Preload tối đa 30 từ viewport
  toPreload.slice(0,30).forEach(h=>_preloadEdge(h));
  
  setTimeout(()=>_preloading=false,500);
}

// Background bulk preload (nhẹ nhàng 2 từ / 3s tránh rate limit)
function _preloadAllBulk(){
  if(_bulkPreloadRunning)return;
  _bulkPreloadRunning=true;
  
  let i=0;
  const batch=()=>{
    if(document.hidden){
      setTimeout(batch,5000);
      return;
    }
    const chunk=data.slice(i,i+2);
    chunk.forEach(r=>{
      if(r?.h)_preloadEdge(r.h,null,false);
    });
    i+=2;
    if(i<data.length){
      setTimeout(batch,3000);
    }else{
      console.log('Preload batch finished');
      _bulkPreloadRunning=false;
    }
  };
  
  setTimeout(batch,8000); // bắt đầu sau 8s
}

// Legacy _preloadTop (giữ tương thích)
function _preloadTop(){
  if(_preloading)return;
  _preloading=true;
  const top=visibleData().slice(0,20);
  _openIDB().then(db=>{
    const tx=db.transaction(['audio'],'readonly');
    const store=tx.objectStore('audio');
    top.forEach(r=>{
      const t=r.h.split('/')[0].trim();
      ['f','m'].forEach(v=>{
        const k=t+v;
        if(_edgeCache[k])return; // đã có
        // Check IDB trước
        const req=store.get(k);
        req.onsuccess=()=>{
          if(req.result && req.result.size >= 500){
            // Tìm thấy trong IDB → lưu sync cache + tạo Audio
            const blob=req.result;
            _idbCache.set(k,blob);
            const url=URL.createObjectURL(blob);
            const a=new Audio();
            a.onended=()=>{
              if(_speakEl)_speakEl.classList.remove('speaking');
              if(a._blobURL){URL.revokeObjectURL(a._blobURL);_blobURLs.delete(a._blobURL);a._blobURL=null;}
            };
            a.src=url;
            a._blobURL=url;_blobURLs.add(url);
            a._cached=true;
            a._lastUsed=Date.now();
            _edgeCache[k]=a;
            _trackCacheSize();
          }else{
            if(req.result){
              try {
                const txdel=db.transaction(['audio'],'readwrite');
                txdel.objectStore('audio').delete(k);
              }catch(e){}
            }
            // Chưa có → fetch + lưu IDB + sync cache
            fetch('/tts?text='+encodeURIComponent(t)+'&voice='+v)
              .then(res=>{
                if(!res.ok) throw new Error('HTTP '+res.status);
                return res.blob();
              })
              .then(blob=>{
                if(!blob || blob.size < 500) return;
                _idbCache.set(k,blob);
                const url=URL.createObjectURL(blob);
                const a=new Audio();
                a.onended=()=>{
                  if(_speakEl)_speakEl.classList.remove('speaking');
                  if(a._blobURL){URL.revokeObjectURL(a._blobURL);_blobURLs.delete(a._blobURL);a._blobURL=null;}
                };
                a.src=url;
                a._blobURL=url;_blobURLs.add(url);
                a._cached=true;
                a._lastUsed=Date.now();
                _edgeCache[k]=a;
                _trackCacheSize();
                // Lưu vào IDB
                const txw=db.transaction(['audio'],'readwrite');
                txw.objectStore('audio').put(blob,k);
              })
              .catch(e=>console.warn('Preload fail:',k,e));
          }
        };
      });
    });
  }).catch(e=>console.warn('IDB preload fail:',e));
  _preloading=false;
}
let _searchDebounce=null,_preSearchScrollY=0;
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{localStorage.setItem('twv10',JSON.stringify(data));_syncToIDB();},160);}
function setSearch(v){
  searchTerm=v;
  clearTimeout(_searchDebounce);
  _searchDebounce=setTimeout(()=>{render();requestAnimationFrame(()=>{window.scrollTo(0,0);document.documentElement.scrollTop=0;});_updateSearchActions();},150);
}
function visibleData(){var q=searchTerm.trim();if(!q&&!_bookmarkFilter)return data;if(!q)return data.filter(function(r){return[...bookmarked].some(function(bk){return String(r.id)===_selBaseId(bk);});});var qn=norm(q),ql=q.toLowerCase(),isCJK=/[\u4e00-\u9fff]/.test(q),isViet=/[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/.test(ql);var _bmfRes=data.filter(function(r){var f=['h','p','m'];for(var i=0;i<3;i++){var v=r[f[i]].toLowerCase();if(v===ql)return true;if(isViet){var j=v.indexOf(ql);while(j!==-1){if((j===0||v[j-1]===' '||v[j-1]===',')&&(j+ql.length===v.length||v[j+ql.length]===' '||v[j+ql.length]===','))return true;j=v.indexOf(ql,j+1);}}else{if(v.includes(ql))return true;}if(norm(v).includes(qn))return true;}return false;}).sort(function(a,b){function sc(r,f){var raw=r[f].toLowerCase(),n=norm(r[f]);if(raw===ql)return 1e6;if(raw.startsWith(ql))return 5e5;if(raw.includes(ql))return 2e5;if(n===qn)return 8e4;if(n.startsWith(qn))return 4e4;if(n.includes(qn))return 1e4;return 0;}function tier(r){var t=0;for(var i=0;i<3;i++){var f=['h','p','m'][i],raw=r[f].toLowerCase(),n=norm(r[f]);if(raw===ql||n===qn)return 3;if((raw.startsWith(ql)||n.startsWith(qn))&&t<2)t=2;else if((raw.includes(ql)||n.includes(qn))&&t<1)t=1;}return t;}var ta=tier(a),tb=tier(b);if(ta!==tb)return tb-ta;var w=isCJK?{h:3,p:1,m:1}:isViet?{h:1,p:1,m:3}:{h:1,p:3,m:1};var sa=['h','p','m'].reduce(function(s,f){return s+sc(a,f)*w[f]},0),sb=['h','p','m'].reduce(function(s,f){return s+sc(b,f)*w[f]},0);return sb-sa;});return _bookmarkFilter?_bmfRes.filter(function(r){return[...bookmarked].some(function(bk){return String(r.id)===_selBaseId(bk);});}):_bmfRes;}

// ── Menu (GSAP) ──
let menuOpen=false;
function openMenu(){
  menuOpen=true;
  const sheet=$('menu'),overlay=$('menuOverlay');
  overlay.style.display='block';
  sheet.style.display='block';
  gsap.to(sheet,{y:0,duration:.35,ease:'power3.out'});
  sheet.classList.add('show');
}
function closeMenu(){
  menuOpen=false;
  const sheet=$('menu'),overlay=$('menuOverlay');
  overlay.style.display='none';
  gsap.to(sheet,{y:'100%',duration:.25,ease:'power2.in',onComplete:()=>{sheet.classList.remove('show');}});
  // Reset study sub-menu when closing
  $('studySub').style.maxHeight='0px';
  $('studyArrow').style.transform='rotate(0deg)';
  // Reset add sub-menu when closing
  $('addSub').style.maxHeight='0px';
  $('addArrow').style.transform='rotate(0deg)';
}
// Click outside to close menu
document.addEventListener('click',function(e){
  if(!menuOpen)return;
  var menu=$('menu'),fab=$('fab');
  if(!menu.contains(e.target)&&e.target!==fab&&!fab.contains(e.target)){
    closeMenu();
  }
});

// ── Study sub-menu ──
function toggleStudyMenu(){
  var sub=$('studySub'), arrow=$('studyArrow');
  if(sub.style.maxHeight==='0px'||!sub.style.maxHeight){
    sub.style.maxHeight=sub.scrollHeight+'px';arrow.style.transform='rotate(180deg)';
  }else{
    sub.style.maxHeight='0px';arrow.style.transform='rotate(0deg)';
  }
}

// ── Add sub-menu ──
function toggleAddMenu(){
  var sub=$('addSub'), arrow=$('addArrow');
  if(sub.style.maxHeight==='0px'||!sub.style.maxHeight){
    sub.style.maxHeight=sub.scrollHeight+'px';arrow.style.transform='rotate(180deg)';
  }else{
    sub.style.maxHeight='0px';arrow.style.transform='rotate(0deg)';
  }
}

// ── Render ──
function updateStats(shown){
  let totalWords=data.reduce((s,r)=>s+(String(r.h||'').split('/').length),0);
  count.innerHTML=searchTerm
    ?'<span style="display:inline-flex;align-items:center;line-height:1"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-right:3px;position:relative;top:-1px"><use href="#i-book"/></svg>Hiển thị: '+shown.length+' · Tìm: '+esc(searchTerm)+'</span>'
    :'<span style="display:inline-flex;align-items:center;line-height:1"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-right:3px;position:relative;top:-1px"><use href="#i-book"/></svg>Tổng số từ: '+totalWords+' ('+data.length+' dòng)</span>';
  selectBadge.innerText='Đã chọn '+selected.size;
  selectBar.classList.toggle('show',selectMode||arrangeMode);
  selectBadge.classList.toggle('show',selectMode);
  // Đẩy FAB lên khi select bar hiện
  if(fab) fab.style.bottom=(selectMode||arrangeMode)?'calc(84px + env(safe-area-inset-bottom,0px))':'';
  _updateSearchActions();
}
function render(){
  const shown=visibleData();
  selected=new Set([...selected].filter(function(id){var baseId=_selBaseId(id);return data.some(function(r){return String(r.id)===baseId;});}));
  bookmarked=new Set([...bookmarked].filter(function(key){var baseId=_selBaseId(key);return data.some(function(r){if(String(r.id)!==baseId)return false;var p=String(key).indexOf('|');if(p===-1)return true;var idx=parseInt(key.substring(p+1));return idx<(String(r.h||'').split('/').length);});}));
  updateStats(shown);
  var sm=document.getElementById('searchModal'),_saveScroll=0;
  if(sm&&sm.style.display!=='none')_saveScroll=window.scrollY;
  tb.innerHTML='';
  const frag=document.createDocumentFragment();
  shown.forEach((r,i)=>{
    let hParts=r.h.split(/\s*\/\s*/).map(s=>s.trim()).filter(Boolean);
    let pParts=(r.p||'').split(/\s*\/\s*/).map(s=>s.trim()).filter(Boolean);
    if(hParts.length>1){
      let count=hParts.length;
      hParts.forEach((hVar,j)=>{
        let tr=document.createElement('tr');
        let cKey=_selKey(r.id,j);
        tr.setAttribute('data-vid',cKey);
        tr.setAttribute('data-rid',r.id);
        tr.setAttribute('data-vidx',j);
        tr.setAttribute('data-hanzi',hVar);
        if(selectMode)tr.classList.add('selectable');
        if(selected.has(cKey))tr.classList.add('selected');
        if(bookmarked.has(cKey))tr.classList.add('bookmarked');
        if(_rangeSelect&&_rangeAnchor===cKey)tr.classList.add('range');
        if(arrangeMode&&arrangeItems.some(function(x){return x.id===r.id;}))tr.classList.add('arrange-frozen');
        if(arrangeMode&&!arrangeItems.some(function(x){return x.id===r.id;}))tr.classList.add('arrange-target');
        let pVar=pParts[j]||pParts[0]||'';
        let hDisplay=searchTerm?esc(hVar).replace(new RegExp('('+searchTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>'):esc(hVar);
        let pDisplay=searchTerm?esc(pVar).replace(new RegExp('('+searchTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>'):esc(pVar);
        let mDisplay=j===0&&searchTerm?esc(r.m).replace(new RegExp('('+searchTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>'):esc(r.m);
        let meanCell=j===0?'<td class="mean" rowspan="'+count+'">'+mDisplay+'</td>':'';
        tr.innerHTML='<td class="hanzi">'+hDisplay+'</td><td class="pinyin">'+pDisplay+'</td>'+meanCell;
        frag.appendChild(tr);
      });
    }else{
      let tr=document.createElement('tr');
      let cKey=_selKey(r.id);
      tr.setAttribute('data-vid',cKey);
      tr.setAttribute('data-rid',r.id);
      tr.setAttribute('data-hanzi',r.h);
      if(selectMode)tr.classList.add('selectable');
      if(selected.has(cKey))tr.classList.add('selected');
      if(bookmarked.has(cKey))tr.classList.add('bookmarked');
      if(_rangeSelect&&_rangeAnchor===cKey)tr.classList.add('range');
      if(arrangeMode&&arrangeItems.some(function(x){return x.id===r.id;}))tr.classList.add('arrange-frozen');
      if(arrangeMode&&!arrangeItems.some(function(x){return x.id===r.id;}))tr.classList.add('arrange-target');
      let hDisplay=searchTerm?esc(r.h).replace(new RegExp('('+searchTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>'):esc(r.h);
      let pDisplay=searchTerm?esc(r.p).replace(new RegExp('('+searchTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>'):esc(r.p);
      let mDisplay=searchTerm?esc(r.m).replace(new RegExp('('+searchTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>'):esc(r.m);
      tr.innerHTML='<td class="hanzi">'+hDisplay+'</td><td class="pinyin">'+pDisplay+'</td><td class="mean">'+mDisplay+'</td>';
      frag.appendChild(tr);
    }
  });
  tb.appendChild(frag);
  if(_saveScroll>0)requestAnimationFrame(function(){window.scrollTo(0,_saveScroll);});
  if(_isIOS) shown.slice(0,8).forEach(r=>_preloadEdge(r.h));
  if(typeof _applyHanFont==='function')_applyHanFont();
  save();
  
  // Preload viewport ngay
  setTimeout(_preloadViewport,800);
  
  // Background bulk preload
  if(!window._bulkScheduled){
    window._bulkScheduled=true;
    _preloadAllBulk();
  }
}
function _onRowClick(r,vIdx){
  var cKey=_selKey(r.id,vIdx);
  if(_rangeSelect){
    let shown=visibleData(),idx=shown.findIndex(x=>x.id===r.id);
    if(idx<0)return;
    if(_rangeAnchor===null){
      _rangeAnchor=cKey;_rangeShown=shown;render();
    }else if(_rangeAnchor===cKey){
      _rangeAnchor=null;_rangeShown=null;render();
    }else{
      // Luôn dùng shown hiện tại để tránh chọn lọt dòng đã filter
      let s=shown;
      let aKey=_rangeAnchor;
      // build flat list of compound keys for shown data
      var flatKeys=[];
      s.forEach(function(x){
        var n=String(x.h||'').split('/').length;
        if(n<=1)flatKeys.push(_selKey(x.id));
        else for(var k=0;k<n;k++)flatKeys.push(_selKey(x.id,k));
      });
      let aIdx=flatKeys.indexOf(aKey);
      let sIdx=flatKeys.indexOf(cKey);
      if(aIdx<0||sIdx<0){_rangeAnchor=null;_rangeShown=null;render();return;}
      let[start,end]=aIdx<sIdx?[aIdx,sIdx]:[sIdx,aIdx];
      let allSel=true;
      for(let i=start;i<=end;i++){if(!selected.has(flatKeys[i])){allSel=false;break;}}
      for(let i=start;i<=end;i++){
        if(allSel)selected.delete(flatKeys[i]);
        else selected.add(flatKeys[i]);
      }
      _rangeAnchor=null;_rangeShown=null;save();render();
    }
  }else{
    if(selected.has(cKey))selected.delete(cKey);
    else selected.add(cKey);
    save();render();
  }
}

// ── Add / Import ──
function addRow(){let r={id:Date.now()+Math.random(),h:'',p:'',m:''};_isNew=true;editRow(r);closeMenu();}
function pasteBulk(){$('pasteModal').style.display='block';bulkText.value='';bulkInfo.innerText='';closeMenu();}
function closeBulk(){$('pasteModal').style.display='none';}
function pasteFromClipboard(){navigator.clipboard.readText().then(text=>{$('bulkText').value=text;$('bulkText').dispatchEvent(new Event('input',{bubbles:true}));toast('Đã dán từ clipboard');}).catch(err=>{toast('Không thể đọc clipboard');console.error(err);});}
// bulkText listener moved to DOMContentLoaded
function parseLine(line){
line=line.trim();
if(!line)return null;
// Strategy 0: Variant format "Hanzi/Hanzi | pinyin / pinyin | meaning"
let vm=line.match(/^([\u4e00-\u9fff\u3400-\u4dbf]+(?:\s*\/\s*[\u4e00-\u9fff\u3400-\u4dbf]+)*)\s*\|\s*([a-zA-Zāēīōūǖáéíóúǘǎěǐǒǔǚàèìòùǜ\s\/]+?)\s*\|\s*(.+)$/i);
if(vm){
  let hh=vm[1],pp=vm[2].trim(),mm=vm[3].trim();
  return{id:Date.now()+Math.random(),h:hh,p:pp,m:mm};
}
// Nếu có ký tự | nhưng Strategy 0 không match → reject line
if(line.includes('|'))return null;
let m=line.match(/^([\u4e00-\u9fff\u3400-\u4dbf]+)/);
if(!m)return null;
let h=m[1],rest=line.slice(m[0].length);
// Mở rộng h với Hanzi variants sau dấu / (vd: "哪裡 / 哪兒")
while(true){
  let vm2=rest.match(/^\s*\/\s*([\u4e00-\u9fff\u3400-\u4dbf]+)/);
  if(!vm2)break;
  h+=' / '+vm2[1];
  rest=rest.slice(vm2[0].length);
}
rest=rest.replace(/^[\s\-,:;.·•()]+/,'');
if(!rest)return null;
// Phát hiện pinyin variants với dấu / (vd: "nǎlǐ / nǎr")
var pyParts=[],rest2=rest;
while(true){
  var wm=rest2.match(/^([a-zA-Zāēīōūǖáéíóúǘǎěǐǒǔǚàèìòùǜ]+)\s*\/\s*/);
  if(!wm)break;
  pyParts.push(wm[1]);
  rest2=rest2.slice(wm[0].length);
}
if(pyParts.length>0){
  var lastWM=rest2.match(/^([a-zA-Zāēīōūǖáéíóúǘǎěǐǒǔǚàèìòùǜ]+)/);
  if(lastWM){pyParts.push(lastWM[1]);rest2=rest2.slice(lastWM[0].length);}
  var pp=pyParts.join(' / ');
  var mm=rest2.replace(/^[\s\-,:;.·•()]+/,'');
  if(pp&&mm)return{id:Date.now()+Math.random(),h,p:pp,m:mm};
  // fall through to old logic
}
let parts;
if(rest.includes('\t')){
  let idx=rest.indexOf('\t');
  parts=[rest.slice(0,idx),rest.slice(idx+1)].map(x=>x.trim());
}else if(rest.includes(' - ')){
  let idx=rest.indexOf(' - ');
  parts=[rest.slice(0,idx),rest.slice(idx+3)].map(x=>x.trim());
}else if(rest.includes('-')){
  let idx=rest.indexOf('-');
  parts=[rest.slice(0,idx),rest.slice(idx+1)].map(x=>x.trim());
}else{
  let words=rest.split(/\s+/);
  let split=words.length;
  // Strategy 1: split after last word with pinyin-only tone marks
  let lastPY=-1;
  for(let i=0;i<words.length;i++){
    if(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(words[i]))lastPY=i;
  }
  if(lastPY>=0&&lastPY<words.length-1){
    split=lastPY+1;
  }else{
    // Strategy 2: split before first word with Vietnamese-only diacritics
    for(let i=0;i<words.length;i++){
      if(/[ảãạẢÃẠẻẽẹẺẼẸỉĩịỈĨỊỏõọỎÕỌủũụỦŨỤỷỹỵỶỸỴắằẳẵặẮẰẲẴẶấầẩẫậẤẦẨẪẬếềểễệẾỀỂỄỆốồổỗộỐỒỔỖỘớờởỡợỚỜỞỠỢứừửữựỨỪỬỮỰđĐôơăâêôơăâê]/.test(words[i])){
        if(!/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(words[i])){split=i;break;}
      }
    }
    if(split===words.length&&words.length>=2)split=Math.ceil(words.length/2);
  }
  parts=[words.slice(0,split).join(' '),words.slice(split).join(' ')];
}
if(parts.length>2){
  parts=[parts[0],parts.slice(1).join(' ')];
}
let p=(parts[0]||'').trim().replace(/[\-]/g,' ').replace(/\s+/g,' ').trim();
let n=(parts[1]||'').trim().replace(/[\-]/g,' ').replace(/\s+/g,' ').trim();
if(!h||!p||!n)return null;
return{id:Date.now()+Math.random(),h,p,m:n};
}
function importBulk(){var lines=bulkText.value.split('\n').map(function(x){return x.trim();}).filter(Boolean).filter(function(x){return !/^\|?\s*-{3,}/.test(x)&&!/chữ hán|pinyin|phiên âm|nghĩa/i.test(x);});var rows=[];for(var i=0;i<lines.length;i++){var l=lines[i];var fb=parseLine(l);if(fb){rows.push(fb);continue;}if(l.indexOf('\t')!==-1){var p=l.split('\t').map(function(x){return x.trim();});if(p.length>=3){rows.push({id:Date.now()+Math.random(),h:p[0],p:p[1],m:p.slice(2).join(' ')});continue;}}var m=l.match(/^([\u4e00-\u9fff\u3400-\u4dbf]+)\s+(.+)$/);if(m){var hz=m[1],rest=m[2],tokens=rest.split(/\s+/),lastPyIdx=-1;for(var j=0;j<tokens.length;j++){var hasTone=/[ǎěǐǒǔǚāēīōūǖ]/i.test(tokens[j]),hasVU=/[AÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬEÉÈẺẼẸÊẾỀỂỄỆIÍÌỈĨỊOÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢUÚÙỦŨỤƯỨỪỬỮỰYÝỲỶỸỴĐ]/.test(tokens[j]);if(hasTone&&!hasVU)lastPyIdx=j;}if(lastPyIdx===-1){for(var j=0;j<tokens.length;j++){if(/[ảãạẻẽẹỉĩịỏõọủũụỷỹỵắằẳẵặấầẩẫậếềểễệốồổỗộớờởỡợứừửữựđ]|[AÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬEÉÈẺẼẸÊẾỀỂỄỆIÍÌỈĨỊOÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢUÚÙỦŨỤƯỨỪỬỮỰYÝỲỶỸỴĐ]/i.test(tokens[j])){lastPyIdx=Math.max(0,j-1);break;}}if(lastPyIdx===-1)lastPyIdx=Math.floor(tokens.length/2);}var split=lastPyIdx+1,py=tokens.slice(0,split).join(' '),me=tokens.slice(split).join(' ');if(hz&&py&&me){rows.push({id:Date.now()+Math.random(),h:hz,p:py,m:me});continue;}}}if(!rows.length){toast('Không đọc được dữ liệu');return;}_doImportBulk(rows);}
function smartParseBulk(lines){function classify(s){var hz=0,py=0,lat=0,vie=0,oth=0;for(var i=0;i<s.length;i++){var c=s[i];if(/[\u4e00-\u9fff\u3400-\u4dbf]/.test(c))hz++;else if(/[āēīōūǖáéíóúǘǎěǐǒǔǚàèìòùǜ]/i.test(c))py++;else if(/[a-zA-Z]/.test(c))lat++;else if(/[ảãạẻẽẹỉĩịỏõọủũụỷỹỵắằẳẵặấầẩẫậếềểễệốồổỗộớờởỡợứừửữựđơưăâêô]/i.test(c))vie++;else if(/\s/.test(c))continue;else oth++;}var tot=hz+py+lat+vie+oth;if(tot===0)return'empty';if(hz>tot*0.7)return'hanzi';if((py+lat)>0&&vie===0&&hz===0)return'pinyin';if(vie>0||(lat>0&&py===0&&hz===0))return'meaning';return'unknown';}var parsed=[];for(var i=0;i<lines.length;i++){var l=lines[i];if(l.indexOf('\t')!==-1){var parts=l.split('\t').map(function(x){return x.trim();});if(parts.length>=3){parsed.push({h:parts[0],p:parts[1],m:parts.slice(2).join(' ')});continue;}}var tokens=l.split(/\s+/);var types=tokens.map(classify);var hIdx=-1,pIdx=-1,mIdx=-1;for(var j=0;j<types.length;j++){if(types[j]==='hanzi'&&hIdx===-1)hIdx=j;else if(types[j]==='pinyin'&&pIdx===-1&&hIdx!==-1)pIdx=j;else if((types[j]==='meaning'||types[j]==='unknown')&&mIdx===-1&&pIdx!==-1){mIdx=j;break;}}if(hIdx===-1){var fst=tokens[0]||'';if(/[\u4e00-\u9fff]/.test(fst)){hIdx=0;for(var j=1;j<tokens.length;j++){if(/[āēīōūǖáéíóúǘǎěǐǒǔǚàèìòùǜ]/i.test(tokens[j])){pIdx=j;break;}}if(pIdx!==-1&&pIdx<tokens.length-1)mIdx=pIdx+1;}}if(hIdx!==-1&&pIdx!==-1&&mIdx!==-1){var h=tokens.slice(hIdx,pIdx).join(' ');var p=tokens.slice(pIdx,mIdx).join(' ');var m=tokens.slice(mIdx).join(' ');if(h&&p&&m){parsed.push({id:Date.now()+Math.random(),h:h,p:p,m:m});continue;}}var fb=parseLine(l);if(fb)parsed.push(fb);}return parsed;}
function _doImportBulk(rows){
  let added=0,updated=0,skipped=0,mode=dupMode.value;
  let updatedList=[],addedList=[],skippedList=[];
  let map=new Map(data.map((r,i)=>[norm(r.h),i]));
  rows.forEach(r=>{
    let k=norm(r.h);
    if(map.has(k)){
      if(mode==='update'){
        let i=map.get(k);
        data[i]={...data[i],h:r.h,p:r.p,m:r.m};
        updatedList.push(r.h+' — '+r.m);
        updated++;
      }
      else{
        skippedList.push(r.h+' — '+r.m);
        skipped++;
      }
    }else{
      data.push(r);
      map.set(k,data.length-1);
      addedList.push(r.h+' — '+r.m);
      added++;
    }
  });
  save();render();closeBulk();
  showImportResult(added,updated,skipped,addedList,updatedList,skippedList);
}
function showImportResult(added,updated,skipped,addedList,updatedList,skippedList){
  $('resultAdded').textContent=added;
  $('resultUpdated').textContent=updated;
  $('resultSkipped').textContent=skipped;
  let ul='',sl='';
  if(updatedList.length>0){
    ul='<div style="font-weight:600;margin-bottom:6px;color:#f59e0b">Đã cập nhật ('+updatedList.length+'):</div>';
    ul+='<div style="display:flex;flex-direction:column;gap:4px">'+updatedList.map(t=>'<div style="padding:6px 10px;background:var(--accent-bg);border-radius:6px;font-size:14px">'+esc(t)+'</div>').join('')+'</div>';
  }
  if(skippedList.length>0){
    sl='<div style="font-weight:600;margin-bottom:6px;color:var(--danger)">Đã bỏ qua ('+skippedList.length+'):</div>';
    sl+='<div style="display:flex;flex-direction:column;gap:4px">'+skippedList.map(t=>'<div style="padding:6px 10px;background:var(--danger-bg);border-radius:6px;font-size:14px;opacity:0.7">'+esc(t)+'</div>').join('')+'</div>';
  }
  $('resultUpdatedList').innerHTML=ul;
  $('resultSkippedList').innerHTML=sl;
  $('importResultModal').style.display='flex';
  document.body.style.overflow='hidden';
}
function closeImportResult(){
  $('importResultModal').style.display='none';
  document.body.style.overflow='';
}

// ── Select ──
function startSelect(){selectMode=true;render();setTimeout(()=>{let bar=$('selectBar');if(bar)bar.scrollLeft=0;},50);toast('Bấm vào dòng để chọn');}
function startRangeSelect(){
  selectMode=true;
  if(_rangeSelect){
    _rangeSelect=false;_rangeAnchor=null;_rangeShown=null;
    _setRangeBtn(false);
    render();toast('Đã tắt chọn hàng loạt');
    return;
  }
  _rangeSelect=true;_rangeAnchor=null;_rangeShown=null;render();_setRangeBtn(true);toast('Chạm từ đầu → chạm từ cuối để chọn thêm khoảng');
}
function _setRangeBtn(on){
  var b=document.getElementById('btnRangeSelect');
  if(!b)return;
  if(on){
    b.style.setProperty('background','#2563eb');
    b.style.setProperty('color','#fff');
    b.style.setProperty('border-color','#2563eb');
  }else{
    b.style.setProperty('background','');
    b.style.setProperty('color','');
    b.style.setProperty('border-color','');
  }
}
function finishSelect(){selected.clear();selectMode=false;_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);render();}
function clearSelect(){if(selected.size>0){selected.clear();render();}else{selectMode=false;_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);render();}}
function selectAll(){selectMode=true;selected=new Set();data.forEach(function(r){var n=String(r.h||'').split('/').length;if(n<=1)selected.add(_selKey(r.id));else for(var j=0;j<n;j++)selected.add(_selKey(r.id,j));});render();}
function invertSelect(){selectMode=true;var allKeys=[];data.forEach(function(r){var n=String(r.h||'').split('/').length;if(n<=1)allKeys.push(_selKey(r.id));else for(var j=0;j<n;j++)allKeys.push(_selKey(r.id,j));});var newSel=new Set();allKeys.forEach(function(k){if(!selected.has(k))newSel.add(k);});selected=newSel;render();}

// ── Edit / Delete ──
let _editRow=null,_isNew=false;
function editRow(r){
  _editRow=r;
  $('editTitle').textContent=r.h?'Sửa từ':'Thêm từ mới';
  $('editH').value=r.h||'';
  $('editP').value=r.p||'';
  $('editM').value=r.m||'';
  $('editHint').textContent='';
  $('editModal').classList.add('show');
  setTimeout(()=>{$('editH').focus();
    ['editH','editP','editM'].forEach(id=>$(id).onkeydown=e=>{if(e.key==='Enter')saveEdit();if(e.key==='Escape')closeEdit();});
  },100);
}
function autoLookup(){
  let h=$('editH').value.trim();
  if(!h){$('editHint').textContent='';return;}
  let found=data.find(r=>norm(r.h)===norm(h));
  if(found){
    $('editP').value=found.p;$('editM').value=found.m;
    $('editHint').textContent='✓ Đã điền từ dữ liệu có sẵn';
  }else if(h.includes('/')){
    // Auto-suggest pinyin variants for multi-variant Hanzi (哪裡/哪兒)
    let parts=h.split('/').map(x=>x.trim()).filter(Boolean);
    if(parts.length>1){
      let pinyins=parts.map(p=>{
        let f=data.find(r=>norm(r.h)===norm(p));
        return f?f.p:'';
      }).filter(Boolean);
      if(pinyins.length>0){
        $('editP').value=pinyins.join(' / ');
        $('editHint').innerHTML='<span style="color:#f59e0b">⚡ Gợi ý pinyin từ các variant</span>';
      }
    }
  }else{
    $('editHint').textContent='';
  }
}
function saveEdit(){
  let h=$('editH').value.trim(),p=$('editP').value.trim(),m=$('editM').value.trim();
  if(!h){toast('Nhập chữ Hán');return;}
  if(_editRow){
    _editRow.h=h;_editRow.p=p;_editRow.m=m;
    if(_isNew){data.push(_editRow);_isNew=false;}
  }
  $('editModal').classList.remove('show');_editRow=null;
  const scrollY=window.scrollY;
  save();render();
  window.scrollTo(0,scrollY);
  toast('Đã lưu');
}
function closeEdit(){$('editModal').classList.remove('show');_editRow=null;_isNew=false;}
function editSelectedRow(){var ids=_selUniqueIds();if(ids.size!==1){toast('Chọn 1 dòng để sửa');return;}var firstId=ids.values().next().value;var r=data.find(function(x){return String(x.id)===firstId;});if(r)editRow(r);selected.clear();selectMode=false;_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);render();}
function editSelected(){var ids=_selUniqueIds();if(ids.size!=1){alert('Chọn 1 dòng để sửa');return;}var firstId=ids.values().next().value;var r=data.find(function(x){return String(x.id)===firstId;});if(r)editRow(r);selected.clear();selectMode=false;_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);render();closeMenu();}
function deleteSelected(){if(!selected.size){toast('Chưa chọn mục nào');return;}var ids=_selUniqueIds();var n=ids.size;if(!confirm('Xóa '+n+' mục đã chọn?'))return;var deleted=data.filter(function(x){return ids.has(String(x.id));});_deleteStack.push(deleted);if(_deleteStack.length>10)_deleteStack.shift();data=data.filter(function(x){return !ids.has(String(x.id));});selected.clear();selectMode=false;_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);save();render();toast('Đã xóa '+n+' mục');}
function toggleBookmark(){if(!selected.size){toast('Chưa chọn mục nào');return;}var added=0,removed=0;selected.forEach(function(key){if(bookmarked.has(key)){bookmarked.delete(key);removed++;}else{bookmarked.add(key);added++;}});localStorage.setItem('phuc_bm',JSON.stringify([...bookmarked]));selected.clear();render();var msg=[];if(added)msg.push('Đánh dấu '+added);if(removed)msg.push('Bỏ dấu '+removed);toast(msg.join(', '));}
function arrangeSelected(){if(!selected.size){toast('Chưa chọn mục nào');return;}if(arrangeMode){arrangeMode=false;arrangeItems=[];selectMode=true;render();toast('Đã hủy xếp');return;}var ids=_selUniqueIds();arrangeItems=[];ids.forEach(function(id){var r=data.find(function(r){return String(r.id)===id;});if(r)arrangeItems.push(r);});_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);selectMode=false;arrangeMode=true;render();toast('Bấm vào dòng muốn xếp đến bên dưới');}
function doArrange(target){if(!arrangeMode||!arrangeItems.length)return;var ids=[];for(var i=0;i<arrangeItems.length;i++)ids.push(arrangeItems[i].id);var newData=[];for(var i=0;i<data.length;i++){if(data[i].id===target.id){newData.push(data[i]);for(var j=0;j<arrangeItems.length;j++)newData.push(arrangeItems[j]);}else if(ids.indexOf(data[i].id)===-1){newData.push(data[i]);}}data=newData;arrangeMode=false;arrangeItems=[];_rangeSelect=false;_rangeAnchor=null;_rangeShown=null;_setRangeBtn(false);selectMode=true;selected.clear();save();render();toast('Đã xếp '+ids.length+' dòng');}
function exportData(){var ids=_selUniqueIds();var d=selectMode&&ids.size?data.filter(function(r){return ids.has(String(r.id));}):data;var tsv=d.map(function(x){return x.h+'\t'+x.p+'\t'+x.m;}).join('\n');navigator.clipboard.writeText(tsv).then(()=>toast('Đã copy '+d.length+' từ')).catch(()=>toast('Lỗi copy'));}

// ── Search ──
function openSearch(){$('searchModal').style.display='flex';searchBox.focus();closeMenu();_preSearchScrollY=window.scrollY;window.scrollTo(0,0);_updateBookmarkBtn();}
function closeSearch(){$('searchModal').style.display='none';if(!searchTerm)requestAnimationFrame(function(){window.scrollTo(0,_preSearchScrollY);});}
function _updateBookmarkBtn(){var b=document.getElementById('btnBookmarkFilter');if(!b)return;if(_bookmarkFilter){b.style.setProperty('background','#2563eb');b.style.setProperty('color','#fff');}else{b.style.setProperty('background','');b.style.setProperty('color','');}}
function clearSearch(){searchTerm='';searchBox.value='';_findMode=false;_bookmarkFilter=false;document.body.classList.remove('find-mode');render();closeSearch();_updateSearchActions();requestAnimationFrame(function(){window.scrollTo(0,_preSearchScrollY);});}
function _updateSearchActions(){var sa=document.getElementById('searchActions');if(sa){sa.style.display=(searchTerm||_bookmarkFilter||_findMode)?'flex':'none';sa.style.bottom=(selectMode||arrangeMode)?'calc(84px + env(safe-area-inset-bottom,0px))':'calc(20px + env(safe-area-inset-bottom,0px))';}var sb=sa?sa.children[0]:null;if(sb)sb.style.display='flex';var bf=document.getElementById('btnFindInList');if(bf){if(_findMode){bf.classList.add('active');bf.style.setProperty('background','#2563eb');bf.style.setProperty('color','#fff');bf.style.setProperty('border-color','#2563eb');}else{bf.classList.remove('active');bf.style.setProperty('background','var(--surface)');bf.style.setProperty('color','var(--text)');bf.style.setProperty('border-color','var(--border)');}bf.style.display='flex';}var xb=bf?bf.nextElementSibling:null;if(xb&&xb.onclick&&xb.onclick.toString().indexOf('clearSearch')!==-1)xb.style.display='flex';}
function toggleBookmarkFilter(){
  _bookmarkFilter=!_bookmarkFilter;
  closeSearch();
  _updateBookmarkBtn();
  searchTerm='';searchBox.value='';
  _findMode=false;document.body.classList.remove('find-mode');
  _updateSearchActions();
  render();
  if(_bookmarkFilter){
    var cnt=visibleData().length;
    toast('Đang hiện '+cnt+' dòng đánh dấu');
  }
}
function toggleFindMode(){
  _findMode=!_findMode;
  if(_findMode){document.body.classList.add('find-mode');$('searchModal').style.display='none';toast('Bấm vào dòng để tìm trong danh sách đầy đủ');}
  else{document.body.classList.remove('find-mode');}
  _updateSearchActions();
}
// ── Flashcard ──
let fi=0,showFront=true,flashData=[];
function shuffleArray(arr){for(let i=arr.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}
function flashcard(){
  var ids=_selUniqueIds();
  var rawData=(selectMode&&ids.size)?data.filter(function(x){return ids.has(String(x.id));}):[...visibleData()];
  if(!rawData.length){alert('Không có dữ liệu để học');return;}
  // ── Expand variants: "腳踏車/自行車" → 2 cards riêng ──
  flashData=[];
  rawData.forEach(function(r){
    if(r.h.includes('/')){
      var variants=r.h.split('/');
      var pinyins=r.p.split('/');
      var meanings=r.m.split('/');
      for(var i=0;i<variants.length;i++){
        flashData.push({id:r.id+'_v'+i,h:variants[i].trim(),p:pinyins[i]?pinyins[i].trim():r.p,m:meanings[i]?meanings[i].trim():r.m,cat:r.cat,band:r.band,bm:r.bm});
      }
    }else{
      flashData.push(r);
    }
  });
  if(_settings.random)shuffleArray(flashData);fi=0;$('flash').style.display='block';$('fab').style.display='none';loadCard();
}
function loadCard(){if(!flashData.length)return;let t=flashData[fi];let tokens=t.h.split(' ');if(tokens.length>1){fh.innerHTML=tokens.map((tk,i)=>'<button onclick="event.stopPropagation();speakToken(\''+escAttr(tk)+'\',this)" class="fc-token">'+esc(tk)+'</button>').join('');}else{fh.textContent=t.h;}fp.innerText=t.p;var mean=t.m.replace(/\s*\(/g,'<br>(');$('fmean').innerHTML=mean;if(typeof _applyHanFont==='function')_applyHanFont();front.style.display='block';front.style.opacity='1';back.style.display='none';back.style.opacity='0';showFront=true;if(typeof _applyHanFont==='function')_applyHanFont();_preloadEdge(t.h);}
function speakToken(text,btn){if(btn)btn.style.opacity='0.5';speak(text,btn);setTimeout(()=>{if(btn)btn.style.opacity='1';},300);}
function escAttr(s){return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');}
function flip(){
  showFront=!showFront;
  const front=$('front');
  const back=$('back');
  // Fallback: GSAP not loaded (CDN blocked/slow)
  if(typeof gsap==='undefined'){
    if(showFront){back.style.display='none';front.style.display='block';front.style.opacity='1';}
    else{front.style.display='none';back.style.display='block';back.style.opacity='1';}
    return;
  }
  if(showFront){
    gsap.to(back,{opacity:0,duration:.15,ease:'power2.in',onComplete:()=>{back.style.display='none';front.style.display='block';gsap.fromTo(front,{opacity:0},{opacity:1,duration:.15,ease:'power2.out'});}});
  }else{
    gsap.to(front,{opacity:0,duration:.15,ease:'power2.in',onComplete:()=>{front.style.display='none';back.style.display='block';gsap.fromTo(back,{opacity:0},{opacity:1,duration:.15,ease:'power2.out'});}});
  }
}
function next(){fi=(fi+1)%flashData.length;loadCard();}
function prev(){fi=(fi-1+flashData.length)%flashData.length;loadCard();}
function playFlash(btn){
  if(flashData.length){
    speak(flashData[fi].h,btn);
    // Tắt animation sau 0.5s nếu audio chưa kết thúc
    setTimeout(()=>{if(btn)btn.classList.remove('speaking');},500);
  }
}
function closeFlash(){$('flash').style.display='none';$('fab').style.display='';_findMode=false;_bookmarkFilter=false;document.body.classList.remove('find-mode');_updateSearchActions();}

// ── Quiz ──
let qzData=[],qzIdx=0,qzCorrect=0,qzTotal=0,qzAnswered=false,qzMode='word',qzSentence=null,_qzAttempts=0;
// ── Smart Distractors ──
const CAT_KEYWORDS={
  'vị':['chua','ngọt','đắng','cay','mặn','nhạt','ngon','thơm','thối','tanh','béo','bùi'],
  'màu sắc':['đỏ','xanh','vàng','trắng','đen','tím','hồng','nâu','xám','cam','lam','lục'],
  'thời tiết':['nắng','mưa','gió','bão','lạnh','nóng','ấm','mát','tuyết','sấm','sét','ẩm','khô'],
  'gia đình':['bố','mẹ','cha','ba','anh','chị','em','ông','bà','con','cháu','cô','chú','bác','dì','cậu','vợ','chồng'],
  'số đếm':['một','hai','ba','bốn','năm','sáu','bảy','tám','chín','mười','trăm','nghìn','triệu','vạn'],
  'hướng':['đông','tây','nam','bắc','trái','phải','trên','dưới','trước','sau','giữa','trong','ngoài','cạnh'],
  'cảm xúc':['vui','buồn','giận','sợ','yêu','ghét','mệt','lo','tức','chán','nhớ','hận','tiếc','ngạc nhiên'],
  'đồ uống':['nước','trà','cà phê','sữa','bia','rượu','sinh tố','nước ngọt','nước ép','kem'],
  'thức ăn':['cơm','phở','bún','bánh','thịt','cá','rau','canh','cháo','trứng','gà','bò','heo','lợn','tôm','cua','mực','ốc'],
  'thời gian':['sáng','trưa','chiều','tối','đêm','hôm','ngày','giờ','phút','giây','tuần','tháng','năm','mùa','xuân','hạ','thu','đông'],
  'cơ thể':['đầu','tóc','tay','chân','mắt','mũi','miệng','tai','bụng','lưng','tim','máu','răng','lưỡi','cổ','vai','mông','đùi','gan','phổi'],
  'động vật':['chó','mèo','gà','vịt','chim','cá','rắn','hổ','voi','khỉ','ngựa','trâu','bò','dê','chuột','thỏ','ếch','cóc','sâu','kiến'],
  'trường học':['sách','vở','bút','bàn','ghế','thầy','cô','trường','lớp','học','bài','bảng','phấn','thi','kiểm tra'],
  'quần áo':['áo','quần','giày','dép','mũ','nón','tất','vớ','khăn','váy','đầm','áo khoác','áo thun'],
  'nghề nghiệp':['bác sĩ','giáo viên','kỹ sư','công an','bộ đội','nông dân','đầu bếp','tài xế','phi công','sinh viên','nhân viên'],
  'hoa quả':['táo','cam','chuối','nho','dưa','xoài','dừa','mít','ổi','lê','đào','mận','bưởi','chanh','dâu'],
};

function _getCategory(r){
  const m=(r.m||'').toLowerCase();
  for(const[cat,kws]of Object.entries(CAT_KEYWORDS)){
    for(const kw of kws){if(m.includes(kw))return cat;}
  }
  return null;
}

function _smartDistractors(target,pool,count,hanziMode){
  if(pool.length<=count)return shuffleArray(pool);
  const tLen=(target.h||'').length;
  let filtered=pool;
  if(hanziMode){
    const sameLen=pool.filter(r=>(r.h||'').length===tLen);
    if(sameLen.length>=count) filtered=sameLen;
    else{
      const rest=pool.filter(r=>(r.h||'').length!==tLen).sort((a,b)=>Math.abs((a.h||'').length-tLen)-Math.abs((b.h||'').length-tLen));
      filtered=[...sameLen,...rest].slice(0,Math.max(count*3,sameLen.length));
    }
  }
  const tCat=_getCategory(target);
  const tPy=norm(target.p||'');
  const tPropVal=hanziMode?quizText(target.h||''):quizText(target.m||'');
  let scored=filtered.map(r=>{
    let score=0;
    // Exclude same displayed text as target (prevents duplicate answer)
    const rPropVal=hanziMode?quizText(r.h||''):quizText(r.m||'');
    if(rPropVal===tPropVal)return {item:r,score:-9999};
    // Rev mode: exclude synonyms — words with same meaning but different hanzi
    if(hanziMode && quizText(r.m||'')===quizText(target.m||''))return {item:r,score:-9999};
    if(tCat&&_getCategory(r)===tCat)score+=35;
    const rPy=norm(r.p||'');
    score+=_pinyinSimilarity(tPy,rPy);
    const tChars=[...(target.h||'')];
    const rChars=[...(r.h||'')];
    if(hanziMode){
      const shared=tChars.filter(c=>rChars.includes(c)).length;
      if(shared>0)score+=shared*55;
      if(tChars.length===rChars.length)score+=20;
      if(tChars.length>0&&rChars.length>0&&tChars[0]===rChars[0])score+=30;
      if(tChars.length>0&&rChars.length>0){
        let shareRad=tChars.some(c=>{let tc=c.codePointAt(0),rc=rChars[0].codePointAt(0);return tc&&rc&&Math.abs(tc-rc)<50;});
        if(shareRad)score+=10;
      }
    }else{
      const tMWords=quizText(target.m||'').split(' ').filter(w=>w.length>1);
      const rMWords=quizText(r.m||'').split(' ').filter(w=>w.length>1);
      const sharedWords=tMWords.filter(w=>rMWords.includes(w)).length;
      if(sharedWords>0)score+=sharedWords*30;
      const tMLen=quizText(target.m||'').length;const rMLen=quizText(r.m||'').length;
      if(Math.abs(tMLen-rMLen)<=2)score+=10;
      else if(Math.abs(tMLen-rMLen)<=5)score+=4;
    }
    return {item:r,score};
  });
  scored.sort((a,b)=>b.score-a.score);
  const topN=scored.slice(0,Math.min(count*5,scored.length));
  let result=shuffleArray(topN).slice(0,count).map(x=>x.item);
  if(result.length<count){
    let seen=new Set(result.map(r=>r.id));
    let extra=shuffleArray(pool.filter(r=>!seen.has(r.id))).slice(0,count-result.length);
    result=[...result,...extra];
  }
  return result;
}

function _dedupChoices(arr,prop){
  let seen=new Set();
  let result=arr.filter(c=>{
    let k=quizText(c[prop]);
    if(seen.has(k)) return false;
    seen.add(k); return true;
  });
  return result;
}
function _pinyinSimilarity(aPy,bPy){
  let aSyl=aPy.split(' '),bSyl=bPy.split(' ');
  let score=0;
  if(aSyl.length===bSyl.length)score+=25;
  else if(Math.abs(aSyl.length-bSyl.length)===1)score+=10;
  if(aSyl[0]&&bSyl[0]&&aSyl[0][0]===bSyl[0][0])score+=15;
  if(aSyl[0]&&bSyl[0]&&stripTones(aSyl[0])===stripTones(bSyl[0]))score+=25;
  if(aSyl.length===bSyl.length&&aSyl.length>0){
    let tonesA=aSyl.map(s=>(s.match(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/)||[''])[0]).join('');
    let tonesB=bSyl.map(s=>(s.match(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/)||[''])[0]).join('');
    if(tonesA===tonesB)score+=20;
  }
  return score;
}
// Ensure minimum choices by padding with random items from pool
function _padChoices(choices,pool,count,prop,correctVal){
  if(choices.length>=count || !pool.length) return choices;
  let seen=new Set(choices.map(c=>quizText(c[prop])));
  let extra=shuffleArray([...pool].filter(r=>!seen.has(quizText(r[prop]||''))))
    .slice(0,count-choices.length)
    .map(r=>({[prop]:r[prop],correct:false,id:r.id}));
  return [...choices,...extra];
}
function startSentQuiz(){qzMode='sent';qzSentPool=[];qzSentIdx=0;window._qzWord=window._qzNow=window._qzRev=null;qzData=quizSource();if(qzData.length<4){alert('Cần ít nhất 4 từ để làm quiz cụm câu!');return;}if(_settings.random)qzData=shuffleArray(qzData);qzIdx=0;qzCorrect=0;qzTotal=0;$('quizView').style.display='flex';$('fab').style.display='none';loadQuiz();}
// ── #5: Arrange Mode (xếp câu) ──
function startArrangeQuiz(){
  qzMode='arrange';
  qzSentPool=[];
  qzSentIdx=0;
  window._qzWord=window._qzNow=window._qzRev=null;
  qzData=quizSource();
  if(qzData.length<4){alert('Cần ít nhất 4 từ!');return;}
  if(_settings.random)qzData=shuffleArray(qzData);
  qzIdx=0;
  qzCorrect=0;
  qzTotal=0;
  $('quizView').style.display='flex';
  $('fab').style.display='none';
  loadQuiz();
}
function startListenQuiz(){qzMode='listen';window._qzWord=window._qzNow=window._qzRev=null;qzData=quizSource();if(qzData.length<4){alert('Cần ít nhất 4 từ để nghe-đoán!');return;}if(_settings.random)qzData=shuffleArray([...qzData]);qzIdx=0;qzCorrect=0;qzTotal=0;$('quizView').style.display='flex';$('fab').style.display='none';loadQuiz();}
function startRevQuiz(){qzMode='rev';window._qzWord=window._qzNow=window._qzRev=null;qzData=quizSource();if(qzData.length<4){alert('Cần ít nhất 4 từ!');return;}if(_settings.random)qzData=shuffleArray([...qzData]);qzIdx=0;qzCorrect=0;qzTotal=0;$('quizView').style.display='flex';$('fab').style.display='none';loadQuiz();}

// ── #4: TOCFL A1/A2 Real Sentences (200+ câu thật) ──
const SENT_TMP=[
// Greetings & Basic
{t:'你好！',p:'Nǐ hǎo!',m:'Xin chào!',w:''},
{t:'謝謝。',p:'Xièxiè.',m:'Cảm ơn.',w:''},
{t:'對不起。',p:'Duìbùqǐ.',m:'Xin lỗi.',w:''},
{t:'沒關係。',p:'Méi guānxì.',m:'Không sao.',w:''},
{t:'再見！',p:'Zàijiàn!',m:'Tạm biệt!',w:''},
{t:'早安！',p:'Zǎo ān!',m:'Chào buổi sáng!',w:''},
{t:'晚安！',p:'Wǎn ān!',m:'Chúc ngủ ngon!',w:''},
{t:'請坐。',p:'Qǐng zuò.',m:'Mời ngồi.',w:''},
{t:'請等一下。',p:'Qǐng děng yīxià.',m:'Xin đợi một chút.',w:''},
{t:'沒問題。',p:'Méi wèntí.',m:'Không vấn đề.',w:''},
{t:'今天天氣很好。',p:'Jīntiān tiānqì hěn hǎo.',m:'Hôm nay thời tiết rất đẹp.',w:'今天氣很好'},
{t:'今天很熱。',p:'Jīntiān hěn rè.',m:'Hôm nay rất nóng.',w:'今天很熱'},
{t:'今天很冷。',p:'Jīntiān hěn lěng.',m:'Hôm nay rất lạnh.',w:'今天很冷'},
{t:'現在幾點了？',p:'Xiànzài jǐ diǎn le?',m:'Bây giờ mấy giờ rồi?',w:'現在幾點了'},
{t:'現在三點半。',p:'Xiànzài sān diǎn bàn.',m:'Bây giờ 3 rưỡi.',w:'現在三點半'},
{t:'我早上六點起床。',p:'Wǒ zǎoshang liù diǎn qǐchuáng.',m:'Tôi thức dậy lúc 6 giờ sáng.',w:'我早上六點起床'},
{t:'我晚上十點睡覺。',p:'Wǒ wǎnshang shí diǎn shuìjiào.',m:'Tôi đi ngủ lúc 10 giờ tối.',w:'我晚上十點睡覺'},
{t:'我每天走路去上班。',p:'Wǒ měitiān zǒulù qù shàngbān.',m:'Mỗi ngày tôi đi bộ đi làm.',w:'我每天走路去上班'},
{t:'我坐公車去學校。',p:'Wǒ zuò gōngchē qù xuéxiào.',m:'Tôi đi xe buýt đến trường.',w:'我坐公車去學校'},
{t:'今天星期幾？',p:'Jīntiān xīngqí jǐ?',m:'Hôm nay thứ mấy?',w:'今天星期幾'},
{t:'今天是星期一。',p:'Jīntiān shì xīngqí yī.',m:'Hôm nay là thứ Hai.',w:'今天是星期一'},
{t:'你叫什麼名字？',p:'Nǐ jiào shénme míngzì?',m:'Bạn tên là gì?',w:'你叫什麼名字'},
{t:'我姓王。',p:'Wǒ xìng Wáng.',m:'Tôi họ Vương.',w:'我姓王'},
{t:'我住在台北。',p:'Wǒ zhù zài Táiběi.',m:'Tôi sống ở Đài Bắc.',w:'我住在台北'},
{t:'你家有幾個人？',p:'Nǐ jiā yǒu jǐ ge rén?',m:'Nhà bạn có mấy người?',w:'你家有幾個人'},
{t:'我家有四個人。',p:'Wǒ jiā yǒu sì ge rén.',m:'Nhà tôi có 4 người.',w:'我家有四個人'},
{t:'這是我爸爸。',p:'Zhè shì wǒ bàba.',m:'Đây là bố tôi.',w:'這是我爸爸'},
{t:'那是我媽媽。',p:'Nà shì wǒ māma.',m:'Kia là mẹ tôi.',w:'那是我媽媽'},
{t:'他有兩個妹妹。',p:'Tā yǒu liǎng ge mèimei.',m:'Anh ấy có 2 em gái.',w:'他有兩個妹妹'},
{t:'我喜歡看書。',p:'Wǒ xǐhuān kàn shū.',m:'Tôi thích đọc sách.',w:'我喜歡看書'},
{t:'你喜歡做什麼？',p:'Nǐ xǐhuān zuò shénme?',m:'Bạn thích làm gì?',w:'你喜歡做什麼'},
{t:'我喜歡聽音樂。',p:'Wǒ xǐhuān tīng yīnyuè.',m:'Tôi thích nghe nhạc.',w:'我喜歡聽音樂'},
{t:'我不喜歡運動。',p:'Wǒ bù xǐhuān yùndòng.',m:'Tôi không thích thể thao.',w:'我不喜歡運動'},
{t:'你會說中文嗎？',p:'Nǐ huì shuō Zhōngwén ma?',m:'Bạn biết nói tiếng Trung không?',w:'你會說中文嗎'},
{t:'我會說一點點。',p:'Wǒ huì shuō yīdiǎndiǎn.',m:'Tôi biết nói một chút.',w:'我會說一點點'},
{t:'請再說一次。',p:'Qǐng zài shuō yīcì.',m:'Làm ơn nói lại lần nữa.',w:'請再說一次'},
{t:'這是什麼？',p:'Zhè shì shénme?',m:'Đây là cái gì?',w:'這是什麼'},
{t:'我不知道。',p:'Wǒ bù zhīdào.',m:'Tôi không biết.',w:'我不知道'},
{t:'我知道了。',p:'Wǒ zhīdào le.',m:'Tôi biết rồi.',w:'我知道了'},
{t:'你聽得懂嗎？',p:'Nǐ tīng de dǒng ma?',m:'Bạn nghe hiểu không?',w:'你聽得懂嗎'},
{t:'聽不懂。',p:'Tīng bù dǒng.',m:'Nghe không hiểu.',w:'聽不懂'},
{t:'你吃飯了嗎？',p:'Nǐ chīfàn le ma?',m:'Bạn ăn cơm chưa?',w:'你吃飯了嗎'},
{t:'我吃飽了。',p:'Wǒ chī bǎo le.',m:'Tôi ăn no rồi.',w:'我吃飽了'},
{t:'你想喝什麼？',p:'Nǐ xiǎng hē shénme?',m:'Bạn muốn uống gì?',w:'你想喝什麼'},
{t:'我要喝水。',p:'Wǒ yào hē shuǐ.',m:'Tôi muốn uống nước.',w:'我要喝水'},
{t:'這個很好吃。',p:'Zhège hěn hǎochī.',m:'Cái này rất ngon.',w:'這個很好吃'},
{t:'我不喝咖啡。',p:'Wǒ bù hē kāfēi.',m:'Tôi không uống cà phê.',w:'我不喝咖啡'},
{t:'一共多少錢？',p:'Yīgòng duōshǎo qián?',m:'Tổng cộng bao nhiêu tiền?',w:'一共多少錢'},
{t:'太貴了！',p:'Tài guì le!',m:'Đắt quá!',w:'太貴了'},
{t:'可以便宜一點嗎？',p:'Kěyǐ piányí yīdiǎn ma?',m:'Có thể rẻ hơn chút không?',w:'可以便宜一點嗎'},
{t:'我要這個。',p:'Wǒ yào zhège.',m:'Tôi muốn cái này.',w:'我要這個'},
{t:'洗手間在哪裡？',p:'Xǐshǒujiān zài nǎlǐ?',m:'Nhà vệ sinh ở đâu?',w:'洗手間在哪裡'},
{t:'前面左轉。',p:'Qiánmiàn zuǒ zhuǎn.',m:'Phía trước rẽ trái.',w:'前面左轉'},
{t:'在右邊。',p:'Zài yòubiān.',m:'Ở bên phải.',w:'在右邊'},
{t:'這裡可以拍照嗎？',p:'Zhèlǐ kěyǐ pāizhào ma?',m:'Ở đây có thể chụp ảnh không?',w:'這裡可以拍照嗎'},
{t:'我迷路了。',p:'Wǒ mílù le.',m:'Tôi bị lạc đường rồi.',w:'我迷路了'},
{t:'我生病了。',p:'Wǒ shēngbìng le.',m:'Tôi bị ốm rồi.',w:'我生病了'},
{t:'我頭痛。',p:'Wǒ tóutòng.',m:'Tôi bị đau đầu.',w:'我頭痛'},
{t:'你的手機號碼是多少？',p:'Nǐ de shǒujī hàomǎ shì duōshǎo?',m:'Số điện thoại của bạn là gì?',w:'你的手機號碼是多少'},
{t:'有空的時候打電話給我。',p:'Yǒu kòng de shíhòu dǎ diànhuà gěi wǒ.',m:'Khi rảnh gọi điện cho tôi.',w:'有空的時候打電話給我'},
{t:'生日快樂！',p:'Shēngrì kuàilè!',m:'Sinh nhật vui vẻ!',w:'生日快樂'},
{t:'新年快樂！',p:'Xīnnián kuàilè!',m:'Chúc mừng năm mới!',w:'新年快樂'},
{t:'加油！',p:'Jiāyóu!',m:'Cố lên!',w:''},
{t:'小心！',p:'Xiǎoxīn!',m:'Cẩn thận!',w:''},
// Time & Daily
{t:'早安！',p:'Zǎo ān!',m:'Chào buổi sáng!',w:''},
{t:'晚安！',p:'Wǎn ān!',m:'Chúc ngủ ngon!',w:''},
{t:'現在幾點了？',p:'Xiànzài jǐ diǎn le?',m:'Bây giờ mấy giờ rồi?',w:'現在幾點了'},
{t:'現在三點半。',p:'Xiànzài sān diǎn bàn.',m:'Bây giờ 3 rưỡi.',w:'現在三點半'},
{t:'今天星期幾？',p:'Jīntiān xīngqí jǐ?',m:'Hôm nay thứ mấy?',w:'今天星期幾'},
{t:'今天是星期一。',p:'Jīntiān shì xīngqí yī.',m:'Hôm nay là thứ Hai.',w:'今天是星期一'},
{t:'我早上六點起床。',p:'Wǒ zǎoshang liù diǎn qǐchuáng.',m:'Tôi thức dậy lúc 6 giờ sáng.',w:'我早上六點起床'},
{t:'我晚上十點睡覺。',p:'Wǒ wǎnshang shí diǎn shuìjiào.',m:'Tôi đi ngủ lúc 10 giờ tối.',w:'我晚上十點睡覺'},
// Weather
{t:'今天天氣很好。',p:'Jīntiān tiānqì hěn hǎo.',m:'Hôm nay thời tiết rất đẹp.',w:'今天氣很好'},
{t:'今天很熱。',p:'Jīntiān hěn rè.',m:'Hôm nay rất nóng.',w:'今天很熱'},
{t:'今天很冷。',p:'Jīntiān hěn lěng.',m:'Hôm nay rất lạnh.',w:'今天很冷'},
{t:'外面下雨了。',p:'Wàimiàn xià yǔ le.',m:'Bên ngoài mưa rồi.',w:'外面下雨了'},
{t:'明天會不會下雪？',p:'Míngtiān huì bu huì xià xuě?',m:'Mai có tuyết rơi không?',w:'明天會不會下雪'},
// Personal Info
{t:'你叫什麼名字？',p:'Nǐ jiào shénme míngzì?',m:'Bạn tên là gì?',w:'你叫什麼名字'},
{t:'我姓王。',p:'Wǒ xìng Wáng.',m:'Tôi họ Vương.',w:'我姓王'},
{t:'我住在台北。',p:'Wǒ zhù zài Táiběi.',m:'Tôi sống ở Đài Bắc.',w:'我住在台北'},
{t:'你家有幾個人？',p:'Nǐ jiā yǒu jǐ ge rén?',m:'Nhà bạn có mấy người?',w:'你家有幾個人'},
{t:'我家有四個人。',p:'Wǒ jiā yǒu sì ge rén.',m:'Nhà tôi có 4 người.',w:'我家有四個人'},
{t:'這是我爸爸。',p:'Zhè shì wǒ bàba.',m:'Đây là bố tôi.',w:'這是我爸爸'},
{t:'那是我媽媽。',p:'Nà shì wǒ māma.',m:'Kia là mẹ tôi.',w:'那是我媽媽'},
{t:'他有兩個妹妹。',p:'Tā yǒu liǎng ge mèimei.',m:'Anh ấy có 2 em gái.',w:'他有兩個妹妹'},
{t:'我今年二十歲。',p:'Wǒ jīnnián èrshí suì.',m:'Năm nay tôi 20 tuổi.',w:'我今年二十歲'},
// Hobbies & Preferences
{t:'我喜歡看書。',p:'Wǒ xǐhuān kàn shū.',m:'Tôi thích đọc sách.',w:'我喜歡看書'},
{t:'你喜歡做什麼？',p:'Nǐ xǐhuān zuò shénme?',m:'Bạn thích làm gì?',w:'你喜歡做什麼'},
{t:'我喜歡聽音樂。',p:'Wǒ xǐhuān tīng yīnyuè.',m:'Tôi thích nghe nhạc.',w:'我喜歡聽音樂'},
{t:'我不喜歡運動。',p:'Wǒ bù xǐhuān yùndòng.',m:'Tôi không thích thể thao.',w:'我不喜歡運動'},
{t:'他很會唱歌。',p:'Tā hěn huì chànggē.',m:'Anh ấy hát rất hay.',w:'他很會唱歌'},
{t:'我每天看電視。',p:'Wǒ měitiān kàn diànshì.',m:'Mỗi ngày tôi xem TV.',w:'我每天看電視'},
// Language & Communication
{t:'你會說中文嗎？',p:'Nǐ huì shuō Zhōngwén ma?',m:'Bạn biết nói tiếng Trung không?',w:'你會說中文嗎'},
{t:'我會說一點點。',p:'Wǒ huì shuō yīdiǎndiǎn.',m:'Tôi biết nói một chút.',w:'我會說一點點'},
{t:'請再說一次。',p:'Qǐng zài shuō yīcì.',m:'Làm ơn nói lại lần nữa.',w:'請再說一次'},
{t:'這是什麼？',p:'Zhè shì shénme?',m:'Đây là cái gì?',w:'這是什麼'},
{t:'我不知道。',p:'Wǒ bù zhīdào.',m:'Tôi không biết.',w:'我不知道'},
{t:'我知道了。',p:'Wǒ zhīdào le.',m:'Tôi biết rồi.',w:'我知道了'},
{t:'你聽得懂嗎？',p:'Nǐ tīng de dǒng ma?',m:'Bạn nghe hiểu không?',w:'你聽得懂嗎'},
{t:'聽不懂。',p:'Tīng bù dǒng.',m:'Nghe không hiểu.',w:'聽不懂'},
{t:'請說慢一點。',p:'Qǐng shuō màn yīdiǎn.',m:'Làm ơn nói chậm hơn.',w:'請說慢一點'},
{t:'這個字怎麼寫？',p:'Zhège zì zěnme xiě?',m:'Chữ này viết thế nào?',w:'這個字怎麼寫'},
// Food & Drinks
{t:'你吃飯了嗎？',p:'Nǐ chīfàn le ma?',m:'Bạn ăn cơm chưa?',w:'你吃飯了嗎'},
{t:'我吃飽了。',p:'Wǒ chī bǎo le.',m:'Tôi ăn no rồi.',w:'我吃飽了'},
{t:'你想喝什麼？',p:'Nǐ xiǎng hē shénme?',m:'Bạn muốn uống gì?',w:'你想喝什麼'},
{t:'我要喝水。',p:'Wǒ yào hē shuǐ.',m:'Tôi muốn uống nước.',w:'我要喝水'},
{t:'這個很好吃。',p:'Zhège hěn hǎochī.',m:'Cái này rất ngon.',w:'這個很好吃'},
{t:'我不喝咖啡。',p:'Wǒ bù hē kāfēi.',m:'Tôi không uống cà phê.',w:'我不喝咖啡'},
{t:'你吃素嗎？',p:'Nǐ chī sù ma?',m:'Bạn ăn chay không?',w:'你吃素嗎'},
{t:'我喜歡吃水果。',p:'Wǒ xǐhuān chī shuǐguǒ.',m:'Tôi thích ăn hoa quả.',w:'我喜歡吃水果'},
{t:'太辣了！',p:'Tài là le!',m:'Cay quá!',w:'太辣了'},
{t:'不要放糖。',p:'Bú yào fàng táng.',m:'Đừng cho đường.',w:'不要放糖'},
// Shopping & Money
{t:'一共多少錢？',p:'Yīgòng duōshǎo qián?',m:'Tổng cộng bao nhiêu tiền?',w:'一共多少錢'},
{t:'太貴了！',p:'Tài guì le!',m:'Đắt quá!',w:'太貴了'},
{t:'可以便宜一點嗎？',p:'Kěyǐ piányí yīdiǎn ma?',m:'Có thể rẻ hơn chút không?',w:'可以便宜一點嗎'},
{t:'我要這個。',p:'Wǒ yào zhège.',m:'Tôi muốn cái này.',w:'我要這個'},
{t:'可以試穿嗎？',p:'Kěyǐ shì chuān ma?',m:'Có thể mặc thử không?',w:'可以試穿嗎'},
{t:'有沒有大一點的？',p:'Yǒu méiyǒu dà yīdiǎn de?',m:'Có cái to hơn không?',w:'有沒有大一點的'},
{t:'這個多少錢？',p:'Zhège duōshǎo qián?',m:'Cái này bao nhiêu tiền?',w:'這個多少錢'},
{t:'可以刷卡嗎？',p:'Kěyǐ shuākǎ ma?',m:'Có thể quẹt thẻ không?',w:'可以刷卡嗎'},
// Directions & Location
{t:'洗手間在哪裡？',p:'Xǐshǒujiān zài nǎlǐ?',m:'Nhà vệ sinh ở đâu?',w:'洗手間在哪裡'},
{t:'前面左轉。',p:'Qiánmiàn zuǒ zhuǎn.',m:'Phía trước rẽ trái.',w:'前面左轉'},
{t:'在右邊。',p:'Zài yòubiān.',m:'Ở bên phải.',w:'在右邊'},
{t:'這裡可以拍照嗎？',p:'Zhèlǐ kěyǐ pāizhào ma?',m:'Ở đây có thể chụp ảnh không?',w:'這裡可以拍照嗎'},
{t:'我迷路了。',p:'Wǒ mílù le.',m:'Tôi bị lạc đường rồi.',w:'我迷路了'},
{t:'請問，車站怎麼走？',p:'Qǐngwèn, chēzhàn zěnme zǒu?',m:'Xin hỏi, đi bến xe thế nào?',w:'請問車站怎麼走'},
{t:'往前走就到了。',p:'Wǎng qián zǒu jiù dào le.',m:'Đi thẳng là đến.',w:'往前走就到了'},
{t:'離這裡遠嗎？',p:'Lí zhèlǐ yuǎn ma?',m:'Cách đây xa không?',w:'離這裡遠嗎'},
{t:'坐捷運比較快。',p:'Zuò jiéyùn bǐjiào kuài.',m:'Đi tàu điện ngầm nhanh hơn.',w:'坐捷運比較快'},
// Health & Body
{t:'我生病了。',p:'Wǒ shēngbìng le.',m:'Tôi bị ốm rồi.',w:'我生病了'},
{t:'我頭痛。',p:'Wǒ tóutòng.',m:'Tôi bị đau đầu.',w:'我頭痛'},
{t:'你哪裡不舒服？',p:'Nǐ nǎlǐ bù shūfú?',m:'Bạn khó chịu chỗ nào?',w:'你哪裡不舒服'},
{t:'我肚子痛。',p:'Wǒ dùzi tòng.',m:'Tôi đau bụng.',w:'我肚子痛'},
{t:'你要看醫生。',p:'Nǐ yào kàn yīshēng.',m:'Bạn cần khám bác sĩ.',w:'你要看醫生'},
{t:'我感冒了。',p:'Wǒ gǎnmào le.',m:'Tôi bị cảm.',w:'我感冒了'},
{t:'多喝水，多休息。',p:'Duō hē shuǐ, duō xiūxí.',m:'Uống nhiều nước, nghỉ ngơi nhiều.',w:'多喝水多休息'},
// Transportation
{t:'我每天走路去上班。',p:'Wǒ měitiān zǒulù qù shàngbān.',m:'Mỗi ngày tôi đi bộ đi làm.',w:'我每天走路去上班'},
{t:'我坐公車去學校。',p:'Wǒ zuò gōngchē qù xuéxiào.',m:'Tôi đi xe buýt đến trường.',w:'我坐公車去學校'},
{t:'坐計程車很方便。',p:'Zuò jìchéngchē hěn fāngbiàn.',m:'Đi taxi rất tiện.',w:'坐計程車很方便'},
{t:'下一站是哪裡？',p:'Xià yī zhàn shì nǎlǐ?',m:'Trạm tiếp theo là đâu?',w:'下一站是哪裡'},
{t:'我要在這裡下車。',p:'Wǒ yào zài zhèlǐ xiàchē.',m:'Tôi muốn xuống ở đây.',w:'我要在這裡下車'},
// Contact & Social
{t:'你的手機號碼是多少？',p:'Nǐ de shǒujī hàomǎ shì duōshǎo?',m:'Số điện thoại của bạn là gì?',w:'你的手機號碼是多少'},
{t:'有空的時候打電話給我。',p:'Yǒu kòng de shíhòu dǎ diànhuà gěi wǒ.',m:'Khi rảnh gọi điện cho tôi.',w:'有空的時候打電話給我'},
{t:'我們加個好友吧。',p:'Wǒmen jiā ge hǎoyǒu ba.',m:'Chúng ta kết bạn đi.',w:'我們加個好友吧'},
{t:'你有微信嗎？',p:'Nǐ yǒu wēixìn ma?',m:'Bạn có WeChat không?',w:'你有微信嗎'},
// Celebrations
{t:'生日快樂！',p:'Shēngrì kuàilè!',m:'Sinh nhật vui vẻ!',w:'生日快樂'},
{t:'新年快樂！',p:'Xīnnián kuàilè!',m:'Chúc mừng năm mới!',w:'新年快樂'},
{t:'恭喜發財！',p:'Gōngxǐ fācái!',m:'Chúc mừng phát tài!',w:'恭喜發財'},
// Polite Requests
{t:'請坐。',p:'Qǐng zuò.',m:'Mời ngồi.',w:''},
{t:'請等一下。',p:'Qǐng děng yīxià.',m:'Xin đợi một chút.',w:''},
{t:'沒問題。',p:'Méi wèntí.',m:'Không vấn đề.',w:''},
{t:'麻煩你了。',p:'Máfan nǐ le.',m:'Làm phiền bạn rồi.',w:'麻煩你了'},
{t:'不客氣。',p:'Bù kèqì.',m:'Không khách khí.',w:'不客氣'},
{t:'請進。',p:'Qǐng jìn.',m:'Mời vào.',w:'請進'},
{t:'慢走。',p:'Màn zǒu.',m:'Đi cẩn thận.',w:'慢走'},
// Additional A1/A2
{t:'你幾點下班？',p:'Nǐ jǐ diǎn xiàbān?',m:'Mấy giờ bạn tan làm?',w:'你幾點下班'},
{t:'我們一起去吧。',p:'Wǒmen yīqǐ qù ba.',m:'Chúng ta cùng đi nhé.',w:'我們一起去吧'},
{t:'你在做什麼？',p:'Nǐ zài zuò shénme?',m:'Bạn đang làm gì?',w:'你在做什麼'},
{t:'我在看書。',p:'Wǒ zài kàn shū.',m:'Tôi đang đọc sách.',w:'我在看書'},
{t:'這本書很有趣。',p:'Zhè běn shū hěn yǒuqù.',m:'Quyển sách này rất thú vị.',w:'這本書很有趣'},
{t:'你有空嗎？',p:'Nǐ yǒu kòng ma?',m:'Bạn có rảnh không?',w:'你有空嗎'},
{t:'我很忙。',p:'Wǒ hěn máng.',m:'Tôi rất bận.',w:'我很忙'},
{t:'今天是我的生日。',p:'Jīntiān shì wǒ de shēngrì.',m:'Hôm nay là sinh nhật tôi.',w:'今天是我的生日'},
{t:'你想去哪裡？',p:'Nǐ xiǎng qù nǎlǐ?',m:'Bạn muốn đi đâu?',w:'你想去哪裡'},
{t:'我想去公園。',p:'Wǒ xiǎng qù gōngyuán.',m:'Tôi muốn đi công viên.',w:'我想去公園'},
{t:'這裡的東西很便宜。',p:'Zhèlǐ de dōngxi hěn piányí.',m:'Đồ ở đây rất rẻ.',w:'這裡的東西很便宜'},
{t:'你會不會游泳？',p:'Nǐ huì bu huì yóuyǒng?',m:'Bạn có biết bơi không?',w:'你會不會游泳'},
{t:'我不會騎腳踏車。',p:'Wǒ bú huì qí jiǎotàchē.',m:'Tôi không biết đạp xe.',w:'我不會騎腳踏車'},
{t:'他長得很高。',p:'Tā zhǎng de hěn gāo.',m:'Anh ấy cao lắm.',w:'他長得很高'},
{t:'她的頭髮很長。',p:'Tā de tóufǎ hěn cháng.',m:'Tóc cô ấy rất dài.',w:'她的頭髮很長'},
{t:'這件衣服很漂亮。',p:'Zhè jiàn yīfu hěn piàoliang.',m:'Quần áo này rất đẹp.',w:'這件衣服很漂亮'},
{t:'你要不要試試看？',p:'Nǐ yào bu yào shìshì kàn?',m:'Bạn có muốn thử xem không?',w:'你要不要試試看'},
{t:'我找不到我的鑰匙。',p:'Wǒ zhǎo bu dào wǒ de yàoshi.',m:'Tôi không tìm thấy chìa khóa.',w:'我找不到我的鑰匙'},
{t:'放在桌子上。',p:'Fàng zài zhuōzi shàng.',m:'Để trên bàn.',w:'放在桌子上'},
{t:'你看到我的手機了嗎？',p:'Nǐ kàn dào wǒ de shǒujī le ma?',m:'Bạn thấy điện thoại của tôi chưa?',w:'你看到我的手機了嗎'},
{t:'在沙發旁邊。',p:'Zài shāfā pángbiān.',m:'Ở cạnh ghế sofa.',w:'在沙發旁邊'},
{t:'你累不累？',p:'Nǐ lèi bu lèi?',m:'Bạn có mệt không?',w:'你累不累'},
{t:'有一點累。',p:'Yǒu yīdiǎn lèi.',m:'Có chút mệt.',w:'有一點累'},
{t:'我們休息一下吧。',p:'Wǒmen xiūxí yīxià ba.',m:'Chúng ta nghỉ một chút nhé.',w:'我們休息一下吧'},
{t:'外面太吵了。',p:'Wàimiàn tài chǎo le.',m:'Bên ngoài ồn quá.',w:'外面太吵了'},
{t:'請關門。',p:'Qǐng guān mén.',m:'Làm ơn đóng cửa.',w:'請關門'},
{t:'開燈。',p:'Kāi dēng.',m:'Bật đèn.',w:'開燈'},
{t:'房間裡很暗。',p:'Fángjiān lǐ hěn àn.',m:'Trong phòng rất tối.',w:'房間裡很暗'},
{t:'你的中文說得很好。',p:'Nǐ de Zhōngwén shuō de hěn hǎo.',m:'Tiếng Trung của bạn nói rất tốt.',w:'你的中文說得很好'},
{t:'哪裡哪裡。',p:'Nǎlǐ nǎlǐ.',m:'Tôi còn kém lắm.',w:'哪裡哪裡'},
{t:'你學了多久？',p:'Nǐ xué le duōjiǔ?',m:'Bạn học được bao lâu rồi?',w:'你學了多久'},
{t:'我學了一年。',p:'Wǒ xué le yī nián.',m:'Tôi học được 1 năm.',w:'我學了一年'},
{t:'你的老師是誰？',p:'Nǐ de lǎoshī shì shéi?',m:'Giáo viên của bạn là ai?',w:'你的老師是誰'},
{t:'她是王老師。',p:'Tā shì Wáng lǎoshī.',m:'Cô ấy là cô Vương.',w:'她是王老師'},
{t:'明天有考試。',p:'Míngtiān yǒu kǎoshì.',m:'Mai có kiểm tra.',w:'明天有考試'},
{t:'你準備好了嗎？',p:'Nǐ zhǔnbèi hǎo le ma?',m:'Bạn chuẩn bị xong chưa?',w:'你準備好了嗎'},
{t:'還沒。',p:'Hái méi.',m:'Chưa.',w:'還沒'},
{t:'快一點！',p:'Kuài yīdiǎn!',m:'Nhanh lên!',w:'快一點'},
{t:'來不及了。',p:'Lái bùjí le.',m:'Không kịp rồi.',w:'來不及了'},
{t:'別擔心。',p:'Bié dānxīn.',m:'Đừng lo.',w:'別擔心'},
{t:'會沒事的。',p:'Huì méishì de.',m:'Sẽ không sao đâu.',w:'會沒事的'},
{t:'祝你好運！',p:'Zhù nǐ hǎo yùn!',m:'Chúc bạn may mắn!',w:'祝你好運'},
{t:'謝謝你的幫忙。',p:'Xièxiè nǐ de bāngmáng.',m:'Cảm ơn sự giúp đỡ của bạn.',w:'謝謝你的幫忙'},
{t:'不用謝。',p:'Búyòng xiè.',m:'Không cần cảm ơn.',w:'不用謝'},
{t:'我可以幫你嗎？',p:'Wǒ kěyǐ bāng nǐ ma?',m:'Tôi có thể giúp bạn không?',w:'我可以幫你嗎'},
{t:'真的嗎？',p:'Zhēn de ma?',m:'Thật không?',w:'真的嗎'},
{t:'當然。',p:'Dāngrán.',m:'Đương nhiên.',w:'當然'},
{t:'太好了！',p:'Tài hǎo le!',m:'Tuyệt quá!',w:'太好了'},
{t:'這個主意不錯。',p:'Zhège zhǔyì búcuò.',m:'Ý tưởng này không tồi.',w:'這個主意不錯'},
{t:'我同意。',p:'Wǒ tóngyì.',m:'Tôi đồng ý.',w:'我同意'},
{t:'就這樣決定了。',p:'Jiù zhèyàng juédìng le.',m:'Vậy quyết định thế.',w:'就這樣決定了'},
{t:'明天見。',p:'Míngtiān jiàn.',m:'Mai gặp.',w:'明天見'},
{t:'回家小心。',p:'Huí jiā xiǎoxīn.',m:'Về nhà cẩn thận.',w:'回家小心'},
{t:'路上小心。',p:'Lùshàng xiǎoxīn.',m:'Đi đường cẩn thận.',w:'路上小心'},
// ── batch v3.4.0: 25 câu mới ──
{t:'你喜歡吃什麼？',p:'Nǐ xǐhuān chī shénme?',m:'Bạn thích ăn gì?',w:'你喜歡吃什麼'},
{t:'我覺得很累。',p:'Wǒ juéde hěn lèi.',m:'Tôi cảm thấy rất mệt.',w:'我覺得很累'},
{t:'這個多少錢？',p:'Zhège duōshǎo qián?',m:'Cái này bao nhiêu tiền?',w:'這個多少錢'},
{t:'你住在哪裡？',p:'Nǐ zhù zài nǎlǐ?',m:'Bạn sống ở đâu?',w:'你住在哪裡'},
{t:'明天天氣怎麼樣？',p:'Míngtiān tiānqì zěnme yàng?',m:'Ngày mai thời tiết thế nào?',w:'明天天氣怎麼樣'},
{t:'我昨天很晚才回家。',p:'Wǒ zuótiān hěn wǎn cái huí jiā.',m:'Hôm qua tôi về nhà rất muộn.',w:'我昨天很晚才回家'},
{t:'可以幫我一下嗎？',p:'Kěyǐ bāng wǒ yīxià ma?',m:'Có thể giúp tôi một chút không?',w:'可以幫我一下嗎'},
{t:'這是什麼意思？',p:'Zhè shì shénme yìsī?',m:'Cái này có ý nghĩa gì?',w:'這是什麼意思'},
{t:'我聽不太懂。',p:'Wǒ tīng bú tài dǒng.',m:'Tôi nghe không hiểu lắm.',w:'我聽不太懂'},
{t:'你會不會說英文？',p:'Nǐ huì bu huì shuō Yīngwén?',m:'Bạn có biết nói tiếng Anh không?',w:'你會不會說英文'},
{t:'我想去旅行。',p:'Wǒ xiǎng qù lǚxíng.',m:'Tôi muốn đi du lịch.',w:'我想去旅行'},
{t:'最近很忙。',p:'Zuìjìn hěn máng.',m:'Gần đây rất bận.',w:'最近很忙'},
{t:'你有幾個兄弟姊妹？',p:'Nǐ yǒu jǐ ge xiōngdì jiěmèi?',m:'Bạn có mấy anh chị em?',w:'你有幾個兄弟姊妹'},
{t:'我很想家。',p:'Wǒ hěn xiǎng jiā.',m:'Tôi rất nhớ nhà.',w:'我很想家'},
{t:'你家離這裡遠不遠？',p:'Nǐ jiā lí zhèlǐ yuǎn bu yuǎn?',m:'Nhà bạn cách đây có xa không?',w:'你家離這裡遠不遠'},
{t:'我已經吃飽了。',p:'Wǒ yǐjīng chī bǎo le.',m:'Tôi đã ăn no rồi.',w:'我已經吃飽了'},
{t:'這個菜太鹹了。',p:'Zhège cài tài xián le.',m:'Món này mặn quá.',w:'這個菜太鹹了'},
{t:'你有沒有時間？',p:'Nǐ yǒu méiyǒu shíjiān?',m:'Bạn có thời gian không?',w:'你有沒有時間'},
{t:'我們幾點見面？',p:'Wǒmen jǐ diǎn jiànmiàn?',m:'Mấy giờ chúng ta gặp?',w:'我們幾點見面'},
{t:'請等我五分鐘。',p:'Qǐng děng wǒ wǔ fēnzhōng.',m:'Làm ơn đợi tôi 5 phút.',w:'請等我五分鐘'},
{t:'你穿這件很好看。',p:'Nǐ chuān zhè jiàn hěn hǎokàn.',m:'Bạn mặc cái này rất đẹp.',w:'你穿這件很好看'},
{t:'我今天不太舒服。',p:'Wǒ jīntiān bú tài shūfú.',m:'Hôm nay tôi không được khỏe.',w:'我今天不太舒服'},
{t:'你怎麼了？',p:'Nǐ zěnme le?',m:'Bạn làm sao thế?',w:'你怎麼了'},
{t:'時間快到了。',p:'Shíjiān kuài dào le.',m:'Sắp đến giờ rồi.',w:'時間快到了'},
{t:'祝你一路順風。',p:'Zhù nǐ yīlù shùnfēng.',m:'Chúc bạn thượng lộ bình an.',w:'祝你一路順風'},
];

// ── #1: Dialog-based Quiz (mini conversations) ──
const SENT_DIALOGS=[
  {scene:'餐廳',lines:[
    {sp:'A',t:'你想吃什麼？',m:'Bạn muốn ăn gì?'},
    {sp:'B',t:'我想吃{thức ăn}。',m:'Tôi muốn ăn {thức ăn}.',blank:true,cat:'thức ăn',pf:w=>'Wǒ xiǎng chī '+w.p+'.',mf:w=>'Tôi muốn ăn '+w.m+'.'}
  ]},
  {scene:'問路',lines:[
    {sp:'A',t:'請問，車站怎麼走？',m:'Xin hỏi, đi bến xe thế nào?'},
    {sp:'B',t:'往{hướng}邊走就到了。',m:'Đi về phía {hướng} là đến.',blank:true,cat:'hướng',pf:w=>'Wǎng '+w.p+' biān zǒu jiù dào le.',mf:w=>'Đi về phía '+w.m+' là đến.'}
  ]},
  {scene:'天氣',lines:[
    {sp:'A',t:'今天天氣怎麼樣？',m:'Hôm nay thời tiết thế nào?'},
    {sp:'B',t:'今天很{thời tiết}。',m:'Hôm nay rất {thời tiết}.',blank:true,cat:'thời tiết',pf:w=>'Jīntiān hěn '+w.p+'.',mf:w=>'Hôm nay rất '+w.m+'.'}
  ]},
  {scene:'購物',lines:[
    {sp:'A',t:'這個多少錢？',m:'Cái này bao nhiêu tiền?'},
    {sp:'B',t:'一共{số đếm}塊。',m:'Tổng cộng {số đếm} đồng.',blank:true,cat:'số đếm',pf:w=>w.p+' kuài.',mf:w=>w.m+' đồng.'}
  ]},
  {scene:'看病',lines:[
    {sp:'醫生',t:'你哪裡不舒服？',m:'Bạn khó chịu chỗ nào?'},
    {sp:'病人',t:'我{cơ thể}痛。',m:'Tôi đau {cơ thể}.',blank:true,cat:'cơ thể',pf:w=>'Wǒ '+w.p+' tòng.',mf:w=>'Tôi đau '+w.m+'.'}
  ]},
];

// ── #2: Grammar-aware templates with variants ──
const GRAMMAR_PATTERNS=[
  {base:'我喜歡{obj}',variants:['我很喜歡{obj}','我有點喜歡{obj}','我最喜歡{obj}','我不太喜歡{obj}'],cat:'thức ăn'},
  {base:'今天很{adj}',variants:['今天非常{adj}','今天有點{adj}','今天不太{adj}','今天太{adj}了'],cat:'thời tiết'},
  {base:'他是{noun}',variants:['他想當{noun}','他以前是{noun}','他不是{noun}','他也是{noun}'],cat:'nghề nghiệp'},
];

// ── Smart Sentence Generator ──
const SENT_SMART_TMP=[
  {t:'我喜歡吃{thức ăn}',pf:w=>'Wǒ xǐhuān chī '+w.p,mf:w=>'Tôi thích ăn '+w.m,w:'喜歡吃',cat:'thức ăn'},
  {t:'我喜歡喝{đồ uống}',pf:w=>'Wǒ xǐhuān hē '+w.p,mf:w=>'Tôi thích uống '+w.m,w:'喜歡喝',cat:'đồ uống'},
  {t:'今天天氣很{thời tiết}',pf:w=>'Jīntiān tiānqì hěn '+w.p,mf:w=>'Hôm nay thời tiết rất '+w.m,w:'今天天氣很',cat:'thời tiết'},
  {t:'我的{gia đình}很好',pf:w=>'Wǒ de '+w.p+' hěn hǎo',mf:w=>w.m+' của tôi rất tốt',w:'我的很好',cat:'gia đình'},
  {t:'這隻{động vật}很可愛',pf:w=>'Zhè zhī '+w.p+' hěn kěài',mf:w=>'Con '+w.m+' này rất đáng yêu',w:'這隻很可愛',cat:'động vật'},
  {t:'我穿{quần áo}',pf:w=>'Wǒ chuān '+w.p,mf:w=>'Tôi mặc '+w.m,w:'我穿',cat:'quần áo'},
  {t:'他是{nghề nghiệp}',pf:w=>'Tā shì '+w.p,mf:w=>'Anh ấy là '+w.m,w:'他是',cat:'nghề nghiệp'},
  {t:'這個{màu sắc}很好看',pf:w=>'Zhège '+w.p+' hěn hǎokàn',mf:w=>'Màu '+w.m+' này rất đẹp',w:'這個很好看',cat:'màu sắc'},
  {t:'{hoa quả}很好吃',pf:w=>w.p+' hěn hǎochī',mf:w=>w.m+' rất ngon',w:'很好吃',cat:'hoa quả'},
  {t:'我{vị}這個',pf:w=>'Wǒ '+w.p+' zhège',mf:w=>'Tôi thấy cái này '+w.m,w:'我這個',cat:'vị'},
  {t:'在{trường học}學習',pf:w=>'Zài '+w.p+' xuéxí',mf:w=>'Học ở '+w.m,w:'在學習',cat:'trường học'},
  {t:'我的{cơ thể}疼',pf:w=>'Wǒ de '+w.p+' téng',mf:w=>w.m+' của tôi bị đau',w:'我的疼',cat:'cơ thể'},
  {t:'{hướng}邊有',pf:w=>w.p+' biān yǒu',mf:w=>'Bên '+w.m+' có',w:'邊有',cat:'hướng'},
  {t:'我很{cảm xúc}',pf:w=>'Wǒ hěn '+w.p,mf:w=>'Tôi rất '+w.m,w:'我很',cat:'cảm xúc'},
  {t:'現在{thời gian}',pf:w=>'Xiànzài '+w.p,mf:w=>'Bây giờ là '+w.m,w:'現在',cat:'thời gian'},
  {t:'我吃{số đếm}個',pf:w=>'Wǒ chī '+w.p+' ge',mf:w=>'Tôi ăn '+w.m+' cái',w:'我吃個',cat:'số đếm'},
  // ── batch 2 ──
  {t:'我不喜歡吃{thức ăn}',pf:w=>'Wǒ bù xǐhuān chī '+w.p,mf:w=>'Tôi không thích ăn '+w.m,w:'不喜歡吃',cat:'thức ăn'},
  {t:'今天有{thời tiết}嗎',pf:w=>'Jīntiān yǒu '+w.p+' ma',mf:w=>'Hôm nay có '+w.m+' không',w:'今天有嗎',cat:'thời tiết'},
  {t:'你{cảm xúc}嗎',pf:w=>'Nǐ '+w.p+' ma',mf:w=>'Bạn có '+w.m+' không',w:'你嗎',cat:'cảm xúc'},
  {t:'我有{số đếm}個{gia đình}',pf:(w,w2)=>'Wǒ yǒu '+w.p+' ge '+w2.p,mf:(w,w2)=>'Tôi có '+w.m+' người '+w2.m,w:'我有個',cat:'số đếm',cat2:'gia đình'},
  {t:'{động vật}在{hướng}邊',pf:(w,w2)=>w.p+' zài '+w2.p+' biān',mf:(w,w2)=>w.m+' ở bên '+w2.m,w:'在邊',cat:'động vật',cat2:'hướng'},
  {t:'我買了{số đếm}個{hoa quả}',pf:(w,w2)=>'Wǒ mǎile '+w.p+' ge '+w2.p,mf:(w,w2)=>'Tôi đã mua '+w.m+' quả '+w2.m,w:'我買個',cat:'số đếm',cat2:'hoa quả'},
  {t:'{quần áo}是{màu sắc}的',pf:(w,w2)=>w.p+' shì '+w2.p+' de',mf:(w,w2)=>w.m+' màu '+w2.m,w:'是的',cat:'quần áo',cat2:'màu sắc'},
  {t:'我{cơ thể}不舒服',pf:w=>'Wǒ '+w.p+' bù shūfú',mf:w=>w.m+' của tôi không thoải mái',w:'我不舒服',cat:'cơ thể'},
  {t:'你在{trường học}嗎',pf:w=>'Nǐ zài '+w.p+' ma',mf:w=>'Bạn có ở '+w.m+' không',w:'你在嗎',cat:'trường học'},
  {t:'我想喝{đồ uống}',pf:w=>'Wǒ xiǎng hē '+w.p,mf:w=>'Tôi muốn uống '+w.m,w:'想喝',cat:'đồ uống'},
  {t:'這個{quần áo}多少錢',pf:w=>'Zhège '+w.p+' duōshǎo qián',mf:w=>w.m+' này bao nhiêu tiền',w:'這個多少錢',cat:'quần áo'},
  {t:'{hoa quả}和{hoa quả}哪個好吃',pf:(w,w2)=>w.p+' hé '+w2.p+' nǎge hǎochī',mf:(w,w2)=>w.m+' và '+w2.m+' cái nào ngon hơn',w:'和哪個好吃',cat:'hoa quả',cat2:'hoa quả',skipSame:1},
  {t:'我{thức ăn}和{đồ uống}都要',pf:(w,w2)=>'Wǒ '+w.p+' hé '+w2.p+' dōuyào',mf:(w,w2)=>'Tôi đều muốn cả '+w.m+' và '+w2.m,w:'我和都要',cat:'thức ăn',cat2:'đồ uống'},
  {t:'{nghề nghiệp}在{trường học}工作',pf:(w,w2)=>w.p+' zài '+w2.p+' gōngzuò',mf:(w,w2)=>w.m+' làm việc ở '+w2.m,w:'在工作',cat:'nghề nghiệp',cat2:'trường học'},
  {t:'昨天{thời gian}你做什麼',pf:w=>'Zuótiān '+w.p+' nǐ zuò shénme',mf:w=>'Hôm qua '+w.m+' bạn làm gì',w:'昨天你做什麼',cat:'thời gian'},
  {t:'{gia đình}喜歡{màu sắc}',pf:(w,w2)=>w.p+' xǐhuān '+w2.p,mf:(w,w2)=>w.m+' thích màu '+w2.m,w:'喜歡',cat:'gia đình',cat2:'màu sắc'},
  {t:'這隻{động vật}是{màu sắc}的',pf:(w,w2)=>'Zhè zhī '+w.p+' shì '+w2.p+' de',mf:(w,w2)=>'Con '+w.m+' này màu '+w2.m,w:'這隻是的',cat:'động vật',cat2:'màu sắc'},
  {t:'你的{cơ thể}很大',pf:w=>'Nǐ de '+w.p+' hěn dà',mf:w=>'của bạn rất to',w:'你的很大',cat:'cơ thể'},
  {t:'{hướng}邊有{động vật}',pf:(w,w2)=>w.p+' biān yǒu '+w2.p,mf:(w,w2)=>'Bên '+w.m+' có con '+w2.m,w:'邊有',cat:'hướng',cat2:'động vật'},
];
function _genSmartSentences(){
  let out=[];
  for(let tmpl of SENT_SMART_TMP){
    let pool=qzData.filter(r=>_getCategory(r)===tmpl.cat);
    if(!pool.length)continue;
    let picked=shuffleArray(pool).slice(0,3);
    for(let w of picked){
      let wh=(w.h||'').includes('/') ? (w.h.split('/')[Math.floor(Math.random()*w.h.split('/').length)]||'').trim() : (w.h||'').trim();
      let wp=(w.p||'').includes('/') ? (w.p.split('/')[0]||'').trim() : (w.p||'').trim();
      let wm=(w.m||'').includes('/') ? (w.m.split('/')[0]||'').trim() : (w.m||'').trim();
      let wObj={h:wh,p:wp,m:wm,id:w.id};
      let t=tmpl.t.replace('{'+tmpl.cat+'}',wh);
      let p, m;
      if(tmpl.cat2){
        let pool2=qzData.filter(r=>_getCategory(r)===tmpl.cat2&&(!tmpl.skipSame||r.id!==w.id));
        if(!pool2.length)continue;
        let w2=shuffleArray(pool2)[0];
        let w2h=(w2.h||'').includes('/') ? (w2.h.split('/')[Math.floor(Math.random()*w2.h.split('/').length)]||'').trim() : (w2.h||'').trim();
        let w2p=(w2.p||'').includes('/') ? (w2.p.split('/')[0]||'').trim() : (w2.p||'').trim();
        let w2m=(w2.m||'').includes('/') ? (w2.m.split('/')[0]||'').trim() : (w2.m||'').trim();
        let w2Obj={h:w2h,p:w2p,m:w2m,id:w2.id};
        t=t.replace('{'+tmpl.cat2+'}',w2h);
        p=tmpl.pf(wObj,w2Obj);
        m=tmpl.mf(wObj,w2Obj);
      } else {
        p=tmpl.pf(wObj);
        m=tmpl.mf(wObj);
      }
      out.push({t:t,p:p,m:m,w:tmpl.w});
    }
  }
  return out;
}

let qzSentPool=[],qzSentIdx=0;
function pickSentence(){
  if(!qzSentPool.length||qzSentIdx>=qzSentPool.length){
    let userChars=new Set();
    qzData.forEach(w=>{for(let c of (w.h||''))userChars.add(c);});
    let smart=_genSmartSentences();
    let all=[...SENT_TMP,...smart];
    let valid=all.filter(s=>!s.w||[...s.w].every(c=>userChars.has(c)));
    if(!valid.length){
      valid=all.length?all:[...SENT_TMP];
    }
    if(!valid.length)return null;
    qzSentPool=shuffleArray(valid);qzSentIdx=0;
  }
  return qzSentPool[qzSentIdx++];
}
// ── Helper replace word with boundary & case preservation ──
function _replaceWord(str, word, rep){
  let lowerStr = str.toLowerCase();
  let lowerWord = word.toLowerCase();
  let idx = lowerStr.indexOf(lowerWord);
  if (idx === -1) return null;
  // Boundary before
  if (idx > 0 && !/[\s,!.?，。？！"']/.test(str[idx - 1])) return null;
  // Boundary after
  let end = idx + word.length;
  if (end < str.length && !/[\s,!.?，。？！"']/.test(str[end])) return null;

  // Guard: Avoid double negation / double modifiers if prefix is 'không ' or 'rất '
  if (idx >= 6 && lowerStr.slice(idx - 6, idx) === 'không ') return null;
  if (idx >= 4 && (lowerStr.slice(idx - 4, idx) === 'rất ' || lowerStr.slice(idx - 4, idx) === 'hơi ')) return null;

  // Guard: Compound words like 'quần áo'
  if (lowerWord === 'áo' && idx >= 5 && lowerStr.slice(idx - 5, idx) === 'quần ') return null;
  if (lowerWord === 'quần' && end + 3 <= str.length && lowerStr.slice(end, end + 3) === ' áo') return null;

  let actualMatch = str.slice(idx, end);
  let finalRep = rep;

  // Guard: If sentence ends with question 'không?', don't insert another negation 'không' or 'chưa'
  if (/\s+không[?.]?$/i.test(str) && /\b(không|chưa)\b/i.test(finalRep)) return null;
  if (/\s+chưa[?.]?$/i.test(str) && /\bchưa\b/i.test(finalRep)) return null;

  // Preserve case: capitalize replacement only if target started with uppercase
  if (actualMatch[0] === actualMatch[0].toUpperCase() && actualMatch[0] !== actualMatch[0].toLowerCase()) {
    finalRep = rep.charAt(0).toUpperCase() + rep.slice(1);
  }
  let res = str.slice(0, idx) + finalRep + str.slice(end);

  // Guard against stutter like 'không không', 'rồi rồi', 'có có', 'rất rất'
  if (/\b(không không|rồi rồi|có có|rất rất)\b/i.test(res)) return null;
  // Guard against contradiction like 'chưa ... rồi'
  if (/\b(chưa\s+\S+\s+rồi|chưa\s+rồi)\b/i.test(res)) return null;

  return res;
}

const DIALOG_MAP = {
  'Xin chào!': ['Tạm biệt!', 'Chào buổi sáng!', 'Hẹn gặp lại!'],
  'Cảm ơn.': ['Không có chi.', 'Xin lỗi.', 'Đừng khách sáo.'],
  'Xin lỗi.': ['Không sao.', 'Không có gì.', 'Cảm ơn.'],
  'Không sao.': ['Xin lỗi.', 'Không vấn đề.', 'Rất tiếc.'],
  'Tạm biệt!': ['Hẹn gặp lại!', 'Mai gặp!', 'Đi cẩn thận nhé!'],
  'Chào buổi sáng!': ['Chúc ngủ ngon!', 'Chào buổi tối!', 'Tạm biệt!'],
  'Chúc ngủ ngon!': ['Chào buổi sáng!', 'Chào buổi tối!', 'Hẹn gặp lại!'],
  'Mời ngồi.': ['Mời uống trà.', 'Mời vào.', 'Xin đợi một chút.'],
  'Mời vào.': ['Mời ngồi.', 'Mời uống trà.', 'Xin đợi một chút.'],
  'Xin đợi một chút.': ['Mời vào.', 'Mời ngồi.', 'Đã xong rồi.'],
  'Không vấn đề.': ['Có chút vấn đề.', 'Xin lỗi.', 'Không sao.'],
  'Cố lên!': ['Đừng bỏ cuộc!', 'Nghỉ ngơi chút đi!', 'Cẩn thận nhé!'],
  'Làm ơn nói lại lần nữa.': ['Làm ơn nói chậm một chút.', 'Làm ơn viết ra đây.', 'Làm ơn đọc to lên.'],
  'Chưa.': ['Rồi.', 'Sắp rồi.', 'Đã xong.'],
  'Đúng vậy.': ['Không phải vậy.', 'Sai rồi.', 'Chưa chắc.'],
  'Không phải.': ['Đúng vậy.', 'Chính xác.', 'Phải rồi.'],
  'Mai gặp!': ['Hôm nay gặp!', 'Tuần sau gặp!', 'Tạm biệt!'],
  'Tôi không biết.': ['Tôi biết rồi.', 'Tôi hiểu rồi.', 'Tôi không nghe rõ.'],
  'Tôi biết rồi.': ['Tôi không biết.', 'Tôi chưa biết.', 'Tôi hiểu rồi.'],
  'Bao nhiêu tiền?': ['Mấy giờ rồi?', 'Ở đâu vậy?', 'Có đắt không?'],
  'Ở đâu?': ['Bao nhiêu tiền?', 'Khi nào?', 'Với ai?'],
  'Tuyệt quá!': ['Bình thường thôi.', 'Tệ thật!', 'Không hay lắm.'],
  'Tôi đồng ý.': ['Tôi không đồng ý.', 'Tôi cần suy nghĩ thêm.', 'Chưa chắc đã được.'],
  'Thật không?': ['Thật đấy.', 'Đùa đấy.', 'Không chắc lắm.'],
  'Đương nhiên.': ['Chưa chắc đâu.', 'Không hẳn vậy.', 'Tùy lúc thôi.'],
  'Ý tưởng này không tồi.': ['Ý tưởng này dở quá.', 'Tôi không thích ý này.', 'Bình thường thôi.'],
  'Về nhà cẩn thận.': ['Đi đường cẩn thận.', 'Tạm biệt nhé!', 'Mai gặp lại!'],
  'Đi đường cẩn thận.': ['Về nhà cẩn thận.', 'Tạm biệt nhé!', 'Hẹn gặp lại!'],
  'Tôi rất nhớ nhà.': ['Tôi rất vui.', 'Tôi không nhớ nhà.', 'Tôi thấy bình thường.'],
  'Món này mặn quá.': ['Món này nhạt quá.', 'Món này vừa ăn.', 'Món này ngọt quá.']
};

const ANTONYM_PAIRS = [
  // Cụm dài ưu tiên match trước
  ['không thích lắm', ['rất thích', 'khá thích']],
  ['không thích', ['rất thích', 'thích', 'khá thích']],
  ['rất thích', ['không thích', 'không thích lắm', 'rất ghét']],
  ['thích', ['không thích', 'ghét']],

  ['rất nóng', ['rất lạnh', 'mát mẻ', 'không nóng lắm']],
  ['rất lạnh', ['rất nóng', 'ấm áp', 'hơi ấm']],
  ['nóng', ['lạnh', 'mát']],
  ['lạnh', ['nóng', 'ấm']],

  ['rất đẹp', ['không đẹp lắm', 'rất xấu']],
  ['không đẹp', ['rất đẹp', 'xinh đẹp']],
  ['đẹp', ['xấu', 'không đẹp']],
  ['xấu', ['đẹp', 'dễ thương']],

  ['rất ngon', ['không ngon lắm', 'rất dở', 'khó ăn quá']],
  ['ngon quá', ['dở quá', 'không ngon lắm']],
  ['ngon', ['dở', 'không ngon']],

  ['đắt quá', ['rẻ quá', 'không đắt lắm', 'hơi đắt']],
  ['rẻ quá', ['đắt quá', 'không rẻ lắm']],
  ['quá đắt', ['quá rẻ', 'hơi đắt']],
  ['đắt', ['rẻ', 'hợp lý']],
  ['rẻ', ['đắt', 'khá đắt']],

  ['ăn no rồi', ['vẫn còn đói', 'chưa ăn no', 'chưa no lắm']],
  ['ăn no', ['chưa no', 'vẫn đói']],
  ['no rồi', ['vẫn còn đói', 'chưa no']],

  ['rất mệt', ['rất khỏe', 'không mệt lắm']],
  ['hơi mệt', ['rất khỏe', 'không mệt']],
  ['mệt', ['khỏe', 'tỉnh táo']],
  ['khỏe', ['mệt', 'bị ốm']],

  ['rất bận', ['rất rảnh', 'không bận lắm']],
  ['bận', ['rảnh', 'rảnh rỗi']],
  ['rảnh', ['bận', 'rất bận']],

  ['không hiểu', ['hiểu rồi', 'hiểu rất rõ']],
  ['hiểu rồi', ['chưa hiểu', 'không hiểu']],
  ['hiểu', ['không hiểu', 'chưa hiểu']],

  ['không biết', ['biết rất rõ', 'đã biết']],
  ['biết rồi', ['chưa biết', 'không biết']],
  ['biết', ['không biết', 'chưa rõ']],

  ['không muốn', ['rất muốn', 'muốn']],
  ['muốn', ['không muốn']],

  ['không thể', ['có thể']],
  ['có thể', ['không thể']],

  ['không có', ['có', 'có rất nhiều']],
  ['tìm thấy', ['không tìm thấy', 'chưa thấy']],

  ['đi bộ', ['đi xe buýt', 'lái xe', 'đi xe đạp']],
  ['đi xe buýt', ['đi bộ', 'đi taxi', 'đi tàu điện']],
  ['đi xe máy', ['đi bộ', 'đi xe buýt']],
  ['lái xe', ['đi bộ', 'đi xe buýt']],

  ['thức dậy', ['đi ngủ', 'nghỉ ngơi']],
  ['đi ngủ', ['thức dậy']],

  ['hôm nay', ['ngày mai', 'hôm qua']],
  ['ngày mai', ['hôm nay', 'hôm qua']],
  ['hôm qua', ['hôm nay', 'ngày mai']],
  ['mai', ['hôm nay', 'hôm qua']],

  ['bây giờ', ['lát nữa', 'trước đây', 'ngày mai']],
  ['buổi sáng', ['buổi tối', 'buổi chiều']],
  ['buổi tối', ['buổi sáng', 'buổi trưa']],
  ['buổi chiều', ['buổi sáng', 'buổi tối']],

  ['thứ hai', ['thứ ba', 'thứ bảy', 'chủ nhật']],
  ['thứ ba', ['thứ tư', 'thứ năm']],
  ['mấy giờ', ['thứ mấy', 'ngày mấy']],
  ['thứ mấy', ['mấy giờ', 'ngày mấy']],

  ['đài bắc', ['cao hùng', 'đài nam', 'đài trung']],
  ['việt nam', ['đài loan', 'trung quốc', 'nhật bản']],
  ['đài loan', ['việt nam', 'nhật bản', 'hàn quốc']],

  ['ở đâu', ['khi nào', 'bao nhiêu tiền']],
  ['bao nhiêu tiền', ['mấy giờ', 'ở đâu']],

  ['tiếng anh', ['tiếng trung', 'tiếng nhật']],
  ['tiếng trung', ['tiếng anh', 'tiếng pháp']],

  ['ở đây', ['ở đó', 'ở kia']],
  ['ở đó', ['ở đây', 'ở kia']],
  ['ở kia', ['ở đây', 'ở đó']],

  ['chụp ảnh', ['hút thuốc', 'đỗ xe', 'nghe nhạc']],
  ['nhà vệ sinh', ['cửa ra vào', 'phòng họp', 'nhà bếp']],
  ['công viên', ['siêu thị', 'trường học', 'bệnh viện']],
  ['siêu thị', ['chợ', 'công viên', 'hiệu sách']],

  ['bên trái', ['bên phải', 'phía trước']],
  ['bên phải', ['bên trái', 'phía sau']],
  ['rẽ trái', ['rẽ phải', 'đi thẳng']],
  ['rẽ phải', ['rẽ trái', 'đi thẳng']],
  ['phía trước', ['phía sau', 'bên cạnh']],
  ['bên cạnh', ['phía sau', 'phía trước']],
  ['trên bàn', ['dưới bàn', 'trong ngăn kéo']],
  ['trên', ['dưới']],
  ['dưới', ['trên']],
  ['trong', ['ngoài']],
  ['ngoài', ['trong']],

  ['to', ['nhỏ']],
  ['lớn', ['nhỏ']],
  ['nhỏ', ['to', 'lớn']],
  ['dài', ['ngắn']],
  ['ngắn', ['dài']],
  ['cao', ['thấp']],
  ['thấp', ['cao']],
  ['nhanh', ['chậm']],
  ['chậm', ['nhanh']],
  ['xa', ['gần']],
  ['gần', ['xa']],
  ['khó', ['dễ']],
  ['dễ', ['khó']],
  ['mới', ['cũ']],
  ['cũ', ['mới']],
  ['nhiều', ['ít']],
  ['ít', ['nhiều']],
  ['đúng', ['sai']],
  ['sai', ['đúng']],
  ['vui', ['buồn']],
  ['buồn', ['vui']],
  ['mua', ['bán']],
  ['bán', ['mua']],

  ['4 người', ['3 người', '5 người']],
  ['3 người', ['4 người', '2 người']],
  ['2 người', ['3 người', '4 người']],
  ['2 em gái', ['3 em gái', '1 em trai']],

  // Đại từ nhân xưng (luôn để lowercase, _replaceWord tự giữ hoa/thường)
  ['tôi', ['bạn', 'anh ấy', 'cô ấy']],
  ['bạn', ['tôi', 'anh ấy', 'cô ấy']],
  ['anh ấy', ['tôi', 'bạn', 'cô ấy']],
  ['cô ấy', ['tôi', 'bạn', 'anh ấy']]
];

const CAT_PAIRS = [
  ['uống nước', ['uống trà', 'uống cà phê', 'uống nước ngọt']],
  ['uống cà phê', ['uống trà', 'uống sữa', 'uống nước']],
  ['uống trà', ['uống cà phê', 'uống sữa', 'uống nước']],
  ['ăn táo', ['ăn dưa hấu', 'ăn chuối', 'ăn cam']],
  ['ăn cơm', ['ăn mì', 'ăn bánh mì', 'ăn phở']],
  ['táo', ['chuối', 'dưa hấu', 'cam']],
  ['chuối', ['táo', 'dưa hấu', 'nho']],
  ['màu đỏ', ['màu xanh', 'màu vàng', 'màu trắng']],
  ['màu vàng', ['màu đỏ', 'màu xanh', 'màu đen']],
  ['màu trắng', ['màu đen', 'màu đỏ', 'màu xanh']],
  ['màu xanh', ['màu đỏ', 'màu vàng', 'màu đen']],
  ['chó', ['mèo', 'chim']],
  ['mèo', ['chó', 'thỏ']],
  ['bác sĩ', ['giáo viên', 'kỹ sư', 'học sinh']],
  ['giáo viên', ['bác sĩ', 'học sinh']],
  ['quần áo', ['váy', 'giày dép', 'túi xách']],
  ['áo', ['quần', 'váy']],
  ['quần', ['áo', 'váy']],
  ['đầu', ['bụng', 'răng', 'chân']],
  ['bụng', ['đầu', 'răng', 'lưng']]
];

// ── #3: Smart Antonym & Semantic Distractor Generator ──
function _sentDistractors(s){
  let sm = s.m, cleanM = sm.trim();
  let pool = [];

  // 1. Dialog match (cho các câu giao tiếp ngắn)
  if(DIALOG_MAP[cleanM]){
    for(let opt of DIALOG_MAP[cleanM]){
      pool.push(opt);
    }
  }

  // 2. Pass 1: Thay thế từ trái nghĩa / tương phản (1 từ mỗi rule để đa dạng góc nhìn)
  for(let [word, repls] of ANTONYM_PAIRS){
    for(let rep of repls){
      let cand = _replaceWord(sm, word, rep);
      if(cand && cand !== sm && !pool.some(x => quizText(x) === quizText(cand))){
        pool.push(cand);
        break;
      }
    }
  }

  // 3. Category pairs (thay thế cùng danh mục)
  for(let [word, repls] of CAT_PAIRS){
    for(let rep of repls){
      let cand = _replaceWord(sm, word, rep);
      if(cand && cand !== sm && !pool.some(x => quizText(x) === quizText(cand))){
        pool.push(cand);
        break;
      }
    }
  }

  // 4. Pass 2: Bổ sung các biến thể trái nghĩa thứ 2 nếu pool còn < 3
  if(pool.length < 3){
    for(let [word, repls] of ANTONYM_PAIRS){
      for(let rep of repls){
        let cand = _replaceWord(sm, word, rep);
        if(cand && cand !== sm && !pool.some(x => quizText(x) === quizText(cand))){
          pool.push(cand);
          if(pool.length >= 5) break;
        }
      }
      if(pool.length >= 5) break;
    }
  }

  // Lọc trùng và loại đáp án quá sát nhau
  let deduped = [];
  for(let text of pool){
    let tooSimilar = deduped.some(ex => _levenshtein(quizText(text), quizText(ex.m)) <= 2);
    if(!tooSimilar) deduped.push({m: text});
  }

  // 5. Fallback: Lấy các câu có chung từ khóa cao nhất từ kho câu
  if(deduped.length < 3){
    let sw = sm.replace(/[.?!,，。？！]/g, ' ').split(' ').filter(w => w.trim().length > 1);
    let all = [...SENT_TMP].filter(x => x && x.m && quizText(x.m) !== quizText(sm));
    let ranked = all.map(x => {
      let xw = x.m.replace(/[.?!,，。？！]/g, ' ').split(' ').filter(w => w.trim().length > 1);
      let shared = sw.filter(w => xw.includes(w)).length;
      let score = Math.abs(x.m.length - sm.length) - (shared * 4);
      return {m: x.m, score: score};
    }).sort((a,b) => a.score - b.score);

    for(let cand of ranked){
      let tooSimilar = deduped.some(ex => _levenshtein(quizText(cand.m), quizText(ex.m)) <= 2);
      if(!tooSimilar){
        deduped.push({m: cand.m});
        if(deduped.length >= 3) break;
      }
    }
  }

  return deduped.slice(0, 3);
}
// Levenshtein distance helper
function _levenshtein(a,b){
  if(!a||!b)return Math.max(a?a.length:0,b?b.length:0);
  let m=a.length,n=b.length;
  let d=Array(m+1).fill(0).map(()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++)d[i][0]=i;
  for(let j=0;j<=n;j++)d[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      let cost=a[i-1]===b[j-1]?0:1;
      d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+cost);
    }
  }
  return d[m][n];
}
function startQuiz(){qzMode='word';window._qzWord=window._qzNow=window._qzRev=null;qzData=quizSource();if(qzData.length<4){alert('Cần ít nhất 4 từ!');return;}if(_settings.random)qzData=shuffleArray([...qzData]);qzIdx=0;qzCorrect=0;qzTotal=0;$('quizView').style.display='flex';$('fab').style.display='none';loadQuiz();}
function loadQuiz(){
  _qzAttempts=0;qzAnswered=false;
  if(qzMode==='arrange'){
    // ── #5: Arrange — xếp các từ thành câu hoàn chỉnh ──
    let arrangeSents=SENT_TMP.filter(s=>s.t.length>=4&&s.t.length<=15);
    if(!arrangeSents.length){alert('Chưa có câu phù hợp!');closeQuiz();return;}
    let s=arrangeSents[Math.floor(Math.random()*arrangeSents.length)];
    // Tách câu thành các từ (GIỮ NGUYÊN câu gốc, chỉ tách để shuffle)
    let tokens=s.t.replace(/[。？！，、]/g,'').split('');
    let answerKey=s.t.replace(/[。？！，、]/g,'');
    let shuffled=shuffleArray([...tokens]);
    window._qzArrange={s:s,tokens:tokens,userOrder:[],answerKey:answerKey,shuffled:shuffled};
    $('qzHanzi').innerHTML='<div style="min-height:64px;font-size:18px;color:var(--text-2);font-weight:600;opacity:0.7;display:flex;align-items:center;justify-content:center">Chọn từ theo thứ tự ↓</div>';
    $('qzPinyin').innerHTML='<div style="color:var(--text);font-size:16px;font-weight:500;margin-top:4px">'+esc(s.m)+'</div>';
    $('qzResult').innerHTML='';
    $('qzNext').style.visibility='hidden';qzAnswered=false;
    $('qzChoices').innerHTML='<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:480px;margin:0 auto">'+shuffled.map((tok,i)=>'<button onclick="selectToken('+i+',this)" class="qz-token" data-token="'+esc(tok)+'" style="min-width:52px;height:52px;padding:0 12px;border:2px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);font-size:28px;cursor:pointer;transition:all .15s;box-shadow:0 2px 6px rgba(0,0,0,.06);font-weight:500">'+esc(tok)+'</button>').join('')+'</div>';
    // Hiện nút Làm lại và Nghe, layout 2 dòng
    $('qzRetry').style.display='flex';
    $('qzSpeakBtn').style.display='flex';_applyHanFont();
    $('qzButtons').style.flexDirection='column';
    // Preload audio cho câu hiện tại
    _preloadEdge(s.t,'-20%');
  }else if(qzMode==='sent'){
    qzSentence=pickSentence();
    if(!qzSentence){alert('Chưa đủ từ vựng phù hợp để tạo câu. Hãy thêm từ!');closeQuiz();return;}
    let s=qzSentence;
    $('qzHanzi').textContent=s.t;$('qzHanzi').classList.add('qz-hanzi-text');$('qzHanzi').style.fontSize='clamp(32px,10vw,44px)';_applyHanFont();
    $('qzPinyin').textContent='';$('qzResult').innerHTML='';
    $('qzNext').style.visibility='hidden';qzAnswered=false;
    $('qzSpeakBtn').style.display='flex';
    let wrongPool=_sentDistractors(s);
    let choices=[{m:s.m,correct:true},...wrongPool.map(x=>({m:x.m,correct:false}))];
    choices=_dedupChoices(choices,'m');choices=_padChoices(choices,[...SENT_TMP,..._genSmartSentences()],4,'m');choices=_dedupChoices(choices,'m');choices=shuffleArray(choices);$('qzChoices').innerHTML=choices.map((c,i)=>'<button onclick="answerQuiz('+c.correct+',this)" class="qz-choice">'+'<span class=qz-label>'+String.fromCharCode(65+i)+'.</span> '+esc(c.m)+'</button>').join('');
    // Ẩn nút Làm lại, layout 1 dòng
    $('qzRetry').style.display='none';
    $('qzButtons').style.flexDirection='row';
    // Preload audio câu hiện tại + câu tiếp theo
    _preloadEdge(s.t);
    setTimeout(()=>{
      if(qzSentPool&&qzSentPool.length){
        let nextS=qzSentPool[qzSentIdx%qzSentPool.length];
        if(nextS&&nextS.t)_preloadEdge(nextS.t);
      }
    },100);
  }else if(qzMode==='listen'){
    if(qzIdx>=qzData.length){qzIdx=0;if(_settings.random)qzData=shuffleArray([...qzData]);}
    let t=qzData[qzIdx];
    $('qzHanzi').innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="display:inline-block"><use href="#i-speaker"/></svg>';
    $('qzHanzi').style.fontSize='48px';$('qzHanzi').style.fontFamily='system-ui';window._qzNow=t;
    $('qzPinyin').textContent='';$('qzResult').innerHTML='';
    $('qzNext').style.visibility='hidden';qzAnswered=false;
    let wrong=_smartDistractors(t,qzData.filter(x=>x.id!==t.id),3,true);
    let choices=[{h:t.h,p:t.p,m:t.m,id:t.id,correct:true},...wrong.map(x=>({h:x.h,p:x.p,m:x.m,id:x.id,correct:false}))];
    choices=_dedupChoices(choices,'h');choices=_padChoices(choices,qzData.filter(x=>x.id!==t.id),4,'h');choices=_dedupChoices(choices,'h');choices=shuffleArray(choices);
    $('qzChoices').innerHTML=choices.map((c,i)=>'<button onclick="answerQuiz('+c.correct+',this)" data-h="'+esc(c.h)+'" data-p="'+esc(c.p)+'" data-m="'+esc(c.m)+'" class="qz-choice" style="font-size:28px">'+'<span class=qz-label>'+String.fromCharCode(65+i)+'.</span> <span class="qz-hanzi">'+esc(c.h)+'</span></button>').join('');_applyHanFont();
    _preloadEdge(t.h);
    const listenVoice=(qzIdx%2===0)?'m':'f';
    _listenWaitEdge(t.h,0,listenVoice);
    // Ẩn nút Làm lại, layout 1 dòng
    $('qzRetry').style.display='none';
    $('qzButtons').style.flexDirection='row';
  }else if(qzMode==='rev'){
    if(qzIdx>=qzData.length){qzIdx=0;if(_settings.random)qzData=shuffleArray([...qzData]);}
    let t=qzData[qzIdx];
    $('qzHanzi').textContent=t.m;$('qzHanzi').classList.remove('qz-hanzi-text');$('qzHanzi').classList.add('qz-reverse','qz-meaning-text');$('qzHanzi').style.fontSize='clamp(28px,8vw,36px)';$('qzHanzi').style.fontFamily='system-ui,PingFang SC,Noto Sans SC,Microsoft YaHei,sans-serif';window._qzRev=t;_applyHanFont();
    $('qzPinyin').textContent='';$('qzResult').innerHTML='';
    $('qzNext').style.visibility='hidden';qzAnswered=false;
    let wrong=_smartDistractors(t,qzData.filter(x=>x.id!==t.id),3,true);
    let choices=[{h:t.h,p:t.p,m:t.m,id:t.id,correct:true},...wrong.map(x=>({h:x.h,p:x.p,m:x.m,id:x.id,correct:false}))];
    choices=_dedupChoices(choices,'h');choices=_padChoices(choices,qzData.filter(x=>x.id!==t.id),4,'h');choices=_dedupChoices(choices,'h');choices=shuffleArray(choices);
    $('qzChoices').innerHTML=choices.map((c,i)=>'<button onclick="answerQuiz('+c.correct+',this)" data-h="'+esc(c.h)+'" data-p="'+esc(c.p)+'" data-m="'+esc(c.m)+'" class="qz-choice" style="font-size:28px">'+'<span class=qz-label>'+String.fromCharCode(65+i)+'.</span> <span class="qz-hanzi">'+esc(c.h)+'</span></button>').join('');_applyHanFont();
    // Ẩn nút Làm lại, layout 1 dòng
    $('qzRetry').style.display='none';
    $('qzButtons').style.flexDirection='row';
  }else{
    if(qzIdx>=qzData.length){qzIdx=0;if(_settings.random)qzData=shuffleArray([...qzData]);}
    let t=qzData[qzIdx];
    $('qzHanzi').textContent=t.h;$('qzHanzi').classList.add('qz-hanzi-text');$('qzHanzi').classList.remove('qz-reverse');$('qzHanzi').style.fontSize='clamp(40px,12vw,56px)';window._qzWord=t;_applyHanFont();
    $('qzPinyin').textContent='';$('qzResult').innerHTML='';
    $('qzNext').style.visibility='hidden';qzAnswered=false;
    let wrong=_smartDistractors(t,qzData.filter(x=>x.id!==t.id),3,false);
    let choices=[{m:t.m,correct:true},...wrong.map(x=>({m:x.m,correct:false}))];
    choices=_dedupChoices(choices,'m');choices=_padChoices(choices,qzData.filter(x=>x.id!==t.id),4,'m');choices=_dedupChoices(choices,'m');choices=shuffleArray(choices);
    $('qzChoices').innerHTML=choices.map((c,i)=>'<button onclick="answerQuiz('+c.correct+',this)" class="qz-choice">'+'<span class=qz-label>'+String.fromCharCode(65+i)+'.</span> '+esc(c.m)+'</button>').join('');
    // Ẩn nút Làm lại, layout 1 dòng
    $('qzRetry').style.display='none';
    $('qzButtons').style.flexDirection='row';
  }
  $('qzScore').textContent='Điểm: '+qzCorrect+'/'+qzTotal;
  // Preload Edge TTS for current word
  if(qzMode==='sent'&&qzSentence)_preloadEdge(qzSentence.t);
  else if(qzMode!=='sent'){let t=qzData[qzIdx];if(t)_preloadEdge(t.h);}
}
function quizText(s){return String(s||'').replace(/\s*[（(][^()（）]*[）)]\s*/g,' ').replace(/\s{2,}/g,' ').replace(/^[A-D]\.\s*/,'').trim();}
function selectToken(idx,btn){
  if(qzMode!=='arrange')return;
  let arr=window._qzArrange;
  if(!arr)return;
  
  // Nếu đã trả lời xong, không cho bấm nữa
  if(qzAnswered)return;
  
  // Nếu nút đã chọn, cho phép bỏ chọn
  if(btn.disabled){
    // Tìm vị trí trong userOrder bằng idx (không dùng token value vì có thể trùng)
    let pos=arr.userOrder.indexOf(idx);
    if(pos!==-1){
      arr.userOrder.splice(pos,1);
      btn.disabled=false;
      btn.style.opacity='1';
      btn.style.transform='scale(1)';
      // Cập nhật hiển thị
      let currentSent=arr.userOrder.map(i=>arr.shuffled[i]).join('');
      if(currentSent){
        $('qzHanzi').innerHTML='<div class="qz-hanzi-text" style="min-height:64px;font-size:clamp(36px,11vw,48px);color:var(--text);font-weight:600;letter-spacing:2px;display:flex;align-items:center;justify-content:center;font-family:system-ui,\'PingFang SC\',\'Noto Sans SC\',sans-serif">'+esc(currentSent)+'</div>';_applyHanFont();
      }else{
        $('qzHanzi').innerHTML='<div style="min-height:64px;font-size:18px;color:var(--text-2);font-weight:600;opacity:0.7;display:flex;align-items:center;justify-content:center">Chọn từ theo thứ tự ↓</div>';
      }
    }
    return;
  }
  
  // Chọn nút mới
  arr.userOrder.push(idx);
  btn.disabled=true;
  btn.style.opacity='0.25';
  btn.style.transform='scale(0.9)';
  // Hiển thị câu đang xếp
  let currentSent=arr.userOrder.map(i=>arr.shuffled[i]).join('');
  $('qzHanzi').innerHTML='<div class="qz-hanzi-text" style="min-height:64px;font-size:clamp(36px,11vw,48px);color:var(--text);font-weight:600;letter-spacing:2px;display:flex;align-items:center;justify-content:center;font-family:system-ui,\'PingFang SC\',\'Noto Sans SC\',sans-serif">'+esc(currentSent)+'</div>';_applyHanFont();
  // Kiểm tra xem đã chọn đủ chưa
  if(arr.userOrder.length===arr.tokens.length){
    qzAnswered=true;
    qzTotal++;
    let correct=(currentSent===arr.answerKey);
    if(correct){
      qzCorrect++;
      $('qzResult').innerHTML='<span style="color:#22c55e;font-weight:700;font-size:18px">✓ Chính xác!</span>';
      $('qzPinyin').innerHTML='<div style="color:var(--accent);font-size:17px;font-weight:600">'+esc(arr.s.p)+'</div>';
    }else{
      $('qzResult').innerHTML='<span style="color:#dc2626;font-weight:700;font-size:18px">✗ Sai rồi!</span><div style="font-size:15px;color:var(--text-2);margin-top:4px">Đáp án: <span class="qz-hanzi-text" style="font-weight:600;color:var(--text)">'+esc(arr.answerKey)+'</span></div>';_applyHanFont();
      $('qzPinyin').innerHTML='<div style="color:var(--accent);font-size:17px;font-weight:600">'+esc(arr.s.p)+'</div>';
    }
    $('qzScore').textContent='Điểm: '+qzCorrect+'/'+qzTotal;
    $('qzNext').style.visibility='visible';
    gsap.from($('qzNext'),{scale:.9,duration:.3,ease:'back.out(1.7)'});
  }
}
function retryArrange(){
  if(qzMode!=='arrange'||!window._qzArrange)return;
  let arr=window._qzArrange;
  // Reset trạng thái
  arr.userOrder=[];
  qzAnswered=false;
  $('qzHanzi').innerHTML='<div style="min-height:64px;font-size:18px;color:var(--text-2);font-weight:600;opacity:0.7;display:flex;align-items:center;justify-content:center">Chọn từ theo thứ tự ↓</div>';
  $('qzPinyin').innerHTML='<div style="color:var(--text);font-size:16px;font-weight:500;margin-top:4px">'+esc(arr.s.m)+'</div>';
  $('qzResult').innerHTML='';
  $('qzNext').style.visibility='hidden';
  // Reset tất cả các nút token
  let buttons=document.querySelectorAll('.qz-token');
  buttons.forEach(btn=>{
    btn.disabled=false;
    btn.style.opacity='1';
    btn.style.transform='scale(1)';
  });
}
function answerQuiz(correct,btn){
  if(qzAnswered){
    // Đã trả lời xong, cho phép bấm vào BẤT KỲ đáp án sai nào
    if(!correct||btn.classList.contains('wrong')){
      if(btn.querySelector('.wrong-detail'))return; // Đã hiện rồi
      let wrongH=btn.getAttribute('data-h');
      let wrongP=btn.getAttribute('data-p');
      let wrongM=btn.getAttribute('data-m');
      if(wrongH&&wrongP&&wrongM){
        let detail='<span class="wrong-detail" style="margin-left:auto;font-size:16px;line-height:1.4;text-align:right">';
        detail+='<span style="color:var(--accent);font-weight:600;display:block">'+esc(wrongP)+'</span>';
        detail+='<span style="color:var(--text-2);font-weight:400;display:block">'+esc(wrongM)+'</span>';
        detail+='</span>';
        btn.innerHTML+=detail;
        speak(wrongH);
      }
    }
    return;
  }
  if(!correct&&_qzAttempts===0){_qzAttempts++;btn.classList.add('wrong');return;}
  qzAnswered=true;qzTotal++;
  let retry=_qzAttempts>0;
  if(qzMode==='cloze'){
    let cz=window._qzCloze;
    if(correct){if(!retry)qzCorrect++;btn.classList.add('correct');$('qzResult').innerHTML='<span style="color:#22c55e;font-weight:700">Đúng!</span> '+esc(cz.blankWord);$('qzHanzi').textContent=cz.s.t;$('qzHanzi').classList.add('qz-hanzi-text');_applyHanFont();}
    else{btn.classList.add('wrong');$('qzResult').innerHTML='<span style="color:#dc2626;font-weight:700">Sai!</span> Đáp án: '+esc(cz.blankWord);
      btn.setAttribute('data-wrong','1');
      document.querySelectorAll('#qzChoices button').forEach(b=>{if(!b.hasAttribute('data-wrong')&&quizText(b.textContent)===quizText(cz.blankWord))b.classList.add('correct');});
      $('qzHanzi').textContent=cz.s.t;$('qzHanzi').classList.add('qz-hanzi-text');_applyHanFont();
    }
    $('qzPinyin').textContent=cz.s.p;
  }else if(qzMode==='sent'){
    let s=qzSentence;
    if(correct){if(!retry)qzCorrect++;btn.classList.add('correct');$('qzResult').innerHTML='<span style="color:#22c55e;font-weight:700">Đúng!</span> '+esc(s.m);}
    else{btn.classList.add('wrong');$('qzResult').innerHTML='<span style="color:#dc2626;font-weight:700">Sai!</span> Đáp án: '+esc(s.m);
      btn.setAttribute('data-wrong','1');
      document.querySelectorAll('#qzChoices button').forEach(b=>{if(!b.hasAttribute('data-wrong')&&quizText(b.textContent)===quizText(s.m))b.classList.add('correct');});
    }
    $('qzPinyin').textContent=s.p;
  }else if(qzMode==='listen'){
    let t=qzData[qzIdx];
    if(correct){if(!retry)qzCorrect++;btn.classList.add('correct');$('qzResult').innerHTML='<span style="color:#22c55e;font-weight:700">Đúng!</span> '+esc(t.m);}
    else{btn.classList.add('wrong');$('qzResult').innerHTML='<span style="color:#dc2626;font-weight:700">Sai!</span> Đáp án: '+esc(t.m);
      btn.setAttribute('data-wrong','1');
      document.querySelectorAll('#qzChoices button').forEach(b=>{if(!b.hasAttribute('data-wrong')&&quizText(b.textContent)===quizText(t.h))b.classList.add('correct');});
    }
    $('qzPinyin').textContent=t.p;$('qzHanzi').textContent=t.h;$('qzHanzi').classList.add('qz-hanzi-text');$('qzHanzi').style.fontSize='clamp(40px,12vw,56px)';$('qzHanzi').style.setProperty('font-family',_settings.dfkai?'DFKaiWeb, serif':'var(--ui-font)','important');_applyHanFont();
  }else if(qzMode==='rev'){
    let t=window._qzRev||qzData[qzIdx];
    if(correct){if(!retry)qzCorrect++;btn.classList.add('correct');$('qzResult').innerHTML='<span style="color:#22c55e;font-weight:700">Đúng!</span> '+esc(t.p);}
    else{btn.classList.add('wrong');$('qzResult').innerHTML='<span style="color:#dc2626;font-weight:700">Sai!</span> Đáp án: '+esc(t.h)+' ('+esc(t.p)+')';
      btn.setAttribute('data-wrong','1');
      document.querySelectorAll('#qzChoices button').forEach(b=>{if(!b.hasAttribute('data-wrong')&&quizText(b.textContent)===quizText(t.h))b.classList.add('correct');});
    }
    $('qzPinyin').textContent=t.p;
  }else{
    let t=qzData[qzIdx];
    if(correct){if(!retry)qzCorrect++;btn.classList.add('correct');$('qzResult').innerHTML='<span style="color:#22c55e;font-weight:700">Đúng!</span> '+esc(t.m);}
    else{btn.classList.add('wrong');$('qzResult').innerHTML='<span style="color:#dc2626;font-weight:700">Sai!</span> Đáp án: '+esc(t.m);
      btn.setAttribute('data-wrong','1');
      document.querySelectorAll('#qzChoices button').forEach(b=>{if(!b.hasAttribute('data-wrong')&&quizText(b.textContent)===quizText(t.m))b.classList.add('correct');});
    }
    $('qzPinyin').textContent=t.p;
  }
  if(qzMode!=='sent'){let t=qzData[qzIdx];if(t)_updateWordStats(t,correct);}
  $('qzScore').textContent='Điểm: '+qzCorrect+'/'+qzTotal;
  $('qzNext').style.visibility='visible';
  gsap.from($('qzNext'),{scale:.9,duration:.3,ease:'back.out(1.7)'});
}
function _updateWordStats(t,correct){
  // Strip variant suffix (_0, _1) for multi-variant words
  let realId=String(t.id).replace(/_\d+$/,'');
  let r=data.find(x=>String(x.id)===realId);if(!r)return;
  // Smart SRS intervals: 0=new, 1=1h, 2=1d, 3=3d, 4=7d, 5=30d
  const SRS_INTERVALS=[0,3600000,86400000,259200000,604800000,2592000000];
  if(correct){
    r.correct=(r.correct||0)+1;
    r.srs_level=Math.min(5,(r.srs_level||0)+1);
    r.srs_next=Date.now()+SRS_INTERVALS[r.srs_level];
  }else{
    r.wrong=(r.wrong||0)+1;
    r.srs_level=Math.max(0,(r.srs_level||0)-1);
    r.srs_next=Date.now()+SRS_INTERVALS[r.srs_level];
  }
  save();
}
function nextQuiz(){
  if(_speakEl)_speakEl.classList.remove('speaking');
  if(qzMode==='sent'||qzMode==='arrange'){
    loadQuiz();
  }else{
    qzIdx++;
    loadQuiz();
  }
}
function closeQuiz(){
  if(qzTotal>0&&qzCorrect===qzTotal){
    // Confetti khi đạt điểm tối đa
    for(let i=0;i<30;i++){
      setTimeout(()=>{
        const c=document.createElement('div');
        c.className='confetti';
        c.style.left=Math.random()*100+'vw';
        c.style.top='-10px';
        c.style.background=['#2563eb','#ea580c','#16a34a','#dc2626','#9333ea','#f59e0b'][Math.floor(Math.random()*6)];
        document.body.appendChild(c);
        setTimeout(()=>c.remove(),2000);
      },i*50);
    }
  }
  $('quizView').style.display='none';
  $('fab').style.display='';
}
function openQR(){$('qrOverlay').classList.add('show')}
function closeQR(){$('qrOverlay').classList.remove('show')}
function _listenWaitEdge(t,retries,forceVoice){
  let v=forceVoice||(_voiceMale?'m':'f'), k=t+v;
  let a=_edgeCache[k];
  if((a&&a.readyState>=2)||retries>=12){speak(t,null,forceVoice||v);return;}
  setTimeout(()=>_listenWaitEdge(t,retries+1,forceVoice),50);
}
// ── Init DOM ──
document.addEventListener('DOMContentLoaded',function(){
const tb=document.getElementById('tb');
// Event delegation for table rows
tb.addEventListener('click',function(e){
  let tr=e.target.closest('tr');
  if(!tr||!tr.hasAttribute('data-rid'))return;
  let rid=tr.getAttribute('data-rid');
  let vidx=tr.getAttribute('data-vidx');
  let hanzi=tr.getAttribute('data-hanzi');
  let r=data.find(x=>String(x.id)===String(rid));
  if(!r)return;
  if(arrangeMode){
    if(!arrangeItems.some(function(x){return x.id===r.id;}))doArrange(r);
  }else if(_findMode){
    _findMode=false;document.body.classList.remove('find-mode');
    var targetId=String(r.id);
    _bookmarkFilter=false;searchTerm='';searchBox.value='';
    $('searchModal').style.display='none';render();_updateSearchActions();
    requestAnimationFrame(function(){
      var targetRow=document.querySelector('tbody tr[data-rid=\"'+targetId+'\"]');
      if(targetRow)targetRow.scrollIntoView({block:'center',behavior:'smooth'});
      else window.scrollTo(0,_preSearchScrollY);
    });
  }else if(selectMode){
    _onRowClick(r,vidx!==null?parseInt(vidx):undefined);
  }else{
    speak(hanzi,tr);
  }
});
const count=document.getElementById('count');
const fab=document.getElementById('fab');
const selectBar=document.getElementById('selectBar');
const selectBadge=document.getElementById('selectBadge');
const bulkText=document.getElementById('bulkText');
const bulkInfo=document.getElementById('bulkInfo');
const dupMode=document.getElementById('dupMode');
window.tb=tb;window.count=count;window.fab=fab;window.selectBar=selectBar;window.selectBadge=selectBadge;window.bulkText=bulkText;window.bulkInfo=bulkInfo;window.dupMode=dupMode;
let _bulkCountTimer=null;
bulkText.addEventListener('input',()=>{
  let lines=bulkText.value.split('\n').filter(x=>x.trim()).filter(x=>!/^\|?\s*-{3,}/.test(x)&&!/chữ hán|pinyin|phiên âm|nghĩa/i.test(x));
  bulkInfo.innerText='Số dòng: '+lines.length;
  clearTimeout(_bulkCountTimer);
  _bulkCountTimer=setTimeout(()=>{
    let parsed=lines.map(parseLine).filter(Boolean);
    let totalWords=0;
    parsed.forEach(r=>{
      let hVars=r.h.split(/\s*\/\s*/).filter(Boolean);
      totalWords+=hVars.length;
    });
    bulkInfo.innerText='Số dòng: '+parsed.length+' • Số từ: '+totalWords;
  },300);
});
render();
// Show spinner nếu đang preload - REMOVED (dùng timeout 30s thay thế)
// setTimeout(_updatePreloadBadge,100);
if('serviceWorker' in navigator){
  // Listen for force reload message from SW
  navigator.serviceWorker.addEventListener('message',function(e){
    if(e.data.type==='FORCE_RELOAD_165'){
      caches.keys().then(function(names){
        names.forEach(function(n){if(n.startsWith('phuc-vql'))caches.delete(n);});
      }).then(function(){
        location.reload();
      });
    }
  });
  
  // Unregister old SW first
  navigator.serviceWorker.getRegistrations().then(regs=>{
    regs.forEach(reg=>{
      if(reg.active&&reg.active.scriptURL.includes('service-worker.js')){
        reg.unregister();
      }
    });
  });
  // Register new SW
  navigator.serviceWorker.register('/sw.js?v=392').then(reg=>{
    reg.update();
    reg.addEventListener('updatefound',()=>{
      const newWorker=reg.installing;
      // Show update overlay
      const ov=document.getElementById('updateOverlay');
      if(ov){ov.style.display='flex';ov.style.opacity='0';requestAnimationFrame(()=>{ov.style.transition='opacity .2s';ov.style.opacity='1';});}
      newWorker.addEventListener('statechange',()=>{
        if(newWorker.state==='activated'){
          if(!navigator.serviceWorker.controller){
            location.reload();
          }else{
            let editing=document.getElementById('editModal').classList.contains('show')||
                         document.getElementById('pasteModal').style.display==='block'||
                         selectMode||arrangeMode;
            if(!editing){
              location.reload();
            }else{
              toast('App có bản cập nhật. Hoàn tất thao tác rồi refresh lại.');
            }
          }
        }
      });
    });
  });
}
// Long-press → refresh with spinner

function _doRefresh(){document.getElementById('refreshSpin').classList.add('on');setTimeout(()=>location.reload(),250)}
// Long-press FAB → refresh
let _fpTimer=null;
fab.addEventListener('mousedown',()=>{_fpTimer=setTimeout(_doRefresh,600)});
fab.addEventListener('mouseup',()=>{clearTimeout(_fpTimer)});
fab.addEventListener('mouseleave',()=>{clearTimeout(_fpTimer)});
fab.addEventListener('touchstart',(e)=>{_fpTimer=setTimeout(_doRefresh,600)});
fab.addEventListener('touchmove',()=>{clearTimeout(_fpTimer)});
fab.addEventListener('touchend',()=>{clearTimeout(_fpTimer)});
fab.addEventListener('touchcancel',()=>{clearTimeout(_fpTimer)});
// ── Scrollbar ──
(function(){
  let sb=document.getElementById('scrollbar'),th=document.getElementById('scrollThumb'),_hideTimer=null,_dragging=false,_startY=0,_startTop=0;
  function update(){
    let docH=document.documentElement.scrollHeight-innerHeight;
    if(docH<=0){th.style.marginTop='0px';return;}
    let pct=scrollY/docH;
    let trackH=sb.clientHeight-th.clientHeight;
    th.style.marginTop=(pct*trackH)+'px';
  }
  function show(){sb.classList.remove('hide');clearTimeout(_hideTimer);_hideTimer=setTimeout(()=>sb.classList.add('hide'),2000);update();}
  let _scrollTimer=null;
  addEventListener('scroll',()=>{
    show();
    clearTimeout(_scrollTimer);
    _scrollTimer=setTimeout(_preloadViewport,300);
  },{passive:true});
  // show on load
  if(document.readyState==='complete')show();else addEventListener('load',show);
  th.addEventListener('pointerdown',e=>{
    e.preventDefault();
    _dragging=true;_startY=e.clientY;_startTop=parseFloat(th.style.marginTop)||0;
    th.setPointerCapture(e.pointerId);sb.classList.remove('hide');clearTimeout(_hideTimer);
  });
  th.addEventListener('pointermove',e=>{
    if(!_dragging)return;
    e.preventDefault();
    let dy=e.clientY-_startY,newTop=_startTop+dy;
    let trackH=sb.clientHeight-th.clientHeight;
    newTop=Math.max(0,Math.min(trackH,newTop));
    th.style.marginTop=newTop+'px';
    let docH=document.documentElement.scrollHeight-innerHeight;
    if(docH>0)scrollTo(0,(newTop/trackH)*docH);
  });
  th.addEventListener('pointerup',()=>{_dragging=false;_hideTimer=setTimeout(()=>sb.classList.add('hide'),2000);});
  th.addEventListener('pointercancel',()=>{_dragging=false;});
})();
// force show scrollbar on load
setTimeout(function(){
  var sb=document.getElementById('scrollbar');
  if(sb&&document.documentElement.scrollHeight>innerHeight)sb.classList.remove('hide');
},300);

// ── Donate popup (đã tắt auto-show) ──
// setTimeout(()=>document.getElementById('donateOverlay').classList.add('show'),400);

// ── Pinyin Enter key ──
var _pyInput=document.getElementById('pyInput');
if(_pyInput)_pyInput.addEventListener('keydown',function(e){if(e.key==='Enter'||e.keyCode===13){e.preventDefault();checkPinyin();}});
}); // End DOMContentLoaded

function closeDonate(){document.getElementById('donateOverlay').classList.remove('show');}

function showMeme(){closeDonate();document.getElementById('memeOverlay').classList.add('show');}
function closeMeme(){document.getElementById('memeOverlay').classList.remove('show');}
let _nameVI=false;
function toggleName(){_nameVI=!_nameVI;document.getElementById('nameTag').textContent=_nameVI?'Vũ Duy Phúc':'武維福';}

// ── Settings ──
let _settings={dark:false,random:true,srs:true,menuRight:true,dfkai:false,scrollbar:true};
try{
  let raw=localStorage.getItem('phuc_settings');
  if(raw){
    let s=JSON.parse(raw);
    _settings={..._settings,...s};
    if(!('scrollbar' in s))_settings.scrollbar=!_isIOS;
  }else{
    _settings.scrollbar=!_isIOS;
  }
}catch(e){}
function saveSettings(){localStorage.setItem('phuc_settings',JSON.stringify(_settings));}
function openSettings(){$('settingsModal').style.display='flex';_applyToggleUI();}
function closeSettings(){$('settingsModal').style.display='none';}
function deleteAllData(){
  if(!confirm('Xóa TẤT CẢ dữ liệu? Không thể hoàn tác!'))return;
  data=[];
  localStorage.removeItem('twv10');
  // Clear IndexedDB
  _openIDB().then(db=>{
    let tx1=db.transaction(['vocab'],'readwrite');
    tx1.objectStore('vocab').clear();
    let tx2=db.transaction(['audio'],'readwrite');
    tx2.objectStore('audio').clear();
  }).catch(e=>console.warn('IDB clear fail:',e));
  render();
  closeSettings();
  toast('Đã xóa toàn bộ dữ liệu + cache');
}
function openGuide(){$('guideModal').style.display='block';document.body.style.overflow='hidden';}
function closeGuide(){$('guideModal').style.display='none';document.body.style.overflow='';}
var gm=$('guideModal');if(gm)gm.onclick=e=>{if(e.target.id==='guideModal')e.stopPropagation();};
function _applyToggleUI(){
  document.body.classList.toggle('dfkai',!!_settings.dfkai);
  let dt=$('darkToggle'),rt=$('randomToggle'),st=$('srsToggle'),mt=$('menuPosToggle'),ft=$('dfkaiToggle'),bt=$('scrollbarToggle');
  if(_settings.dark){dt.style.background='#2563eb';dt.children[0].style.transform='translateX(24px)';}else{dt.style.background='#cbd5e1';dt.children[0].style.transform='translateX(0)';}
  if(_settings.random){rt.style.background='#2563eb';rt.children[0].style.transform='translateX(24px)';}else{rt.style.background='#cbd5e1';rt.children[0].style.transform='translateX(0)';}
  if(_settings.srs){st.style.background='#2563eb';st.children[0].style.transform='translateX(24px)';}else{st.style.background='#cbd5e1';st.children[0].style.transform='translateX(0)';}
  if(_settings.menuRight){mt.style.background='#2563eb';mt.children[0].style.transform='translateX(24px)';}else{mt.style.background='#cbd5e1';mt.children[0].style.transform='translateX(0)';}
  if(_settings.dfkai){ft.style.background='#2563eb';ft.children[0].style.transform='translateX(24px)';}else{ft.style.background='#cbd5e1';ft.children[0].style.transform='translateX(0)';}
  if(_settings.scrollbar){bt.style.background='#2563eb';bt.children[0].style.transform='translateX(24px)';}else{bt.style.background='#cbd5e1';bt.children[0].style.transform='translateX(0)';}
}
function toggleDarkMode(){_settings.dark=!_settings.dark;document.body.classList.toggle('dark',_settings.dark);saveSettings();_applyToggleUI();}
function toggleRandom(){_settings.random=!_settings.random;if(!_settings.random){_settings.srs=false;}else{_settings.srs=true;}saveSettings();_applyToggleUI();}
function toggleSRS(){_settings.srs=!_settings.srs;saveSettings();_applyToggleUI();}
function toggleMenuPos(){_settings.menuRight=!_settings.menuRight;saveSettings();_applyToggleUI();_applyMenuPos();}
function toggleScrollbar(){_settings.scrollbar=!_settings.scrollbar;document.body.classList.toggle('scrollbar-off',!_settings.scrollbar);saveSettings();_applyToggleUI();if(_settings.scrollbar){var sb=document.getElementById('scrollbar');if(sb){sb.classList.remove('hide');var th=document.getElementById('scrollThumb');if(th)th.style.marginTop='0px';setTimeout(function(){var sh=document.documentElement.scrollHeight;if(sh>innerHeight){sb.classList.remove('hide');var pct=scrollY/(sh-innerHeight);th.style.marginTop=(pct*(sb.clientHeight-th.clientHeight))+'px';}},0);}}}
function _applyHanFont(){
 if(_settings.dfkai){
  var family='DFKaiWeb, serif';
  document.querySelectorAll('.hanzi,.fc-token,.qz-token,.qz-hanzi-text,#pyHanzi,.qz-hanzi').forEach(function(el){el.style.setProperty('font-family',family,'important');});
  document.querySelectorAll('.qz-meaning-text').forEach(function(el){el.style.setProperty('font-family','var(--ui-font)','important');});
  // Giảm font-size cho chữ Hán dài để không tràn sang Pinyin
  document.querySelectorAll('.hanzi').forEach(function(el){
   var t=el.textContent.replace(/<[^>]*>/g,'');
   var len=(t.match(/[\u4e00-\u9fff]/g)||[]).length;
   if(len>=6)el.style.setProperty('font-size','26px','important');
   else if(len>=5)el.style.setProperty('font-size','30px','important');
   else if(len>=4)el.style.setProperty('font-size','32px','important');
   else el.style.removeProperty('font-size');
  });
 }else{
  document.querySelectorAll('.hanzi,.fc-token,.qz-token,.qz-hanzi-text,#pyHanzi,.qz-hanzi,.qz-meaning-text').forEach(function(el){el.style.removeProperty('font-family');});
  document.querySelectorAll('.hanzi').forEach(function(el){el.style.removeProperty('font-size');});
 }
}
function toggleDFKai(){_settings.dfkai=!_settings.dfkai;document.body.classList.toggle('dfkai',_settings.dfkai);saveSettings();_applyToggleUI();_applyHanFont();var qz=document.getElementById('qzHanzi');if(qz)qz.offsetHeight;}
function _applyMenuPos(){
  let fab=$('fab');
  if(_settings.menuRight){
    fab.style.right='16px';
    fab.style.left='';
  }else{
    fab.style.left='16px';
    fab.style.right='';
  }
}
if(_settings.dark){document.body.classList.add('dark');}
if(_settings.dfkai){document.body.classList.add('dfkai');}
if(!_settings.scrollbar){document.body.classList.add('scrollbar-off');}
setTimeout(_applyHanFont,0);
_applyToggleUI();
_applyMenuPos();

// ── Data Migration ──
(function(){
  let changed=false;
  data.forEach(r=>{
    if(r.srs_level===undefined){r.srs_level=0;changed=true;}
    if(r.correct===undefined){r.correct=0;changed=true;}
    if(r.wrong===undefined){r.wrong=0;changed=true;}
    if(r.srs_next===undefined){r.srs_next=0;changed=true;}
  });
  if(changed)save();
})();

// ── Export / Import ──
function openExportSheet(){
  closeSettings();
  $('exportSheet').classList.add('show');
  document.body.style.overflow='hidden';
}
function closeExportSheet(){
  $('exportSheet').classList.remove('show');
  document.body.style.overflow='';
}
function openImportModeDialog(){
  $('importModeSheet').classList.add('show');
  document.body.style.overflow='hidden';
}
function closeImportModeDialog(){
  $('importModeSheet').classList.remove('show');
  document.body.style.overflow='';
  if(window._pendingImport){
    window._pendingImport.input.value='';
    delete window._pendingImport;
  }
}
function doImportMode(mode){
  if(!window._pendingImport){closeImportModeDialog();return;}
  let rows=window._pendingImport.rows;
  let input=window._pendingImport.input;
  if(mode==='replace'){data=rows;}else{
    let existing=new Set(data.map(r=>norm(r.h)));
    rows.forEach(r=>{if(!existing.has(norm(r.h))){data.push(r);existing.add(norm(r.h));}});
  }
  save();render();closeSettings();closeImportModeDialog();
  toast('Đã import '+(mode==='replace'?rows.length+' từ':Math.min(rows.length,data.length)+' từ'));
  input.value='';
  delete window._pendingImport;
}
function exportJSON(){
  var ids=_selUniqueIds();
  var d=selectMode&&ids.size?data.filter(function(r){return ids.has(String(r.id));}):data;
  let blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
  let a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='C-Vocab-'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),100);
  toast('Đã export '+(selectMode?d.length+' từ':'toàn bộ'));
}
function exportText(){
  var ids=_selUniqueIds();
  var d=selectMode&&ids.size?data.filter(function(r){return ids.has(String(r.id));}):data;
  var text=d.map(function(x){return [x.h,x.p,x.m].map(function(v){return String(v||'').replace(/\\n/g,' ').trim();}).join('\\t');}).join('\\n');
  let blob=new Blob([text.replace(/\\n+$/,'')],{type:'text/plain;charset=utf-8'});
  let a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='C-Vocab-'+new Date().toISOString().slice(0,10)+'.txt';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),100);
  toast('Đã export '+(selectMode?d.length+' từ':'toàn bộ'));
}
function importFile(input){
  let file=input.files[0];if(!file)return;
  let reader=new FileReader();
  if(file.name.endsWith('.pdf')){
    reader.onload=async function(e){
      try{
        if(e.target.result.byteLength>52428800){toast('⚠ File PDF quá lớn (>50MB). Chọn file nhỏ hơn.');input.value='';return;}
        let script=document.createElement('script');
        script.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        document.head.appendChild(script);
        await new Promise(r=>script.onload=r);
        pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        let arr=new Uint8Array(e.target.result);
        let doc=await pdfjsLib.getDocument({data:arr}).promise;
        let rows=[];
        for(let i=1;i<=doc.numPages;i++){
          let page=await doc.getPage(i);
          let text=await page.getTextContent();
          let items=[];
          for(let t of text.items){
            let s=t.str.trim();if(!s)continue;
            items.push({str:s,x:t.transform[4],y:t.transform[5]});
          }
          if(!items.length)continue;
          items.sort((a,b)=>b.y-a.y||a.x-b.x);
          let rows_raw=[],curRow=[],curY=null;
          for(let it of items){
            if(curY===null||Math.abs(it.y-curY)<5){
              curRow.push(it);if(curY===null)curY=it.y;
            }else{
              if(curRow.length)rows_raw.push(curRow.sort((a,b)=>a.x-b.x).map(t=>t.str).join('\\t'));
              curRow=[it];curY=it.y;
            }
          }
          if(curRow.length)rows_raw.push(curRow.sort((a,b)=>a.x-b.x).map(t=>t.str).join('\\t'));
          rows.push(...rows_raw
            .filter(l=>!/^(chữ hán|pinyin|phiên âm|nghĩa|hanzi|chinese|meaning)\\s*$/i.test(l.trim()))
            .map(parseLine).filter(Boolean));
          page=null;text=null;items=null;
          if(i%5===0){await new Promise(r=>setTimeout(r,50));}
        }
        doc=null;arr=null;
        if(!rows.length){toast('Không đọc được dữ liệu từ PDF');return;}
        let mode=confirm('OK = Thay thế toàn bộ\
Cancel = Thêm vào (bỏ qua trùng)')?'replace':'add';
        if(mode==='replace'){data=rows;}
        else{let existing=new Set(data.map(r=>norm(r.h)));rows.forEach(r=>{if(!existing.has(norm(r.h))){data.push(r);existing.add(norm(r.h));}});}
        save();render();closeSettings();toast('Đã import '+(mode==='replace'?rows.length+' từ':Math.min(rows.length,data.length)+' từ'));
      }catch(err){toast('Lỗi đọc PDF: '+err.message);}
    };
    reader.readAsArrayBuffer(file);
  }else{
    reader.onload=function(e){
    try{
      let raw=e.target.result;
      let rows;
      if(file.name.endsWith('.txt')){
        // File .txt tab-separated: thứ tự cố định Hán\tPinyin\tNghĩa
        rows=raw.split('\\n').map(l=>l.trim()).filter(Boolean).map(l=>{
          let parts=l.split('\\t');
          if(parts.length<3)return null;
          let h=parts[0].trim(),p=parts[1].trim(),m=parts[2].trim();
          if(!h||!p||!m)return null;
          return {id:Date.now()+Math.random(),h:h,p:p,m:m,srs_level:0,correct:0,wrong:0,srs_next:0};
        }).filter(Boolean);
      }else if(file.name.endsWith('.csv')){
        rows=raw.split('\\n').map(l=>l.trim()).filter(Boolean).filter(l=>!/chữ hán|pinyin|nghĩa/i.test(l)).map(parseLine).filter(Boolean);
      }else{
        rows=JSON.parse(raw);
        if(!Array.isArray(rows))throw new Error('Not array');
        rows=rows.map(r=>({id:r.id||Date.now()+Math.random(),h:r.h||'',p:r.p||'',m:r.m||'',srs_level:r.srs_level||0,correct:r.correct||0,wrong:r.wrong||0,srs_next:r.srs_next||0}));
      }
      if(!rows.length){toast('Không đọc được dữ liệu');return;}
      // Store rows temporarily for dialog
      window._pendingImport={rows:rows,input:input};
      openImportModeDialog();
    }catch(err){toast('Lỗi đọc file: '+err.message);}
  };
  reader.readAsText(file);
  input.value='';
  }
}

// ── SRS Quiz Weights ──
function _quizWeight(r){
  if(!_settings.srs)return 1;
  let w=1;
  // Prioritize new words (never reviewed)
  if(r.correct===0&&r.wrong===0)w+=5;
  // Prioritize low-level words
  if(r.srs_level<=1)w+=4;else if(r.srs_level===2)w+=2;else if(r.srs_level===3)w+=1;
  // De-prioritize words not due yet
  if(r.srs_next&&r.srs_next>Date.now())w=Math.max(0.1,w-5);
  // Prioritize weak words
  if(r.wrong>r.correct)w+=3;
  // De-prioritize mastered words
  if(r.correct>r.wrong*3)w=Math.max(0.2,w-4);
  return Math.max(0.1,w);
}
function quizSource(){
  var ids=_selUniqueIds();
  let pool=selectMode&&ids.size?data.filter(function(x){return ids.has(String(x.id));}):[...visibleData()];
  // Expand multi-variant words (哪裡 / 哪兒 → separate entries)
  let expanded=[];
  pool.forEach(r=>{
    let hParts=(r.h||'').split('/');
    let pParts=(r.p||'').split('/');
    if(hParts.length>1){
      hParts.forEach((hVar,j)=>{
        let pVar=(pParts[j]||pParts[0]||'').trim();
        expanded.push({id:r.id+'_'+j, h:hVar.trim(), p:pVar, m:r.m, srs_level:r.srs_level, srs_next:r.srs_next, correct:r.correct, wrong:r.wrong});
      });
    }else{
      expanded.push(r);
    }
  });
  pool=expanded;
  if(pool.length<5)return pool;
  let source=[...pool];
  if(_settings.srs){
    source.sort((a,b)=>_quizWeight(b)-_quizWeight(a)||Math.random()-.5);
    const priority=Math.min(source.length,30);
    source=shuffleArray(source.slice(0,priority)).concat(shuffleArray(source.slice(priority)));
  }else{
    source=shuffleArray(source);
  }
  return source;
}

// ── Edge TTS LRU Cache ──
let _edgeLRU=[],_edgeMaxCache=40;
function _trackCacheSize(){
  let keys=Object.keys(_edgeCache).filter(k=>k!=='_loading');
  if(keys.length>_edgeMaxCache){
    keys.sort((a,b)=>{
      let ta=(_edgeCache[a]._lastUsed||0),tb=(_edgeCache[b]._lastUsed||0);
      return ta-tb;
    });
    let removed=keys.slice(0,keys.length-_edgeMaxCache);
    removed.forEach(k=>{
      let a=_edgeCache[k];
      if(a&&a._blobURL){URL.revokeObjectURL(a._blobURL);_blobURLs.delete(a._blobURL);}
      delete _edgeCache[k];
    });
  }
}
(function(){
  let origPreload=_preloadEdge;
  _preloadEdge=function(t,rate,trackProgress){
    if(!t)return;
    t=t.split('/')[0].trim();
    let idx=_edgeLRU.indexOf(t);
    if(idx>=0)_edgeLRU.splice(idx,1);
    _edgeLRU.push(t);
    while(_edgeLRU.length>_edgeMaxCache){let old=_edgeLRU.shift();['f','m'].forEach(v=>{delete _edgeCache[old+v];});}
    origPreload(t,rate,trackProgress);
  };
})();
// ── IDB Audio Cache Cleanup (LRU, max 200 files) ──
function _cleanupAudioIDB(){
  _openIDB().then(db=>{
    let tx=db.transaction(['audio'],'readonly');
    let req=tx.objectStore('audio').getAllKeys();
    req.onsuccess=()=>{
      let keys=req.result||[];
      if(keys.length>200){
        // Remove oldest 50
        let toRemove=keys.slice(0,50);
        let txw=db.transaction(['audio'],'readwrite');
        let store=txw.objectStore('audio');
        toRemove.forEach(k=>store.delete(k));
      }
    };
  }).catch(e=>console.warn('IDB cleanup fail:',e));
}
// Run cleanup every 10 minutes
let _audioCleanupInterval=setInterval(_cleanupAudioIDB,600000);
addEventListener('beforeunload',()=>clearInterval(_audioCleanupInterval));

// ── Writing Practice ──
let _wChars=[],_wIdx=0,_writer=null;
function startWriting(){
  var ids=_selUniqueIds();
  let pool=selectMode&&ids.size?data.filter(function(x){return ids.has(String(x.id));}):[...visibleData()];
  // Nhóm chữ Hán theo từ, giữ thứ tự [1/n, 2/n...] trong cùng từ
  let groups=[];
  pool.forEach(r=>{
    let chars=r.h.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    if(!chars||!chars.length)return;
    let group=chars.map((c,i)=>({c:c,word:r.h,p:r.p,m:r.m,pos:i+1,total:chars.length}));
    groups.push(group);
  });
  if(_settings.random)shuffleArray(groups);
  _wChars=groups.flat();
  if(!_wChars.length){toast('Không có chữ Hán để tập viết!');return;}
  _wIdx=0;$('writeView').style.display='flex';$('fab').style.display='none';_loadWriteChar();
}
function _loadWriteChar(mode){
  if(_writer){try{_writer.cancelQuiz();}catch(e){}try{_writer.cancelAnimation();}catch(e){}$('writeTarget').innerHTML='';_writer=null;}
  let r=_wChars[_wIdx];$('writeIdx').textContent=(_wIdx+1)+' / '+_wChars.length;
  let label=r.word+(r.total>1?' ['+r.pos+'/'+r.total+']':'');
  $('writeInfo').textContent=r.p+' — '+r.m;
  $('writeHint').textContent=mode==='animate'?'Xem mẫu: '+label:label;
  $('writeHint').style.color='var(--text-2)';
  _writer=HanziWriter.create('writeTarget',r.c,{width:340,height:340,padding:5,
    strokeColor:'#2563eb',radicalColor:'#93c5fd',outlineColor:'#cbd5e1',
    onLoadCharDataError:function(char){
      $('writeHint').textContent='⚠ Chưa hỗ trợ chữ này';$('writeHint').style.color='var(--danger)';
      $('writeTarget').innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-2)"><span style="font-size:64px;opacity:.15">'+char+'</span></div>';
    }
  });
  if(mode==='animate'){_writer.loopCharacterAnimation();return;}
  _writer.quiz({
    onMistake:function(s){$('writeHint').textContent='⚠ Sai nét!';$('writeHint').style.color='var(--danger)';},
    onCorrectStroke:function(s){$('writeHint').textContent='Vẽ theo nét mờ';$('writeHint').style.color='var(--text-2)';},
    onComplete:function(sum){
      if(sum.totalMistakes===0)$('writeHint').innerHTML='<span style="color:#22c55e">Hoàn hảo!</span>';
      else $('writeHint').innerHTML='<span style="color:#f59e0b">Xong! '+sum.totalMistakes+' lỗi</span>';
    }
  });
}
function writeAnimate(){_loadWriteChar('animate');}
function writeClear(){_loadWriteChar();}
function writeNext(){_wIdx=(_wIdx+1)%_wChars.length;_loadWriteChar();}
function writePrev(){_wIdx=(_wIdx-1+_wChars.length)%_wChars.length;_loadWriteChar();}
function closeWriting(){$('writeView').style.display='none';$('fab').style.display='';if(_writer){try{_writer.cancelQuiz();}catch(e){}try{_writer.cancelAnimation();}catch(e){}$('writeTarget').innerHTML='';_writer=null;}}

// ── Pinyin Typing ──
let _pyData=[],_pyIdx=0,_pyCorrect=0,_pyTotal=0,_pyAnswered=false;
function stripTones(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,'').trim();}
function startPinyinQuiz(){
  _pyData=quizSource();if(_pyData.length<2){alert('Cần ít nhất 2 từ!');return;}
  if(_settings.random)_pyData=shuffleArray([..._pyData]);
  _pyIdx=0;_pyCorrect=0;_pyTotal=0;
  $('pinyinView').style.display='flex';$('fab').style.display='none';
  loadPinyinWord();
}
function loadPinyinWord(){
  _pyAnswered=false;
  let r=_pyData[_pyIdx];
  $('pyIdx').textContent=(_pyIdx+1)+' / '+_pyData.length;
  $('pyHanzi').textContent=r.h.split('/')[0].trim();$('pyHanzi').classList.add('qz-hanzi-text');if(typeof _applyHanFont==='function')_applyHanFont();
  $('pyMeaning').textContent=r.m;
  $('pyResult').textContent='';
  $('pyScore').textContent='Điểm: '+_pyCorrect+'/'+_pyTotal;
  $('pyInput').value='';$('pyInput').disabled=false;$('pyInput').focus();
  $('pyCheck').disabled=false;$('pyCheck').style.opacity='1';
}
function checkPinyin(){
  if(_pyAnswered)return;
  let r=_pyData[_pyIdx];
  let target=r.p.split('/')[0].trim();
  let userInput=$('pyInput').value.trim();
  if(!userInput){$('pyInput').focus();return;}
  _pyAnswered=true;_pyTotal++;
  let correct=stripTones(userInput)===stripTones(target);
  if(correct){_pyCorrect++;_updateWordStats(r,true);
    $('pyResult').innerHTML='<span style="color:#22c55e">Đúng!</span><br><span style="font-size:15px;color:var(--text-2)">'+target+'</span>';
  }else{
    _updateWordStats(r,false);
    $('pyResult').innerHTML='<span style="color:var(--danger)">Sai!</span><br><span style="font-size:15px;color:var(--text-2)">'+target+'</span>';
  }
  $('pyScore').textContent='Điểm: '+_pyCorrect+'/'+_pyTotal;
  $('pyInput').disabled=true;
  $('pyCheck').disabled=true;$('pyCheck').style.opacity='0.4';
}
function nextPinyin(){_pyIdx=(_pyIdx+1)%_pyData.length;loadPinyinWord();}
function prevPinyin(){_pyIdx=(_pyIdx-1+_pyData.length)%_pyData.length;loadPinyinWord();}
function speakPinyinWord(){let r=_pyData[_pyIdx];speak(r.h.split('/')[0].trim());}
function closePinyin(){$('pinyinView').style.display='none';$('fab').style.display='';}


// ── Keyboard Shortcuts ──
document.addEventListener('keydown',function(e){
  if(e.target&&(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.isContentEditable))return;
  var flashEl=document.getElementById('flash');
  if(flashEl&&flashEl.style.display==='block'){
    if(e.key==='Enter'||e.key==='ArrowDown'){
      e.preventDefault();
      var spkBtn=flashEl.querySelector('button[onclick*="playFlash"]');
      playFlash(spkBtn);
    }else if(e.key===' '||e.code==='Space'||e.key==='ArrowUp'){
      e.preventDefault();
      flip();
    }else if(e.key==='ArrowLeft'||e.key==='<'||e.key===','){
      e.preventDefault();
      prev();
    }else if(e.key==='ArrowRight'||e.key==='>'||e.key==='.'){
      e.preventDefault();
      next();
    }else if(e.key==='Escape'){
      e.preventDefault();
      closeFlash();
    }
  }
});
function undoDelete(){
  if(_deleteStack.length===0){toast('Không có gì để khôi phục');return;}
  var restored=_deleteStack.pop();
  data.push(...restored);
  save();render();
  toast('Đã khôi phục '+restored.length+' mục');
}
function bulkEdit(){
  if(!selected.size){toast('Chưa chọn mục nào');return;}
  var ids=_selUniqueIds();
  if(ids.size<2){toast('Chọn ít nhất 2 mục để sửa hàng loạt');return;}
  var commonM='';var rows=[];
  ids.forEach(function(id){var r=data.find(function(x){return String(x.id)===id;});if(r)rows.push(r);});
  if(rows.length>0)commonM=rows[0].m;
  var newM=prompt('Nghĩa mới cho '+rows.length+' mục:',commonM);
  if(newM===null)return;
  rows.forEach(function(r){r.m=newM;});
  save();render();
  toast('Đã sửa '+rows.length+' mục');
}
