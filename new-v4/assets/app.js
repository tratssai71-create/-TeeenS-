/* ════════════════════════════════════════════════════════════
   背景キャンバス（TeeenSオリジナル：軌道）
   細い楕円の軌道が、ゆっくり傾きながら回る。軌道の上を小さな点（青）が周回する。
   スクロールすると軌道が回転・拡大し、コンテンツが画面中央を越えると薄くなる。
   ════════════════════════════════════════════════════════════ */
(function(){
  var canvas=document.getElementById('bg'); if(!canvas) return;
  var ctx=canvas.getContext('2d',{alpha:false});
  var TAU=Math.PI*2;
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var BLUE='47,107,255', INK='70,74,88';

  /* 軌道：ax=横の大きさ ratio=縦横比 rot=初期の傾き spin=自転の速さ k=スクロール連動の強さ sp=点の周回の速さ */
  var ORBITS=[
    {ax:1.00,ratio:.30,rot:.35, spin: .020,k: .00045,sp: .16,ph:0.0,blue:false,w:1.6,al:.55,n:2},
    {ax:0.86,ratio:.46,rot:-.55,spin:-.015,k:-.00060,sp:-.12,ph:2.1,blue:false,w:1.6,al:.55,n:1},
    {ax:0.70,ratio:.62,rot:1.25,spin: .026,k: .00080,sp: .22,ph:4.0,blue:true, w:2.4,al:.8, n:2},
    {ax:1.12,ratio:.20,rot:-1.0,spin:-.010,k: .00030,sp: .10,ph:1.0,blue:false,w:1.2,al:.5, n:1},
    {ax:0.56,ratio:.78,rot:.20, spin:-.030,k:-.00090,sp: .26,ph:3.0,blue:false,w:1.4,al:.5, n:1},
    {ax:1.26,ratio:.38,rot:2.10,spin: .008,k: .00025,sp:-.08,ph:5.2,blue:false,w:1.1,al:.4, n:2},
    {ax:0.94,ratio:.14,rot:-1.8,spin: .012,k:-.00040,sp: .14,ph:0.7,blue:false,w:1.2,al:.45,n:1},
    {ax:0.42,ratio:.88,rot:.90, spin: .034,k: .00100,sp:-.30,ph:2.6,blue:false, w:1.8,al:.6, n:1},
    {ax:1.40,ratio:.52,rot:-.25,spin:-.006,k: .00020,sp: .07,ph:4.4,blue:false,w:1.0,al:.32,n:1},
    {ax:0.78,ratio:.26,rot:2.7, spin:-.022,k: .00070,sp: .18,ph:1.8,blue:false,w:1.3,al:.48,n:1}
  ];

  var NP=84, FORM=3.2, HOLD=7.0, DISP=2.4, CYC=FORM+HOLD+DISP, GATH=2.4;   // 揃って静かな時間(HOLD)を長く、散る時間(DISP)を短く
  function clamp01(t){return t<0?0:t>1?1:t}
  function easeIO(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2}
  function gEase(t){return 1-Math.pow(1-clamp01(t),3.2)}
  for(var oi=0;oi<ORBITS.length;oi++){var oo=ORBITS[oi];oo.off=oi*.16;oo.cyc=-1;oo.sc=null;oo.X=new Float32Array(NP);oo.Y=new Float32Array(NP);}

  var W,H,dpr,cx,cy,R,isPC=true;
  function makeScatter(o){
    o.sc=[];
    for(var k=0;k<NP;k++){
      var ang=Math.random()*TAU, rr=R*(.45+Math.random()*1.15);
      o.sc.push({x:cx+Math.cos(ang)*rr*1.15,y:cy+Math.sin(ang)*rr*.85,d:Math.random()*.25});
    }
  }
  function build(){
    var r=canvas.getBoundingClientRect();
    W=r.width;H=r.height;
    dpr=Math.min(window.devicePixelRatio||1,1.5);
    canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    isPC=W>=1024;
    cx=W*.5;cy=H*.5;
    R=isPC?Math.min(640,W*.44):W*.62;
    for(var q=0;q<ORBITS.length;q++)ORBITS[q].sc=null;
  }

  var contents=document.getElementById('contents');
  var copy=document.getElementById('copy');
  var ind=document.getElementById('scrollInd');
  var contentsTop=0,copyTop=0,copyHidden=null;
  function measure(){
    if(contents)contentsTop=contents.getBoundingClientRect().top+window.scrollY;
    if(copy){copyTop=copy.getBoundingClientRect().top}
  }
  var SUB=document.body.hasAttribute('data-sub');
  var openTarget=SUB?1:0, openRaw=openTarget;
  function applyScroll(){
    if(SUB||!contents)return;
    var top=contentsTop-window.scrollY;
    openTarget=(top<H*.55)?1:0;
    var hide=top<=copyTop;
    if(hide!==copyHidden){
      copy.classList.toggle('is-hidden',hide);
      ind.classList.toggle('is-hidden',hide);
      copyHidden=hide;
    }
  }
  function ease(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2}

  var t0=performance.now(),last=t0,lastOp='',running=false;
  function frame(now){
    applyScroll();
    var t=reduce?0:(now-t0)/1000;
    var dt=Math.min(.05,(now-last)/1000);last=now;
    if(openRaw<openTarget)openRaw=Math.min(openTarget,openRaw+dt/2.2);
    else if(openRaw>openTarget)openRaw=Math.max(openTarget,openRaw-dt/2.2);
    var oe=ease(openRaw);
    var sy=window.scrollY||0;
    var op=1-(isPC?.74:.82)*oe;
    var ops=op.toFixed(3);
    if(ops!==lastOp){canvas.style.opacity=ops;lastOp=ops;}

    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    var scale=1+.38*oe;
    var breath=reduce?1:1+.025*Math.sin(t*.5);

    for(var i=0;i<ORBITS.length;i++){
      var o=ORBITS[i];
      var rx=R*o.ax*scale*breath, ry=rx*o.ratio;
      var th=o.rot+t*o.spin+sy*o.k;
      var cs=Math.cos(th),sn=Math.sin(th);

      /* 軌道ごとに時間をずらして、「集まる → 保つ → 散る」を繰り返す */
      var tt=reduce?(FORM+HOLD*.4):(t+o.off);
      var cyc=Math.floor(tt/CYC), lt=tt-cyc*CYC;
      var inForm=lt<FORM, inDisp=lt>=FORM+HOLD, inHold=!inForm&&!inDisp;
      var dp=inDisp?clamp01((lt-FORM-HOLD)/DISP):0;
      if(!o.sc||(inDisp&&o.cyc!==cyc)){makeScatter(o);o.cyc=cyc;}
      var A_disp=1-easeIO(dp);
      var lineDp=clamp01(dp*2.2);
      var conn=inForm?easeIO(clamp01((lt-.4-i*.04)/1.6)):inHold?1:(1-easeIO(lineDp));
      var lineFade=inForm?(.3+.7*clamp01((lt-1.7)/1.0)):inHold?1:(1-easeIO(lineDp));
      var dotsA=inForm?(1-clamp01((lt-1.4)/.6))*.8:clamp01((1-conn)/.6)*.8;
      var pf=inForm?clamp01((lt-(FORM-.6))/.6):inHold?1:1-clamp01(dp*3);

      var X=o.X,Y=o.Y;
      for(var k=0;k<NP;k++){
        var ang=k/NP*TAU, ex=rx*Math.cos(ang), ey=ry*Math.sin(ang);
        var tx=cx+ex*cs-ey*sn, ty=cy+ex*sn+ey*cs;
        var A=inForm?gEase((lt-o.sc[k].d)/GATH):inHold?1:A_disp;
        X[k]=o.sc[k].x+(tx-o.sc[k].x)*A;
        Y[k]=o.sc[k].y+(ty-o.sc[k].y)*A;
      }

      if(dotsA>.01){
        ctx.fillStyle=(o.blue?'rgba('+BLUE+',':'rgba('+INK+',')+dotsA.toFixed(3)+')';
        ctx.beginPath();
        for(var d=0;d<NP;d++){ctx.moveTo(X[d]+2,Y[d]);ctx.arc(X[d],Y[d],2,0,TAU);}
        ctx.fill();
      }
      var la=o.al*lineFade;
      if(la>.01){
        ctx.lineWidth=o.w;
        ctx.strokeStyle=(o.blue?'rgba('+BLUE+',':'rgba('+INK+',')+la.toFixed(3)+')';
        var limit=conn*NP, start=(i*17)%NP;
        ctx.beginPath();
        for(var sg=0;sg<NP;sg++){
          if(((sg-start+NP)%NP)>=limit)continue;
          var nx=(sg+1)%NP;
          ctx.moveTo(X[sg],Y[sg]);ctx.lineTo(X[nx],Y[nx]);
        }
        ctx.stroke();
      }

      /* 軌道上を回る点と、その後ろに伸びる光の尾（軌道が整っている間だけ） */
      if(pf>.02){
        function pt(ang){var ex=rx*Math.cos(ang),ey=ry*Math.sin(ang);return [cx+ex*cs-ey*sn,cy+ex*sn+ey*cs];}
        for(var pk=0;pk<o.n;pk++){
          var a0=o.ph+pk*TAU/o.n+t*o.sp*TAU*.35+sy*o.k*3;
          var dir=o.sp>=0?1:-1, steps=16;
          for(var st=0;st<steps;st++){
            var p1=pt(a0-dir*(st/steps)*1.1),p2=pt(a0-dir*((st+1)/steps)*1.1);
            ctx.strokeStyle=(o.blue?'rgba('+BLUE+',':'rgba('+INK+',')+((1-st/steps)*(o.blue?.95:.8)*pf).toFixed(3)+')';
            ctx.lineWidth=o.w+2.2*(1-st/steps);
            ctx.beginPath();ctx.moveTo(p1[0],p1[1]);ctx.lineTo(p2[0],p2[1]);ctx.stroke();
          }
          var pp=pt(a0);
          ctx.fillStyle=(o.blue?'rgba('+BLUE+',':'rgba('+INK+',')+pf.toFixed(3)+')';
          ctx.beginPath();ctx.arc(pp[0],pp[1],o.blue?5.5:4,0,TAU);ctx.fill();
        }
      }
    }

    if(reduce&&openRaw===openTarget){running=false;return;}
    requestAnimationFrame(frame);
  }
  function start(){if(!running){running=true;requestAnimationFrame(frame);}}

  build();measure();start();
  window.addEventListener('load',function(){measure();});
  window.addEventListener('resize',function(){
    var r=canvas.getBoundingClientRect();
    if(r.width===W&&r.height===H)return;
    build();measure();start();
  });
  if(reduce)window.addEventListener('scroll',function(){start();},{passive:true});
  document.addEventListener('visibilitychange',function(){if(!document.hidden){last=performance.now();start();}});
})();

