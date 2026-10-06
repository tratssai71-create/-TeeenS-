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
    {ax:0.42,ratio:.88,rot:.90, spin: .034,k: .00100,sp:-.30,ph:2.6,blue:true, w:1.8,al:.6, n:1},
    {ax:1.40,ratio:.52,rot:-.25,spin:-.006,k: .00020,sp: .07,ph:4.4,blue:false,w:1.0,al:.32,n:1},
    {ax:0.78,ratio:.26,rot:2.7, spin:-.022,k: .00070,sp: .18,ph:1.8,blue:false,w:1.3,al:.48,n:1}
  ];

  var W,H,dpr,cx,cy,R,isPC=true;
  function build(){
    var r=canvas.getBoundingClientRect();
    W=r.width;H=r.height;
    dpr=Math.min(window.devicePixelRatio||1,1.5);
    canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    isPC=W>=1024;
    cx=W*.5;cy=H*.5;
    R=isPC?Math.min(640,W*.44):W*.62;
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
    var op=1-(isPC?.5:.78)*oe;
    var ops=op.toFixed(3);
    if(ops!==lastOp){canvas.style.opacity=ops;lastOp=ops;}

    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    var scale=1+.38*oe;
    var breath=reduce?1:1+.025*Math.sin(t*.5);

    for(var i=0;i<ORBITS.length;i++){
      var o=ORBITS[i];
      var rx=R*o.ax*scale*breath, ry=rx*o.ratio;
      var th=o.rot+t*o.spin+sy*o.k;
      ctx.lineWidth=o.w;
      ctx.strokeStyle=o.blue?'rgba('+BLUE+','+o.al+')':'rgba('+INK+','+o.al+')';
      ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,th,0,TAU);ctx.stroke();

      /* 軌道上を回る点と、その後ろに伸びる光の尾 */
      for(var pk=0;pk<o.n;pk++){
      var a=o.ph+pk*TAU/o.n+t*o.sp*TAU*.35+sy*o.k*3;
      var cs=Math.cos(th),sn=Math.sin(th);
      function pt(ang){var ex=rx*Math.cos(ang),ey=ry*Math.sin(ang);return [cx+ex*cs-ey*sn,cy+ex*sn+ey*cs];}
      var dir=o.sp>=0?1:-1, steps=16;
      for(var s=0;s<steps;s++){
        var a1=a-dir*(s/steps)*1.1, a2=a-dir*((s+1)/steps)*1.1;
        var p1=pt(a1),p2=pt(a2);
        ctx.strokeStyle=(o.blue?'rgba('+BLUE+',':'rgba('+INK+',')+((1-s/steps)*(o.blue?.95:.8)).toFixed(3)+')';
        ctx.lineWidth=o.w+2.2*(1-s/steps);
        ctx.beginPath();ctx.moveTo(p1[0],p1[1]);ctx.lineTo(p2[0],p2[1]);ctx.stroke();
      }
      var p=pt(a);
      ctx.fillStyle=o.blue?'rgb('+BLUE+')':'rgb('+INK+')';
      ctx.beginPath();ctx.arc(p[0],p[1],o.blue?5.5:4,0,TAU);ctx.fill();
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
