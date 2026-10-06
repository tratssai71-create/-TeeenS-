
/* ════════════════════════════════════════════════════════════
   背景キャンバス
   点が散らばる → 円に集まる → 線でつながる → 1本だけ赤く染まる
   → しばらく保つ → また散る、を繰り返す。
   コンテンツが画面中央を越えたら、円がゆっくり大きく・薄くなる。
   ════════════════════════════════════════════════════════════ */
(function(){
  var canvas=document.getElementById('bg'); if(!canvas) return;
  var ctx=canvas.getContext('2d',{alpha:false});
  var TAU=Math.PI*2;
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 調整値 */
  var N=72;                  // 1つの円を作る点の数
  // 集まって円になる → 円のまま保つ → 「T」に変形 → 「T」で保つ → 散る（秒）
  var FORM=4.6, HOLD_R=5.4, MORPH=1, HOLD_T=0, DISPERSE=2.8;   // 「T」への変形はオフ（円だけ）
  var T1=FORM+HOLD_R, T2=T1+MORPH, HOLD_END=T2+HOLD_T;
  var CYCLE=HOLD_END+DISPERSE;
  var GATHER=2.9;            // 点が円に収まるまで
  var LINE_W=2.6, LINE_A=0.8, SHADE=70;
  var RED=[47,107,255];
  var DOT_R=2.1, DOT_RGB='108,108,114';
  var BREATH=0.06, BREATH_SPEED=0.26;
  var OPEN_MAX=1.45, OPEN_OPACITY=0.5, OPEN_DUR=2.2, OPEN_TRIGGER=0.55;

  /* 4つの円：ゆっくり揺れる位相をずらしてある（赤は最前面＝最後に描く） */
  var RINGS=[
    {red:false,rf:1.00,ax:.040,ay:.050,sx:.30,sy:.22,px:1.7,py:2.3,pb:1.6},
    {red:false,rf:.80, ax:.055,ay:.034,sx:.22,sy:.32,px:3.1,py:.4, pb:3.2},
    {red:true, rf:.60, ax:.045,ay:.040,sx:.26,sy:.30,px:0,  py:.7, pb:0}
  ];

  var W,H,dpr,cx,cy,R,openMax=OPEN_MAX,isPC=true;
  var cosT=new Float32Array(N),sinT=new Float32Array(N);
  for(var i=0;i<N;i++){var th=i/N*TAU;cosT[i]=Math.cos(th);sinT[i]=Math.sin(th);}
  var X=new Float32Array(N),Y=new Float32Array(N);
  var scat=[], TP=[], tGap=-1;   // TP[リング番号] = 「T」の輪郭上の点 [{x,y}...]

  /* 内側の円だけが、1本線の「T」に変わる（左→右へ横棒、戻って中央から下へ縦棒） */
  function makeT(){
    var s=isPC?Math.min(H*.5,W*.38):Math.min(W*.5,H*.34);
    var top=-s/2, bw=s*.82, bot=s/2;
    var n1=Math.round(N*.36), n2=Math.round(N*.17), n3=N-n1-n2, pts=[], j;
    for(j=0;j<n1;j++){pts.push([-bw/2+bw*(j/(n1-1)),top]);}
    for(j=1;j<=n2;j++){pts.push([bw/2-(bw/2)*(j/n2),top]);}
    for(j=1;j<=n3;j++){pts.push([0,top+(bot-top)*(j/n3)]);}
    var off=Math.round(N*225/360);   // 円の左上あたりが、横棒の左端になるように回す
    tGap=(off-1+N)%N;               // 「T」の途切れ目（縦棒の下端と横棒の左端の間）
    var arr=[];
    for(var i=0;i<N;i++){var p=pts[(i-off+N*2)%N];arr.push({x:p[0],y:p[1]});}
    TP=[null,null,arr];
  }

  function clamp01(t){return t<0?0:t>1?1:t}
  function easeInOut(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2}
  function easeInOut3(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2}
  function gatherEase(t){return 1-Math.pow(1-clamp01(t),3.4)}   // 出だしが速く、最後にすっと収まる

  function makeScatter(){
    scat=[];
    for(var r=0;r<RINGS.length;r++){
      var a=[];
      for(var k=0;k<N;k++){
        var ang=Math.random()*TAU, rr=R*(1.12+Math.random()*.5);
        a.push({x:cx+Math.cos(ang)*rr,y:cy+Math.sin(ang)*rr,d:Math.random()*.15});
      }
      scat.push(a);
    }
  }
  function build(){
    var r=canvas.getBoundingClientRect();
    W=r.width;H=r.height;
    dpr=Math.min(window.devicePixelRatio||1,1.5);
    canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    isPC=W>=1024;
    cx=W*.5;cy=H*.5;
    R=isPC?Math.min(700,W*.47):W*.5;
    openMax=isPC?Math.max(1,Math.min(OPEN_MAX,(W*.5+100-R*.3)/(R*1.06))):OPEN_MAX;
    makeScatter();
    makeT();
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
  var openRaw=SUB?1:0,openTarget=SUB?1:0;
  function applyScroll(){
    if(SUB||!contents)return;
    var top=contentsTop-window.scrollY;
    openTarget=(top<H*OPEN_TRIGGER)?1:0;
    var hide=top<=copyTop;
    if(hide!==copyHidden){
      copy.classList.toggle('is-hidden',hide);
      ind.classList.toggle('is-hidden',hide);
      copyHidden=hide;
    }
  }

  var t0=performance.now(),last=t0,lastOp='',pause=0,hiddenAt=0,lastCycle=-1;
  function frame(now){
    applyScroll();
    var tg=reduce?0:(now-t0-pause)/1000;
    var dt=Math.min(.05,(now-last)/1000);last=now;
    var step=dt/OPEN_DUR;
    if(openRaw<openTarget)openRaw=Math.min(openTarget,openRaw+step);
    else if(openRaw>openTarget)openRaw=Math.max(openTarget,openRaw-step);
    var oe=easeInOut3(openRaw);
    var scale=isPC?(1+(openMax-1)*oe):OPEN_MAX;
    var op=1+((isPC?OPEN_OPACITY:.2)-1)*oe;
    var ops=op.toFixed(3);
    if(ops!==lastOp){canvas.style.opacity=ops;lastOp=ops;}

    var cyc=Math.floor(tg/CYCLE);
    var lt=reduce?(T1+MORPH*.5):(tg-cyc*CYCLE);
    var inForm=lt<FORM, inDisp=lt>=HOLD_END, inHold=!inForm&&!inDisp;
    var m=0;   // 「T」への変形はオフ   // 円 → 「T」への変形の進み具合
    var dp=inDisp?clamp01((lt-HOLD_END)/DISPERSE):0;
    if(inDisp&&cyc!==lastCycle){makeScatter();lastCycle=cyc;}
    var disperseA=1-easeInOut(dp);
    var lineDp=clamp01(dp*2.2);   // 散る時は線を先に消して、点だけがふわっと散る
    var lineFade=inForm?(.32+.68*clamp01((lt-1.9)/1.1)):inHold?1:(1-easeInOut(lineDp));
    var redMix=clamp01((lt-2.8)/1.1)*(1-clamp01((lt-(HOLD_END-1))/1));

    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    ctx.lineJoin='round';ctx.lineCap='round';
    var Rb=R*scale;

    for(var ri=0;ri<RINGS.length;ri++){
      var g=RINGS[ri],sc=scat[ri];
      var breath=reduce?1:(1+BREATH*Math.sin(tg*BREATH_SPEED*Math.PI+g.pb));
      var rad=Rb*breath*g.rf;
      var ox=g.ax*R*(1+oe*.3)*Math.sin(tg*g.sx*Math.PI+g.px);
      var oy=g.ay*R*(1+oe*.3)*Math.sin(tg*g.sy*Math.PI+g.py);

      for(var i=0;i<N;i++){
        var circX=cx+ox+rad*cosT[i], circY=cy+oy+rad*sinT[i];
        var tx=circX, ty=circY;
        if(ri===2){var tp=TP[2][i];tx=circX+(cx+ox*.4+tp.x*scale-circX)*m;ty=circY+(cy+oy*.4+tp.y*scale-circY)*m;}
        var A=inForm?gatherEase((lt-sc[i].d)/GATHER):inHold?1:disperseA;
        X[i]=sc[i].x+(tx-sc[i].x)*A;
        Y[i]=sc[i].y+(ty-sc[i].y)*A;
      }

      var conn=inForm?easeInOut(clamp01((lt-.5-ri*.12)/1.8)):inHold?1:(1-easeInOut(lineDp));
      var limit=conn*N, start=Math.round(ri/RINGS.length*N);
      var dotsA=inForm?(1-clamp01((lt-1.6)/.6))*.85:clamp01((1-conn)/.6)*.85;
      if(dotsA>.01){
        ctx.fillStyle='rgba('+DOT_RGB+','+dotsA.toFixed(3)+')';
        ctx.beginPath();
        for(var d=0;d<N;d++){ctx.moveTo(X[d]+DOT_R,Y[d]);ctx.arc(X[d],Y[d],DOT_R,0,TAU);}
        ctx.fill();
      }

      var a=LINE_A*lineFade;
      if(g.red){
        var rr=Math.round(SHADE+(RED[0]-SHADE)*redMix),gg=Math.round(SHADE+(RED[1]-SHADE)*redMix),bb=Math.round(SHADE+4+(RED[2]-SHADE-4)*redMix);
        ctx.strokeStyle='rgba('+rr+','+gg+','+bb+','+clamp01(a*(1+.1*redMix)).toFixed(3)+')';
      }else{
        ctx.strokeStyle='rgba('+SHADE+','+SHADE+','+(SHADE+4)+','+clamp01(a).toFixed(3)+')';
      }
      ctx.lineWidth=(ri===2)?LINE_W*(1+.7*m):LINE_W;
      ctx.beginPath();
      for(var s=0;s<N;s++){
        if(((s-start+N)%N)>=limit)continue;
        if(ri===2&&m>.02&&s===tGap)continue;   // 「T」は輪ではないので、最後の点と最初の点はつなげない
        var nx=(s+1)%N;
        ctx.moveTo(X[s],Y[s]);ctx.lineTo(X[nx],Y[nx]);
      }
      ctx.stroke();
    }

    if(reduce&&openRaw===openTarget){running=false;return;}
    requestAnimationFrame(frame);
  }

  var running=false;
  function start(){if(!running){running=true;requestAnimationFrame(frame);}}
  build();measure();applyScroll();start();
  window.addEventListener('load',function(){measure();applyScroll();});
  window.addEventListener('resize',function(){
    var r=canvas.getBoundingClientRect();
    if(r.width===W&&r.height===H)return;
    build();measure();start();
  });
  if(reduce)window.addEventListener('scroll',function(){applyScroll();start();},{passive:true});
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){hiddenAt=performance.now();}
    else{pause+=performance.now()-hiddenAt;last=performance.now();start();}
  });
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