/* スクロールで現れる動き（フェードアップ・灰色面のワイプ・見出し下線） */
(function(){
  var targets=document.querySelectorAll('.rv,[data-wipe]');
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(e.isIntersecting){
        e.target.classList.add('in');
        e.target.querySelectorAll('.sec-title').forEach(function(t){t.classList.add('in');});
        io.unobserve(e.target);
      }
    });
  },{threshold:.08,rootMargin:'0px 0px -40px 0px'});
  targets.forEach(function(el){io.observe(el);});
  document.querySelectorAll('.sec-title.rv').forEach(function(t){
    new IntersectionObserver(function(es,o){es.forEach(function(e){if(e.isIntersecting){t.classList.add('in');o.disconnect();}});},{threshold:.5}).observe(t);
  });
})();

/* FAQ */
document.querySelectorAll('.faq-item').forEach(function(it){
  it.querySelector('.faq-q').addEventListener('click',function(){
    var o=it.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(function(i){i.classList.remove('open');});
    if(!o)it.classList.add('open');
  });
});

/* モバイルメニュー */
(function(){
  var b=document.getElementById('burger'),m=document.getElementById('mob');
  function close(){m.classList.remove('open');b.classList.remove('open');document.body.style.overflow='';}
  b.addEventListener('click',function(){var o=m.classList.toggle('open');b.classList.toggle('open',o);document.body.style.overflow=o?'hidden':'';});
  m.querySelectorAll('a').forEach(function(a){a.addEventListener('click',close);});
})();


/* ── キャッチコピーの描画アニメを有効化 ── */
document.documentElement.classList.add('js-draw');

/* ── 制作実績のフィルター ── */
(function(){
  var bar=document.querySelector('.filters'); if(!bar)return;
  var items=document.querySelectorAll('.work[data-cat]'), cnt=document.getElementById('wcount');
  bar.addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b)return;
    bar.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});
    var c=b.getAttribute('data-f'), n=0;
    items.forEach(function(it){
      var show=(c==='all')||it.getAttribute('data-cat')===c;
      it.classList.toggle('hide',!show);
      if(show&&!it.hasAttribute('data-soon'))n++;
    });
    if(cnt)cnt.textContent='全 '+n+' 件';
  });
})();

/* ── お問い合わせフォーム（Web3Forms） ── */
(function(){
  var form=document.getElementById('ct-form'); if(!form)return;
  var btn=document.getElementById('ct-submit');
  form.addEventListener('submit',function(e){
    e.preventDefault();
    btn.disabled=true; btn.textContent='送信中...';
    fetch(form.getAttribute('action'),{method:'POST',body:new FormData(form),headers:{Accept:'application/json'}})
      .then(function(r){
        if(r.ok){ window.location.href=form.getAttribute('data-thanks'); }
        else throw new Error('ng');
      })
      .catch(function(){
        btn.disabled=false; btn.textContent='送信する';
        alert('送信に失敗しました。お手数ですが、時間をおいて再度お試しください。');
      });
  });
})();


/* ── お知らせのタブ切り替え ── */
(function(){
  var bar=document.querySelector('.ntabs'); if(!bar)return;
  var items=document.querySelectorAll('.nitem'), empty=document.querySelector('.nempty');
  bar.addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b)return;
    bar.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});
    var c=b.getAttribute('data-n'), n=0;
    items.forEach(function(it){
      var show=(c==='all')||it.getAttribute('data-cat')===c;
      it.classList.toggle('hide',!show);
      if(show)n++;
    });
    if(empty)empty.hidden=n>0;
  });
})();


/* ═══════ 出現時のモーション（各所）═══════ */
(function(){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var root=document.documentElement; root.classList.add('mo');

  /* 1. 見出しの英字：1文字ずつ下からせり上がる */
  document.querySelectorAll('.sec-title .en-t,.page-hero .eyebrow,.cta-band .en-t,.cband-title').forEach(function(el){
    var t=el.textContent; el.setAttribute('aria-label',t); el.textContent='';
    var i=0; Array.prototype.forEach.call(t,function(c){
      var s=document.createElement('span'); s.className='ch'; s.setAttribute('aria-hidden','true');
      s.style.setProperty('--i',i++); s.textContent=(c===' ')?'\u00a0':c; el.appendChild(s);
    });
  });

  /* 2. カード・行は、順番にずれて現れる（横並びの中の位置で遅れを付ける） */
  var groups=[['.sgrid','.scell'],['.wgrid','.wcell'],['.grid3','.cell'],['.plans','.plan'],['.flow','.step'],['.nlist','.nitem'],['.cinfo','.crow'],['.faq','.faq-item'],['.vs','div'],['.swlist','.sw'],['.sstrip','.ss']];
  var all=[];
  groups.forEach(function(g){
    document.querySelectorAll(g[0]).forEach(function(box){
      var kids=g[0]==='.vs'?[].slice.call(box.children):[].slice.call(box.querySelectorAll(':scope > '+g[1]));
      kids.forEach(function(k,idx){ k.classList.add('rvi'); k.style.setProperty('--i',idx); all.push(k); });
    });
  });

  /* 3. アイコンの線を、描くように見せる */
  document.querySelectorAll('.wicon,.sicon').forEach(function(svg){
    svg.classList.add('draw');
    svg.querySelectorAll('path,circle,rect,line').forEach(function(p){
      var L=60; try{L=Math.ceil(p.getTotalLength())+2;}catch(e){}
      p.style.setProperty('--len',L);
    });
  });

  /* 4. 数字は 0 から数え上がる */
  function countUp(el){
    var m=el.textContent.match(/^(\d+)(.*)$/); if(!m||+m[1]===0)return;
    var to=+m[1], rest=m[2], t0=null;
    function step(ts){ if(!t0)t0=ts; var p=Math.min(1,(ts-t0)/1100); var e=1-Math.pow(1-p,3);
      el.textContent=Math.round(to*e)+rest; if(p<1)requestAnimationFrame(step); }
    el.textContent='0'+rest; requestAnimationFrame(step);
  }

  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(!e.isIntersecting)return;
      var el=e.target; el.classList.add('in'); io.unobserve(el);
      setTimeout(function(){el.classList.add('done');},1400);
      el.querySelectorAll('.wmeta b,.sn b').forEach(countUp);
    });
  },{threshold:.12,rootMargin:'0px 0px -30px 0px'});
  all.forEach(function(k){io.observe(k);});
})();


/* ── 問い合わせ帯：マウスが入った・出た位置から、白い円が広がる／縮む ── */
(function(){
  document.querySelectorAll('.cband').forEach(function(b){
    function pos(e){
      var r=b.getBoundingClientRect();
      b.style.setProperty('--x',(e.clientX-r.left)+'px');
      b.style.setProperty('--y',(e.clientY-r.top)+'px');
    }
    b.addEventListener('pointerenter',pos);
    b.addEventListener('pointerleave',pos);
  });
})();

/* ホームページ作成ページ：スクロールに合わせて、パソコン内のサイトを動かす */
(function(){
  var sec=document.getElementById('sdev');if(!sec)return;
  if(window.matchMedia('(max-width:900px)').matches||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var view=sec.querySelector('.sdev-view'),fr=sec.querySelector('.sdev-frame');if(!view||!fr)return;
  var cur=0,tgt=0,ready=false;
  function fit(){var s=view.clientWidth/1440;fr.style.transform='scale('+s+')';fr.style.height=(view.clientHeight/s)+'px'}
  function maxScroll(){try{var d=fr.contentDocument;return Math.max(0,d.documentElement.scrollHeight-fr.clientHeight)}catch(e){return 0}}
  function calc(){var r=sec.getBoundingClientRect(),total=sec.offsetHeight-window.innerHeight;var p=total>0?Math.min(1,Math.max(0,-r.top/total)):0;tgt=p}
  window.addEventListener('scroll',calc,{passive:true});window.addEventListener('resize',function(){fit();calc()});
  function isReady(){try{var d=fr.contentDocument;return !!d&&d.readyState==='complete'&&d.documentElement.scrollHeight>fr.clientHeight}catch(e){return false}}
  fr.addEventListener('load',fit);
  fit();calc();
  function tick(){
    if(isReady()){cur+=(tgt-cur)*0.12;try{fr.contentWindow.scrollTo({top:cur*maxScroll(),left:0,behavior:'instant'})}catch(e){}}
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick);
})();
